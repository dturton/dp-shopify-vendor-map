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
