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

// Shared variant node selection. Metafield keys are inlined as string literals
// (must equal ACTUAL_PRICE_KEY / MAP_ENABLED_KEY) and read via jsonValue.
const VARIANT_NODE_FIELDS = `
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
`;

// Bidirectional cursor pagination + optional `query` (vendor/collection search).
const VARIANTS_QUERY = `#graphql
  query VariantsWithMap($first: Int, $after: String, $last: Int, $before: String, $query: String) {
    shop {
      currencyCode
    }
    productVariants(first: $first, after: $after, last: $last, before: $before, query: $query) {
      edges {
        cursor
        node {
          ${VARIANT_NODE_FIELDS}
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

// Forward-only paging for catalog scans (metafield-derived filters).
const SCAN_QUERY = `#graphql
  query ScanVariants($first: Int!, $after: String, $query: String) {
    shop {
      currencyCode
    }
    productVariants(first: $first, after: $after, query: $query) {
      edges {
        cursor
        node {
          ${VARIANT_NODE_FIELDS}
        }
      }
      pageInfo {
        hasNextPage
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

function mapVariantNode(node: VariantNode): VariantRow {
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
}

/** Discount percent of a row's actual_price vs its MAP, or null if not computable. */
export function discountPercent(row: VariantRow): number | null {
  if (row.actualPrice === null) return null;
  const map = Number(row.mapPrice);
  const actual = Number(row.actualPrice);
  if (!Number.isFinite(map) || map <= 0 || !Number.isFinite(actual)) return null;
  return (1 - actual / map) * 100;
}

/**
 * Fetches one page of variants with their MAP pricing metafields in a single
 * GraphQL query (no per-variant fan-out). Supports cursor pagination in both
 * directions. Metafields are null-safe (a variant may never have been configured).
 */
export async function getVariantsPage(
  admin: AdminApiContext,
  options: {
    direction?: PageDirection;
    cursor?: string | null;
    pageSize?: number;
    /** Shopify search syntax, e.g. `vendor:'Hypro' collection:123`. */
    search?: string;
  } = {},
): Promise<VariantsPage> {
  const {
    direction = "next",
    cursor = null,
    pageSize = VARIANTS_PAGE_SIZE,
    search,
  } = options;
  const goingBack = direction === "previous" && cursor !== null;
  const query = search && search.length > 0 ? search : null;

  const variables = goingBack
    ? { first: null, after: null, last: pageSize, before: cursor, query }
    : { first: pageSize, after: cursor, last: null, before: null, query };

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
  const rows = productVariants.edges.map(({ node }) => mapVariantNode(node));

  return { currencyCode: shop.currencyCode, rows, pageInfo: productVariants.pageInfo };
}

// ---------------------------------------------------------------------------
// Catalog scan (for metafield-derived filters Shopify can't search server-side)
// ---------------------------------------------------------------------------

const SCAN_PAGE_SIZE = 250; // productVariants max per page
/** Hard cap on variants fetched during a scan, to bound cost/latency. */
const SCAN_FETCH_CAP = 2000;
/** Cap on filtered rows returned for editing/display. */
const SCAN_DISPLAY_CAP = 250;

export interface VariantFilter {
  /** Only variants with no actual_price metafield. */
  missingActualPrice?: boolean;
  /** Only variants discounted at least this percent off MAP. */
  minDiscountPercent?: number;
}

export interface VariantScan {
  currencyCode: string;
  rows: VariantRow[];
  /** Variants scanned before applying the in-memory filter. */
  scanned: number;
  /** Filtered matches found (may exceed rows.length if display-capped). */
  matched: number;
  /** True if the scan stopped at SCAN_FETCH_CAP before exhausting the catalog. */
  scanCapped: boolean;
  /** True if matches were truncated to SCAN_DISPLAY_CAP. */
  displayCapped: boolean;
}

function passesFilter(row: VariantRow, filter: VariantFilter): boolean {
  if (filter.missingActualPrice && row.actualPrice !== null) return false;
  if (filter.minDiscountPercent && filter.minDiscountPercent > 0) {
    const pct = discountPercent(row);
    if (pct === null || pct < filter.minDiscountPercent) return false;
  }
  return true;
}

interface ScanQueryData {
  shop: { currencyCode: string };
  productVariants: {
    edges: { cursor: string; node: VariantNode }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/**
 * Pages through all variants matching `search` (up to SCAN_FETCH_CAP), applies a
 * metafield-derived `filter` in memory, and returns up to SCAN_DISPLAY_CAP rows.
 * Used only when a metafield filter is active; vendor/collection narrowing keeps
 * the scan small.
 */
export async function scanVariants(
  admin: AdminApiContext,
  filter: VariantFilter,
  search?: string,
): Promise<VariantScan> {
  const query = search && search.length > 0 ? search : null;
  let cursor: string | null = null;
  let currencyCode = "";
  let scanned = 0;
  const matches: VariantRow[] = [];

  for (;;) {
    const response = await admin.graphql(SCAN_QUERY, {
      variables: { first: SCAN_PAGE_SIZE, after: cursor, query },
    });
    const body = (await response.json()) as { data?: ScanQueryData; errors?: unknown };
    if (!body.data) {
      throw new Error(`scan query returned no data: ${JSON.stringify(body.errors)}`);
    }

    currencyCode = body.data.shop.currencyCode;
    const { edges, pageInfo } = body.data.productVariants;
    for (const { node } of edges) {
      scanned += 1;
      const row = mapVariantNode(node);
      if (passesFilter(row, filter)) matches.push(row);
    }

    if (!pageInfo.hasNextPage || scanned >= SCAN_FETCH_CAP) {
      return {
        currencyCode,
        rows: matches.slice(0, SCAN_DISPLAY_CAP),
        scanned,
        matched: matches.length,
        scanCapped: pageInfo.hasNextPage && scanned >= SCAN_FETCH_CAP,
        displayCapped: matches.length > SCAN_DISPLAY_CAP,
      };
    }
    cursor = pageInfo.endCursor;
  }
}

const COLLECTIONS_QUERY = `#graphql
  query FilterCollections($first: Int!) {
    collections(first: $first, sortKey: TITLE) {
      nodes {
        id
        title
      }
    }
  }
`;

/** Collections for the filter dropdown (capped). */
export async function getCollectionsForFilter(
  admin: AdminApiContext,
): Promise<{ id: string; title: string }[]> {
  const response = await admin.graphql(COLLECTIONS_QUERY, {
    variables: { first: 100 },
  });
  const body = (await response.json()) as {
    data?: { collections: { nodes: { id: string; title: string }[] } };
  };
  return body.data?.collections.nodes ?? [];
}

/** Builds a productVariants search string from vendor/collection inputs. */
export function buildVariantSearch(options: {
  vendor?: string | null;
  collectionId?: string | null;
}): string {
  const parts: string[] = [];
  const vendor = options.vendor?.trim();
  if (vendor) {
    parts.push(`vendor:'${vendor.replace(/'/g, "\\'")}'`);
  }
  const collectionId = options.collectionId?.trim();
  if (collectionId) {
    // productVariants search expects the numeric collection id.
    const numeric = collectionId.split("/").pop();
    if (numeric) parts.push(`collection:${numeric}`);
  }
  return parts.join(" ");
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
