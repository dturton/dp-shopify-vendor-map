import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { ensureCartTransform } from "./lib/cartTransform.server";
import { ensureMetafieldDefinitions } from "./lib/metafieldDefinitions.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  // Custom app, installed on a single store via a Partners custom-distribution
  // link. Not App Store, no billing API.
  distribution: AppDistribution.SingleMerchant,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    // Best-effort setup on install/re-install. Both steps are idempotent and the
    // Settings page exposes manual fallbacks; never block auth on failure.
    afterAuth: async ({ admin }) => {
      // Register the app-owned variant metafield definitions. `shopify app deploy`
      // does NOT install the shopify.app.toml [variant.metafields.app.*] blocks, so
      // they must be created at runtime or they only ever exist as "unstructured"
      // values. See lib/metafieldDefinitions.server.ts.
      try {
        const defs = await ensureMetafieldDefinitions(admin);
        if (!defs.ok) {
          console.log(`[metafield-defs] not fully registered: ${defs.errors.join("; ")}`);
        }
      } catch (error) {
        console.error("[metafield-defs] registration error", error);
      }

      // Activate the Cart Transform. Idempotent; no-ops if the function isn't
      // deployed yet (the Settings page has a manual "Activate" fallback).
      try {
        const result = await ensureCartTransform(admin);
        if (!result.ok) {
          console.log(`[cart-transform] not activated yet: ${result.message}`);
        }
      } catch (error) {
        console.error("[cart-transform] activation error", error);
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.January26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
