import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  DescriptionList,
  InlineStack,
  Layout,
  Link,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import {
  ACTUAL_PRICE_KEY,
  APP_METAFIELD_NAMESPACE,
  MAP_ENABLED_KEY,
} from "../lib/metafields.server";
import { ensureCartTransform, getCartTransformId } from "../lib/cartTransform.server";
import {
  EXPECTED_DEFINITION_KEYS,
  ensureMetafieldDefinitions,
  getRegisteredDefinitionKeys,
} from "../lib/metafieldDefinitions.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const registeredKeys = await getRegisteredDefinitionKeys(admin);
  return {
    shop: session.shop,
    scope: session.scope ?? "",
    namespace: APP_METAFIELD_NAMESPACE,
    actualPriceKey: ACTUAL_PRICE_KEY,
    mapEnabledKey: MAP_ENABLED_KEY,
    cartTransformActive: (await getCartTransformId(admin)) !== null,
    definitionsRegistered: EXPECTED_DEFINITION_KEYS.every((key) =>
      registeredKeys.includes(key),
    ),
  };
};

interface ActionData {
  ok: boolean;
  message: string;
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionData> => {
  const { admin } = await authenticate.admin(request);
  const intent = (await request.formData()).get("intent");

  if (intent === "register-definitions") {
    const result = await ensureMetafieldDefinitions(admin);
    if (!result.ok) return { ok: false, message: result.errors.join("; ") };
    const parts: string[] = [];
    if (result.created.length) {
      parts.push(`Registered ${result.created.length} definition(s).`);
    }
    if (result.existing.length) {
      parts.push(`${result.existing.length} already registered.`);
    }
    if (result.updated.length) {
      parts.push(`Updated storefront access on ${result.updated.length} definition(s).`);
    }
    return { ok: true, message: parts.join(" ") || "Definitions already registered." };
  }

  const result = await ensureCartTransform(admin);
  return result.ok
    ? { ok: true, message: result.created ? "Cart transform activated." : "Cart transform already active." }
    : { ok: false, message: result.message };
};

export default function SettingsRoute() {
  const {
    shop,
    scope,
    namespace,
    actualPriceKey,
    mapEnabledKey,
    cartTransformActive,
    definitionsRegistered,
  } = useLoaderData<typeof loader>();
  const cartFetcher = useFetcher<ActionData>();
  const defsFetcher = useFetcher<ActionData>();
  const shopify = useAppBridge();

  const isActivating = cartFetcher.state !== "idle";
  const isRegistering = defsFetcher.state !== "idle";

  useEffect(() => {
    if (cartFetcher.state === "idle" && cartFetcher.data?.ok) {
      shopify.toast.show(cartFetcher.data.message);
    }
  }, [cartFetcher.state, cartFetcher.data, shopify]);

  useEffect(() => {
    if (defsFetcher.state === "idle" && defsFetcher.data?.ok) {
      shopify.toast.show(defsFetcher.data.message);
    }
  }, [defsFetcher.state, defsFetcher.data, shopify]);

  return (
    <Page>
      <TitleBar title="Settings" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                App configuration
              </Text>
              <DescriptionList
                items={[
                  { term: "Store", description: shop },
                  { term: "Granted scopes", description: scope || "—" },
                  {
                    term: "Distribution",
                    description: "Custom app (single merchant)",
                  },
                ]}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Cart Transform Function
                </Text>
                {cartTransformActive ? (
                  <Badge tone="success">Active</Badge>
                ) : (
                  <Badge tone="attention">Not active</Badge>
                )}
              </InlineStack>
              <Text as="p" variant="bodyMd" tone="subdued">
                Swaps the advertised MAP for <code>actual_price</code> once items
                are in the cart. Activation is idempotent (one per shop) and runs
                automatically after install; use the button if it isn&apos;t
                active yet. The function must be deployed (<code>shopify app
                deploy</code>) first. Price overrides require a Shopify Plus plan.
              </Text>
              <InlineStack gap="200">
                <Button
                  loading={isActivating}
                  disabled={cartTransformActive || isActivating}
                  onClick={() =>
                    cartFetcher.submit(
                      { intent: "activate-cart-transform" },
                      { method: "post" },
                    )
                  }
                >
                  {cartTransformActive ? "Active" : "Activate cart transform"}
                </Button>
              </InlineStack>
              {cartFetcher.data && !cartFetcher.data.ok && (
                <Text as="p" variant="bodySm" tone="critical">
                  {cartFetcher.data.message}
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Metafield definitions
                </Text>
                {definitionsRegistered ? (
                  <Badge tone="success">Registered</Badge>
                ) : (
                  <Badge tone="attention">Not registered</Badge>
                )}
              </InlineStack>
              <Text as="p" variant="bodyMd" tone="subdued">
                App-owned variant metafields in the reserved{" "}
                <code>{namespace}</code> namespace. These definitions are created by
                the app (<code>shopify app deploy</code> does not install them), and
                run automatically after install. Until registered, the admin shows
                the values as &ldquo;unstructured&rdquo;; registering them adds the
                names, types, and merchant read/write access. Use the button if the
                status above isn&apos;t <em>Registered</em>.
              </Text>
              <DescriptionList
                items={[
                  {
                    term: `${namespace}.${actualPriceKey}`,
                    description: "money — the charged (actual) price",
                  },
                  {
                    term: `${namespace}.${mapEnabledKey}`,
                    description: "boolean — per-variant kill switch",
                  },
                ]}
              />
              <InlineStack gap="200">
                <Button
                  loading={isRegistering}
                  disabled={isRegistering}
                  onClick={() =>
                    defsFetcher.submit(
                      { intent: "register-definitions" },
                      { method: "post" },
                    )
                  }
                >
                  {definitionsRegistered
                    ? "Re-register definitions"
                    : "Register definitions"}
                </Button>
              </InlineStack>
              {defsFetcher.data && !defsFetcher.data.ok && (
                <Text as="p" variant="bodySm" tone="critical">
                  {defsFetcher.data.message}
                </Text>
              )}
              <Text as="p" variant="bodySm" tone="subdued">
                Definitions also appear under{" "}
                <Link url="shopify:admin/settings/custom_data/variant">
                  Settings → Custom data → Variants
                </Link>{" "}
                in the Shopify admin.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
