// One-off: register the app-owned variant metafield definitions directly against
// the Admin API, without going through the embedded app UI.
//
// Why this exists: `shopify app deploy` does NOT install the
// [variant.metafields.app.*] blocks from shopify.app.toml, so the definitions must
// be created at runtime. The app already does this in afterAuth and via a Settings
// button (see app/lib/metafieldDefinitions.server.ts); this script is the CLI
// equivalent for ops / one-off use. The DEFINITIONS below mirror that module —
// keep them in sync.
//
// Usage:
//   node --env-file=.env scripts/register-metafield-definitions.mjs [shop-domain]
//   npm run register:metafields -- [shop-domain]
//
// Requires DATABASE_URL (loaded from .env above, or already in the environment)
// pointing at the app's Postgres, which must hold an OFFLINE Session for the shop
// (created when the app was installed/opened). If the shop is omitted and exactly
// one offline session exists, that one is used. Idempotent: an already-registered
// definition comes back as a TAKEN userError and is reported as "already
// registered", not an error.

import { PrismaClient } from "@prisma/client";

const API_VERSION = "2026-01"; // matches ApiVersion.January26 in app/shopify.server.ts
const NAMESPACE = "$app";

// Mirrors DEFINITIONS in app/lib/metafieldDefinitions.server.ts.
const DEFINITIONS = [
  {
    key: "actual_price",
    name: "Actual price",
    type: "money",
    description:
      "Charged price after the cart transform (the actual, lower price). variant.price stays the advertised MAP.",
    // Admin-only: the real price must NEVER reach the storefront (MAP compliance).
    access: { admin: "MERCHANT_READ_WRITE" },
  },
  {
    key: "map_enabled",
    name: "MAP enabled",
    type: "boolean",
    description:
      "Per-variant kill switch. When true (and actual_price < MAP), the cart transform applies the lower price.",
    // Storefront-readable so the map-price-notice theme app extension can detect MAP.
    access: { admin: "MERCHANT_READ_WRITE", storefront: "PUBLIC_READ" },
  },
];

const CREATE_DEFINITION = `
  mutation CreateAppMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id key }
      userErrors { field message code }
    }
  }
`;

// Upgrades access on an already-existing definition (idempotent).
const UPDATE_DEFINITION = `
  mutation UpdateAppMetafieldDefinition($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition { id key }
      userErrors { field message code }
    }
  }
`;

async function graphql(endpoint, accessToken, query, variables) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res;
}

// Applies a definition's access to an already-existing definition. Returns an
// error string on failure, else null.
async function applyAccess(endpoint, accessToken, def) {
  const res = await graphql(endpoint, accessToken, UPDATE_DEFINITION, {
    definition: {
      key: def.key,
      namespace: NAMESPACE,
      ownerType: "PRODUCTVARIANT",
      access: def.access,
    },
  });
  if (!res.ok) return `HTTP ${res.status} ${res.statusText}`;
  const body = await res.json();
  if (body.errors) return JSON.stringify(body.errors);
  const userErrors = body.data?.metafieldDefinitionUpdate?.userErrors ?? [];
  if (userErrors.length > 0) return userErrors.map((e) => e.message).join("; ");
  return null;
}

const prisma = new PrismaClient();

async function resolveSession(shopArg) {
  if (shopArg) {
    const session = await prisma.session.findUnique({
      where: { id: `offline_${shopArg}` },
      select: { shop: true, accessToken: true },
    });
    if (!session) {
      throw new Error(
        `No offline session for ${shopArg} (id offline_${shopArg}). Install/open the app first.`,
      );
    }
    return session;
  }

  const offline = await prisma.session.findMany({
    where: { isOnline: false },
    select: { shop: true, accessToken: true },
  });
  if (offline.length === 0) {
    throw new Error(
      "No offline sessions in the DB. Install/open the app first, or pass a shop domain.",
    );
  }
  if (offline.length > 1) {
    throw new Error(
      `Multiple shops found — pass one explicitly:\n  ${offline.map((s) => s.shop).join("\n  ")}`,
    );
  }
  return offline[0];
}

async function main() {
  const { shop, accessToken } = await resolveSession(process.argv[2]?.trim());
  if (!accessToken) {
    throw new Error(`Offline session for ${shop} has no access token. Reopen the app to refresh it.`);
  }

  console.log(
    `→ Registering ${DEFINITIONS.length} variant metafield definitions on ${shop} (API ${API_VERSION})…`,
  );

  const endpoint = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  let hadError = false;

  for (const def of DEFINITIONS) {
    const res = await graphql(endpoint, accessToken, CREATE_DEFINITION, {
      definition: {
        name: def.name,
        namespace: NAMESPACE,
        key: def.key,
        description: def.description,
        type: def.type,
        ownerType: "PRODUCTVARIANT",
        access: def.access,
      },
    });

    if (res.status === 401) {
      throw new Error(
        `401 Unauthorized for ${shop}. The offline token is invalid/expired — reopen the embedded app once to refresh it, then re-run.`,
      );
    }
    if (!res.ok) {
      hadError = true;
      console.error(`  ✗ ${def.key}: HTTP ${res.status} ${res.statusText}`);
      continue;
    }

    const body = await res.json();
    if (body.errors) {
      hadError = true;
      console.error(`  ✗ ${def.key}: ${JSON.stringify(body.errors)}`);
      continue;
    }

    const result = body.data?.metafieldDefinitionCreate;
    if (result?.createdDefinition) {
      const note = def.access.storefront ? " (storefront-readable)" : "";
      console.log(`  ✓ ${def.key}: registered${note}`);
      continue;
    }

    const userErrors = result?.userErrors ?? [];
    if (userErrors.length > 0 && userErrors.every((e) => e.code === "TAKEN")) {
      // Already exists — ensure access matches (e.g. grant storefront read to a
      // definition that predates this config).
      if (def.access.storefront) {
        const updateError = await applyAccess(endpoint, accessToken, def);
        if (updateError) {
          hadError = true;
          console.error(`  ✗ ${def.key}: ${updateError}`);
        } else {
          console.log(`  • ${def.key}: already registered (access updated)`);
        }
      } else {
        console.log(`  • ${def.key}: already registered`);
      }
      continue;
    }

    hadError = true;
    console.error(
      `  ✗ ${def.key}: ${userErrors.map((e) => e.message).join("; ") || "unknown error"}`,
    );
  }

  if (hadError) throw new Error("One or more definitions failed — see above.");
  console.log("✓ Done. Check Settings → Custom data → Variants in the admin.");
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  console.error(`✗ ${error.message}`);
  exitCode = 1;
} finally {
  await prisma.$disconnect();
}
process.exit(exitCode);
