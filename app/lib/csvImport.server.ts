import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import { parseCsv } from "./csv.server";
import { normalizeAmount } from "./metafields.server";

/**
 * CSV import: match key is the variant GID (export column `variant_id`).
 *
 * map_enabled is optional in the file (the export omits it). When the column is
 * absent it's derived: a present actual_price enables MAP, a blank one disables
 * and clears the price. A blank actual_price always means "clear" (delete).
 */

export interface ImportChange {
  variantId: string;
  /** Amount string to set, or null to clear (delete) actual_price. */
  actualPrice: string | null;
  mapEnabled: boolean;
}

export type ImportRowStatus = "update" | "unchanged" | "invalid" | "notfound";

export interface ImportRowPreview {
  rowNumber: number;
  variantId: string;
  status: ImportRowStatus;
  message?: string;
  currentActualPrice: string | null;
  newActualPrice: string | null;
  currentMapEnabled: boolean | null;
  newMapEnabled: boolean;
}

export interface ImportSummary {
  total: number;
  updates: number;
  unchanged: number;
  invalid: number;
  notFound: number;
}

export interface ImportPreview {
  /** Capped for display. */
  previewRows: ImportRowPreview[];
  /** Full set to apply (status === "update"). */
  changes: ImportChange[];
  summary: ImportSummary;
}

/** Cap on preview rows rendered (the full change set is still applied). */
export const IMPORT_PREVIEW_CAP = 200;
/** Above this many changes, the confirm step uses bulkOperationRunMutation. */
export const IMPORT_BULK_THRESHOLD = 200;

const VARIANT_GID_RE = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

interface ParsedRow {
  rowNumber: number;
  variantId: string;
  actualPrice: string | null;
  mapEnabled: boolean;
  valid: boolean;
  message?: string;
}

function parseBoolean(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(value)) return true;
  if (["false", "0", "no", "n", ""].includes(value)) return false;
  return null;
}

function normalizeForCompare(amount: string | null): string | null {
  if (amount === null) return null;
  const trimmed = amount.trim();
  return trimmed === "" ? null : normalizeAmount(trimmed);
}

/** Parses + validates CSV text against the expected header. */
export function parseImportRows(text: string): {
  rows: ParsedRow[];
  headerError: string | null;
} {
  const grid = parseCsv(text);
  if (grid.length === 0) {
    return { rows: [], headerError: "The file is empty." };
  }

  const header = grid[0].map((cell) => cell.trim().toLowerCase());
  const idIndex = header.indexOf("variant_id");
  const priceIndex = header.indexOf("actual_price");
  const enabledIndex = header.indexOf("map_enabled");

  if (idIndex === -1) {
    return { rows: [], headerError: 'Missing required "variant_id" column.' };
  }

  const rows: ParsedRow[] = [];
  for (let i = 1; i < grid.length; i += 1) {
    const cells = grid[i];
    const rowNumber = i + 1; // 1-based, accounting for header
    const variantId = (cells[idIndex] ?? "").trim();

    if (!VARIANT_GID_RE.test(variantId)) {
      rows.push({
        rowNumber,
        variantId,
        actualPrice: null,
        mapEnabled: false,
        valid: false,
        message: variantId
          ? "variant_id is not a valid ProductVariant GID"
          : "missing variant_id",
      });
      continue;
    }

    const rawPrice = (priceIndex === -1 ? "" : cells[priceIndex] ?? "").trim();
    let actualPrice: string | null = null;
    if (rawPrice !== "") {
      const numeric = Number(rawPrice);
      if (!Number.isFinite(numeric) || numeric < 0) {
        rows.push({
          rowNumber,
          variantId,
          actualPrice: null,
          mapEnabled: false,
          valid: false,
          message: `invalid actual_price "${rawPrice}"`,
        });
        continue;
      }
      actualPrice = numeric.toFixed(2);
    }

    // map_enabled: explicit column wins; otherwise derive from price presence.
    let mapEnabled: boolean;
    if (enabledIndex === -1) {
      mapEnabled = actualPrice !== null;
    } else {
      const parsed = parseBoolean(cells[enabledIndex] ?? "");
      if (parsed === null) {
        rows.push({
          rowNumber,
          variantId,
          actualPrice,
          mapEnabled: false,
          valid: false,
          message: `invalid map_enabled "${cells[enabledIndex]}"`,
        });
        continue;
      }
      mapEnabled = parsed;
    }

    rows.push({ rowNumber, variantId, actualPrice, mapEnabled, valid: true });
  }

  return { rows, headerError: null };
}

const CURRENT_VALUES_QUERY = `#graphql
  query ImportCurrentValues($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        actualPrice: metafield(namespace: "$app", key: "actual_price") {
          jsonValue
        }
        mapEnabled: metafield(namespace: "$app", key: "map_enabled") {
          jsonValue
        }
      }
    }
  }
`;

interface CurrentValue {
  actualPrice: string | null;
  mapEnabled: boolean;
}

function readMoney(jsonValue: unknown): string | null {
  if (jsonValue && typeof jsonValue === "object" && "amount" in jsonValue) {
    const amount = (jsonValue as { amount?: unknown }).amount;
    if (typeof amount === "string") return amount;
    if (typeof amount === "number") return String(amount);
  }
  return null;
}

/** Fetches current actual_price/map_enabled for the given variant GIDs (chunked). */
async function fetchCurrentValues(
  admin: AdminApiContext,
  ids: string[],
): Promise<Map<string, CurrentValue>> {
  const result = new Map<string, CurrentValue>();
  for (let i = 0; i < ids.length; i += 250) {
    const batch = ids.slice(i, i + 250);
    const response = await admin.graphql(CURRENT_VALUES_QUERY, {
      variables: { ids: batch },
    });
    const body = (await response.json()) as {
      data?: {
        nodes: Array<{
          id: string;
          actualPrice: { jsonValue: unknown } | null;
          mapEnabled: { jsonValue: unknown } | null;
        } | null>;
      };
    };
    for (const node of body.data?.nodes ?? []) {
      if (!node) continue;
      result.set(node.id, {
        actualPrice: readMoney(node.actualPrice?.jsonValue),
        mapEnabled: node.mapEnabled?.jsonValue === true,
      });
    }
  }
  return result;
}

/** Parses the CSV and diffs it against current values to build a preview. */
export async function buildImportPreview(
  admin: AdminApiContext,
  text: string,
): Promise<{ preview: ImportPreview | null; headerError: string | null }> {
  const { rows, headerError } = parseImportRows(text);
  if (headerError) return { preview: null, headerError };

  const validIds = rows.filter((row) => row.valid).map((row) => row.variantId);
  const current = await fetchCurrentValues(admin, validIds);

  const previewRows: ImportRowPreview[] = [];
  const changes: ImportChange[] = [];
  const summary: ImportSummary = {
    total: rows.length,
    updates: 0,
    unchanged: 0,
    invalid: 0,
    notFound: 0,
  };

  for (const row of rows) {
    if (!row.valid) {
      summary.invalid += 1;
      pushPreview(previewRows, {
        rowNumber: row.rowNumber,
        variantId: row.variantId,
        status: "invalid",
        message: row.message,
        currentActualPrice: null,
        newActualPrice: row.actualPrice,
        currentMapEnabled: null,
        newMapEnabled: row.mapEnabled,
      });
      continue;
    }

    const existing = current.get(row.variantId);
    if (!existing) {
      summary.notFound += 1;
      pushPreview(previewRows, {
        rowNumber: row.rowNumber,
        variantId: row.variantId,
        status: "notfound",
        message: "variant not found in this store",
        currentActualPrice: null,
        newActualPrice: row.actualPrice,
        currentMapEnabled: null,
        newMapEnabled: row.mapEnabled,
      });
      continue;
    }

    const samePrice =
      normalizeForCompare(existing.actualPrice) === normalizeForCompare(row.actualPrice);
    const sameEnabled = existing.mapEnabled === row.mapEnabled;

    if (samePrice && sameEnabled) {
      summary.unchanged += 1;
      pushPreview(previewRows, {
        rowNumber: row.rowNumber,
        variantId: row.variantId,
        status: "unchanged",
        currentActualPrice: existing.actualPrice,
        newActualPrice: row.actualPrice,
        currentMapEnabled: existing.mapEnabled,
        newMapEnabled: row.mapEnabled,
      });
      continue;
    }

    summary.updates += 1;
    changes.push({
      variantId: row.variantId,
      actualPrice: row.actualPrice,
      mapEnabled: row.mapEnabled,
    });
    pushPreview(previewRows, {
      rowNumber: row.rowNumber,
      variantId: row.variantId,
      status: "update",
      currentActualPrice: existing.actualPrice,
      newActualPrice: row.actualPrice,
      currentMapEnabled: existing.mapEnabled,
      newMapEnabled: row.mapEnabled,
    });
  }

  return { preview: { previewRows, changes, summary }, headerError: null };
}

function pushPreview(target: ImportRowPreview[], row: ImportRowPreview): void {
  if (target.length < IMPORT_PREVIEW_CAP) target.push(row);
}
