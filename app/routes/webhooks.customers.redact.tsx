import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * GDPR: customers/redact
 *
 * Shopify sends this to request deletion of a customer's PII. This app stores
 * no customer PII, so there is nothing to redact. We validate the HMAC, log,
 * and 200.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`[gdpr] Received ${topic} for ${shop} — no customer PII stored.`);
  return new Response();
};
