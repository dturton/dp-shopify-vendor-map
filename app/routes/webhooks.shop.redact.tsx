import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * GDPR: shop/redact
 *
 * Shopify sends this ~48h after a shop uninstalls, requesting deletion of the
 * shop's data. Sessions are already removed in webhooks.app.uninstalled; this
 * app holds no other shop-scoped PII in Phase 1. (Phase 2 should also purge any
 * CsvJob rows for the shop here.) We validate the HMAC, log, and 200.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`[gdpr] Received ${topic} for ${shop} — sessions purged on uninstall.`);
  return new Response();
};
