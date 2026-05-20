import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

/**
 * App-owned (reserved) metafield namespace + keys.
 *
 * `$app` resolves to `app--{id}` at runtime and is what grants the Cart
 * Transform Function (Phase 3) implicit read access. These constants MUST match
 * the declarative definitions in shopify.app.toml ([variant.metafields.app.*]).
 *
 * Note: `variant.price` IS the advertised MAP — there is no `map_price`
 * metafield. `actual_price` is a `money` metafield (its value is JSON:
 * `{ amount, currency_code }`); `map_enabled` is a `boolean` metafield.
 */
export const APP_METAFIELD_NAMESPACE = "$app";
export const ACTUAL_PRICE_KEY = "actual_price";
export const MAP_ENABLED_KEY = "map_enabled";

export const VARIANTS_PAGE_SIZE = 50;

export type PageDirection = "next" | "previous";

export interface VariantRow {
  /** ProductVariant GID. */
  id: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  vendor: string | null;
  imageUrl: string | null;
  imageAlt: string;
  /** Advertised MAP — the raw amount string from variant.price (e.g. "129.99"). */
  mapPrice: string;
  /** Charged price from the actual_price money metafield, or null if unset. */
  actualPrice: string | null;
  /** Currency of actual_price; falls back to shop currency when unset. */
  actualPriceCurrency: string | null;
  mapEnabled: boolean;
}

export interface VariantsPage {
  currencyCode: string;
  rows: VariantRow[];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
}

// Keys below must equal ACTUAL_PRICE_KEY / MAP_ENABLED_KEY. They are inlined as
// string literals so the document stays statically analyzable by graphql-codegen.
const VARIANTS_QUERY = `#graphql
  query VariantsWithMap($first: Int, $after: String, $last: Int, $before: String) {
    shop {
      currencyCode
    }
    productVariants(first: $first, after: $after, last: $last, before: $before) {
      edges {
        cursor
        node {
          id
          title
          sku
          price
          image {
            url
            altText
          }
          product {
            title
            vendor
            featuredImage {
              url
              altText
            }
          }
          actualPrice: metafield(namespace: "$app", key: "actual_price") {
            jsonValue
          }
          mapEnabled: metafield(namespace: "$app", key: "map_enabled") {
            jsonValue
          }
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

interface ImageNode {
  url: string;
  altText: string | null;
}

interface MetafieldNode {
  jsonValue: unknown;
}

interface VariantNode {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  image: ImageNode | null;
  product: {
    title: string;
    vendor: string | null;
    featuredImage: ImageNode | null;
  };
  actualPrice: MetafieldNode | null;
  mapEnabled: MetafieldNode | null;
}

interface VariantsQueryData {
  shop: { currencyCode: string };
  productVariants: {
    edges: { cursor: string; node: VariantNode }[];
    pageInfo: VariantsPage["pageInfo"];
  };
}

/** Pulls `amount` out of a `money` metafield's parsed jsonValue, defensively. */
function moneyAmount(jsonValue: unknown): { amount: string; currency: string | null } | null {
  if (jsonValue && typeof jsonValue === "object" && "amount" in jsonValue) {
    const obj = jsonValue as { amount?: unknown; currency_code?: unknown };
    const amount =
      typeof obj.amount === "string"
        ? obj.amount
        : typeof obj.amount === "number"
          ? String(obj.amount)
          : null;
    if (amount === null) return null;
    return {
      amount,
      currency: typeof obj.currency_code === "string" ? obj.currency_code : null,
    };
  }
  return null;
}

/** A `boolean` metafield's jsonValue is a real boolean; tolerate the string form too. */
function asBoolean(jsonValue: unknown): boolean {
  return jsonValue === true || jsonValue === "true";
}

function emptyToNull(value: string | null): string | null {
  return value && value.trim().length > 0 ? value : null;
}

/**
 * Fetches one page of variants with their MAP pricing metafields in a single
 * GraphQL query (no per-variant fan-out). Supports cursor pagination in both
 * directions. Metafields are null-safe (a variant may never have been configured).
 */
export async function getVariantsPage(
  admin: AdminApiContext,
  options: { direction?: PageDirection; cursor?: string | null; pageSize?: number } = {},
): Promise<VariantsPage> {
  const { direction = "next", cursor = null, pageSize = VARIANTS_PAGE_SIZE } = options;
  const goingBack = direction === "previous" && cursor !== null;

  const variables = goingBack
    ? { first: null, after: null, last: pageSize, before: cursor }
    : { first: pageSize, after: cursor, last: null, before: null };

  const response = await admin.graphql(VARIANTS_QUERY, { variables });
  const body = (await response.json()) as {
    data?: VariantsQueryData;
    errors?: unknown;
  };

  if (!body.data) {
    throw new Error(
      `productVariants query returned no data: ${JSON.stringify(body.errors)}`,
    );
  }

  const { shop, productVariants } = body.data;

  const rows: VariantRow[] = productVariants.edges.map(({ node }) => {
    const actual = moneyAmount(node.actualPrice?.jsonValue);
    return {
      id: node.id,
      productTitle: node.product.title,
      variantTitle: node.title,
      sku: emptyToNull(node.sku),
      vendor: emptyToNull(node.product.vendor),
      imageUrl: node.image?.url ?? node.product.featuredImage?.url ?? null,
      imageAlt:
        node.image?.altText ??
        node.product.featuredImage?.altText ??
        node.product.title,
      mapPrice: node.price,
      actualPrice: actual?.amount ?? null,
      actualPriceCurrency: actual?.currency ?? null,
      mapEnabled: asBoolean(node.mapEnabled?.jsonValue),
    };
  });

  return { currencyCode: shop.currencyCode, rows, pageInfo: productVariants.pageInfo };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Both metafieldsSet and metafieldsDelete cap at 25 entries per call. */
const METAFIELDS_BATCH_MAX = 25;

export interface VariantPricingInput {
  variantId: string;
  /** Amount string ("12.99") to set, or null/"" to clear (delete the metafield). */
  actualPrice: string | null;
  mapEnabled: boolean;
}

export interface SaveUserError {
  field: string[] | null;
  message: string;
}

export interface SaveResult {
  /** Number of variants whose changes were submitted. */
  variantsSaved: number;
  userErrors: SaveUserError[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Coerce a user-entered amount to a 2-decimal string; leave unparseable input as-is. */
export function normalizeAmount(raw: string): string {
  const value = Number(raw);
  return Number.isFinite(value) ? value.toFixed(2) : raw.trim();
}

const SHOP_CURRENCY_QUERY = `#graphql
  query ShopCurrency {
    shop {
      currencyCode
    }
  }
`;

export async function getShopCurrency(admin: AdminApiContext): Promise<string> {
  const response = await admin.graphql(SHOP_CURRENCY_QUERY);
  const body = (await response.json()) as {
    data?: { shop: { currencyCode: string } };
  };
  if (!body.data) throw new Error("Unable to read shop currency");
  return body.data.shop.currencyCode;
}

const SET_METAFIELDS_MUTATION = `#graphql
  mutation SetVariantMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors {
        field
        message
      }
    }
  }
`;

const DELETE_METAFIELDS_MUTATION = `#graphql
  mutation DeleteVariantMetafields($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields {
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface MetafieldSetEntry {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

interface MetafieldDeleteEntry {
  ownerId: string;
  namespace: string;
  key: string;
}

/**
 * Persists per-variant MAP pricing. `map_enabled` is always written for each
 * input; `actual_price` (a money metafield, currency must match the shop) is set
 * when an amount is given, or deleted when blank/null. Writes are chunked to the
 * 25-per-call cap. compareAtPrice is never touched.
 */
export async function saveVariantPricing(
  admin: AdminApiContext,
  inputs: VariantPricingInput[],
  currencyCode: string,
): Promise<SaveResult> {
  const setEntries: MetafieldSetEntry[] = [];
  const deleteEntries: MetafieldDeleteEntry[] = [];

  for (const input of inputs) {
    setEntries.push({
      ownerId: input.variantId,
      namespace: APP_METAFIELD_NAMESPACE,
      key: MAP_ENABLED_KEY,
      type: "boolean",
      value: input.mapEnabled ? "true" : "false",
    });

    const hasAmount =
      input.actualPrice !== null && input.actualPrice.trim() !== "";

    if (hasAmount) {
      setEntries.push({
        ownerId: input.variantId,
        namespace: APP_METAFIELD_NAMESPACE,
        key: ACTUAL_PRICE_KEY,
        type: "money",
        value: JSON.stringify({
          amount: normalizeAmount(input.actualPrice as string),
          currency_code: currencyCode,
        }),
      });
    } else {
      deleteEntries.push({
        ownerId: input.variantId,
        namespace: APP_METAFIELD_NAMESPACE,
        key: ACTUAL_PRICE_KEY,
      });
    }
  }

  const userErrors: SaveUserError[] = [];

  for (const batch of chunk(setEntries, METAFIELDS_BATCH_MAX)) {
    const response = await admin.graphql(SET_METAFIELDS_MUTATION, {
      variables: { metafields: batch },
    });
    const body = (await response.json()) as {
      data?: { metafieldsSet: { userErrors: SaveUserError[] } };
    };
    userErrors.push(...(body.data?.metafieldsSet.userErrors ?? []));
  }

  // Deleting a non-existent metafield is a no-op (no userError), so it is safe
  // to delete actual_price for variants that never had one.
  for (const batch of chunk(deleteEntries, METAFIELDS_BATCH_MAX)) {
    const response = await admin.graphql(DELETE_METAFIELDS_MUTATION, {
      variables: { metafields: batch },
    });
    const body = (await response.json()) as {
      data?: { metafieldsDelete: { userErrors: SaveUserError[] } };
    };
    userErrors.push(...(body.data?.metafieldsDelete.userErrors ?? []));
  }

  return { variantsSaved: inputs.length, userErrors };
}
