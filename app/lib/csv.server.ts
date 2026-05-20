import { discountPercent, type VariantRow } from "./metafields.server";

/**
 * CSV helpers for MAP pricing import/export.
 *
 * Export/import use the variant GID as the match key (see app.import.tsx).
 * Columns: variant_id, sku, vendor, map_price, actual_price, discount_percent.
 */
export const CSV_HEADERS = [
  "variant_id",
  "sku",
  "vendor",
  "map_price",
  "actual_price",
  "discount_percent",
] as const;

function escapeField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(escapeField).join(",")).join("\r\n");
}

/** Minimal RFC-4180 parser: handles quoted fields, escaped quotes, CRLF/LF. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop fully-blank rows (e.g. a trailing newline).
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export function buildExportCsv(rows: VariantRow[]): string {
  const data: string[][] = [[...CSV_HEADERS]];
  for (const row of rows) {
    const pct = discountPercent(row);
    data.push([
      row.id,
      row.sku ?? "",
      row.vendor ?? "",
      row.mapPrice,
      row.actualPrice ?? "",
      pct === null ? "" : pct.toFixed(2),
    ]);
  }
  return toCsv(data);
}
