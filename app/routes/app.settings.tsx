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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  return {
    shop: session.shop,
    scope: session.scope ?? "",
    namespace: APP_METAFIELD_NAMESPACE,
    actualPriceKey: ACTUAL_PRICE_KEY,
    mapEnabledKey: MAP_ENABLED_KEY,
    cartTransformActive: (await getCartTransformId(admin)) !== null,
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
  const result = await ensureCartTransform(admin);
  return result.ok
    ? { ok: true, message: result.created ? "Cart transform activated." : "Cart transform already active." }
    : { ok: false, message: result.message };
};

export default function SettingsRoute() {
  const { shop, scope, namespace, actualPriceKey, mapEnabledKey, cartTransformActive } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const shopify = useAppBridge();

  const isActivating = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      shopify.toast.show(fetcher.data.message);
    }
  }, [fetcher.state, fetcher.data, shopify]);

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
                  onClick={() => fetcher.submit({}, { method: "post" })}
                >
                  {cartTransformActive ? "Active" : "Activate cart transform"}
                </Button>
              </InlineStack>
              {fetcher.data && !fetcher.data.ok && (
                <Text as="p" variant="bodySm" tone="critical">
                  {fetcher.data.message}
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Metafield definitions
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                App-owned variant metafields in the reserved{" "}
                <code>{namespace}</code> namespace. Manage values per variant; the
                schema is declared in <code>shopify.app.toml</code> and is
                read-only in the admin.
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
