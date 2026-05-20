import type {
  CartTransformRunInput,
  CartTransformRunResult,
  Operation,
} from "../generated/api";

const NO_CHANGES: CartTransformRunResult = {
  operations: [],
};

/** Reads `amount` from a money metafield's jsonValue ({ amount, currency_code }). */
function readMoneyAmount(jsonValue: unknown): number | null {
  if (jsonValue && typeof jsonValue === "object" && "amount" in jsonValue) {
    const amount = (jsonValue as { amount?: unknown }).amount;
    const num = typeof amount === "number" ? amount : Number(amount);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

/**
 * Swaps the advertised MAP for the actual (lower) price once an item is in the
 * cart. For each line, applies a per-unit fixed price of `actual_price` when:
 *   - merchandise is a ProductVariant and not a gift card,
 *   - `map_enabled` is true,
 *   - `actual_price` is set, and
 *   - `actual_price` (converted to presentment currency) is below the current
 *     per-unit price (the advertised MAP).
 * Otherwise it is a no-op for that line.
 *
 * Note: `lineUpdate` (price override) operations require the store to be on
 * Shopify Plus.
 */
export function cartTransformRun(input: CartTransformRunInput): CartTransformRunResult {
  const rate = Number(input.presentmentCurrencyRate);
  const presentmentRate = Number.isFinite(rate) && rate > 0 ? rate : 1;

  const operations: Operation[] = [];

  for (const line of input.cart.lines) {
    const merchandise = line.merchandise;
    if (merchandise.__typename !== "ProductVariant") continue;
    if (merchandise.product.isGiftCard) continue;

    // Per-variant kill switch must be explicitly enabled.
    if (merchandise.mapEnabled?.jsonValue !== true) continue;

    const actualShopAmount = readMoneyAmount(merchandise.actualPrice?.jsonValue);
    if (actualShopAmount === null) continue;

    // cost.amountPerQuantity is the current per-unit MAP in presentment currency;
    // convert the shop-currency actual_price to compare and to emit.
    const currentPerUnit = Number(line.cost.amountPerQuantity.amount);
    const actualPresented = actualShopAmount * presentmentRate;

    // Only ever lower the price.
    if (!Number.isFinite(currentPerUnit) || actualPresented >= currentPerUnit) {
      continue;
    }

    operations.push({
      lineUpdate: {
        cartLineId: line.id,
        price: {
          adjustment: {
            fixedPricePerUnit: { amount: actualPresented.toFixed(2) },
          },
        },
      },
    });
  }

  return operations.length > 0 ? { operations } : NO_CHANGES;
}
