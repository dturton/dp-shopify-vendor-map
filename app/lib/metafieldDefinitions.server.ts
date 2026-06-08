import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import {
  ACTUAL_PRICE_KEY,
  APP_METAFIELD_NAMESPACE,
  MAP_ENABLED_KEY,
} from "./metafields.server";

/**
 * Runtime registration for the app-owned variant metafield *definitions*.
 *
 * IMPORTANT: the `[variant.metafields.app.*]` blocks in shopify.app.toml are NOT
 * applied by `shopify app deploy` — the CLI ignores them. Without a definition the
 * store still holds the metafield *values* (the app writes them via metafieldsSet),
 * but the admin lists them under "Unstructured variant metafields" with no name,
 * type, or merchant access. Creating the definitions here makes them appear
 * structured under Settings → Custom data with merchant_read_write access.
 *
 * `metafieldDefinitionCreate` is idempotent for our purposes: re-creating an
 * existing definition returns a TAKEN userError, which we treat as success.
 */

// `MetafieldOwnerType` value for product variants (note: no underscore).
const OWNER_TYPE = "PRODUCTVARIANT";

/** Access config for a definition. `storefront` is omitted for admin-only fields. */
interface MetafieldAccess {
  admin: "MERCHANT_READ_WRITE" | "MERCHANT_READ" | "PRIVATE";
  storefront?: "PUBLIC_READ" | "NONE";
}

interface DefinitionSpec {
  key: string;
  name: string;
  /** Shopify metafield type name. */
  type: string;
  description: string;
  access: MetafieldAccess;
}

// Mirrors the (deploy-ignored) [variant.metafields.app.*] blocks in
// shopify.app.toml; keep name/type/description in sync with that file.
const DEFINITIONS: DefinitionSpec[] = [
  {
    key: ACTUAL_PRICE_KEY,
    name: "Actual price",
    type: "money",
    description:
      "Charged price after the cart transform (the actual, lower price). variant.price stays the advertised MAP.",
    // Admin-only: the real price must NEVER reach the storefront (MAP compliance).
    access: { admin: "MERCHANT_READ_WRITE" },
  },
  {
    key: MAP_ENABLED_KEY,
    name: "MAP enabled",
    type: "boolean",
    description:
      "Per-variant kill switch. When true (and actual_price < MAP), the cart transform applies the lower price.",
    // Storefront-readable so the theme app extension (map-price-notice) can show
    // the MAP/list-price treatment. Only the boolean flag is exposed, not the price.
    access: { admin: "MERCHANT_READ_WRITE", storefront: "PUBLIC_READ" },
  },
];

/** Keys this app expects to exist as variant metafield definitions. */
export const EXPECTED_DEFINITION_KEYS = DEFINITIONS.map((def) => def.key);

const LIST_DEFINITIONS = `#graphql
  query AppVariantMetafieldDefinitions($namespace: String!) {
    metafieldDefinitions(first: 50, ownerType: PRODUCTVARIANT, namespace: $namespace) {
      nodes {
        key
      }
    }
  }
`;

const CREATE_DEFINITION = `#graphql
  mutation CreateAppMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// Used to upgrade access on a definition that already exists (e.g. granting
// storefront read to the previously admin-only `map_enabled`). Idempotent:
// re-applying the same access is a no-op.
const UPDATE_DEFINITION = `#graphql
  mutation UpdateAppMetafieldDefinition($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition {
        id
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/** Keys (in the `$app` namespace) already registered as variant definitions. */
export async function getRegisteredDefinitionKeys(
  admin: AdminApiContext,
): Promise<string[]> {
  const response = await admin.graphql(LIST_DEFINITIONS, {
    variables: { namespace: APP_METAFIELD_NAMESPACE },
  });
  const body = (await response.json()) as {
    data?: { metafieldDefinitions: { nodes: { key: string }[] } };
  };
  return body.data?.metafieldDefinitions.nodes.map((node) => node.key) ?? [];
}

export interface EnsureMetafieldDefinitionsResult {
  ok: boolean;
  /** Keys newly created on this call. */
  created: string[];
  /** Keys that were already registered (TAKEN). */
  existing: string[];
  /** Keys whose access was upgraded on this call (e.g. storefront read granted). */
  updated: string[];
  /** Human-readable "key: message" errors for keys that failed. */
  errors: string[];
}

interface CreateDefinitionData {
  metafieldDefinitionCreate: {
    createdDefinition: { id: string; key: string } | null;
    userErrors: { field: string[] | null; message: string; code: string | null }[];
  };
}

interface UpdateDefinitionData {
  metafieldDefinitionUpdate: {
    updatedDefinition: { id: string; key: string } | null;
    userErrors: { field: string[] | null; message: string; code: string | null }[];
  };
}

/**
 * Applies a definition's `access` to an already-existing definition (identified by
 * namespace + key + ownerType). Used so the previously admin-only `map_enabled`
 * gains `storefront: PUBLIC_READ`. Returns an error string on failure, else null.
 */
async function applyDefinitionAccess(
  admin: AdminApiContext,
  def: DefinitionSpec,
): Promise<string | null> {
  const response = await admin.graphql(UPDATE_DEFINITION, {
    variables: {
      definition: {
        key: def.key,
        namespace: APP_METAFIELD_NAMESPACE,
        ownerType: OWNER_TYPE,
        access: def.access,
      },
    },
  });
  const body = (await response.json()) as { data?: UpdateDefinitionData };
  const userErrors = body.data?.metafieldDefinitionUpdate?.userErrors ?? [];
  if (userErrors.length === 0) return null;
  return `${def.key}: ${userErrors.map((error) => error.message).join("; ")}`;
}

/**
 * Creates the app-owned variant metafield definitions if missing (idempotent).
 * Safe to call on every auth: an already-registered definition returns a TAKEN
 * userError, counted as `existing` rather than an error.
 */
export async function ensureMetafieldDefinitions(
  admin: AdminApiContext,
): Promise<EnsureMetafieldDefinitionsResult> {
  const created: string[] = [];
  const existing: string[] = [];
  const updated: string[] = [];
  const errors: string[] = [];

  for (const def of DEFINITIONS) {
    const response = await admin.graphql(CREATE_DEFINITION, {
      variables: {
        definition: {
          name: def.name,
          namespace: APP_METAFIELD_NAMESPACE,
          key: def.key,
          description: def.description,
          type: def.type,
          ownerType: OWNER_TYPE,
          access: def.access,
        },
      },
    });
    const body = (await response.json()) as { data?: CreateDefinitionData };
    const result = body.data?.metafieldDefinitionCreate;

    if (result?.createdDefinition) {
      created.push(def.key);
      continue;
    }

    const userErrors = result?.userErrors ?? [];
    if (userErrors.length > 0 && userErrors.every((error) => error.code === "TAKEN")) {
      existing.push(def.key);
      // The definition predates this access config; upgrade it in place so a
      // previously admin-only field (map_enabled) becomes storefront-readable.
      if (def.access.storefront) {
        const updateError = await applyDefinitionAccess(admin, def);
        if (updateError) {
          errors.push(updateError);
        } else {
          updated.push(def.key);
        }
      }
      continue;
    }

    const message =
      userErrors.map((error) => error.message).join("; ") ||
      "Unknown error creating metafield definition.";
    errors.push(`${def.key}: ${message}`);
  }

  return { ok: errors.length === 0, created, existing, updated, errors };
}
