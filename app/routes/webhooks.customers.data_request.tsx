import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * GDPR: customers/data_request
 *
 * Shopify sends this when a store customer requests their data. This app stores
 * no customer PII — it only manages variant-level pricing metafields — so there
 * is nothing to compile. We validate the HMAC, log, and 200.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`[gdpr] Received ${topic} for ${shop} — no customer PII stored.`);
  return new Response();
};
