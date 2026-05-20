import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  BlockStack,
  Card,
  DescriptionList,
  Layout,
  Link,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import {
  ACTUAL_PRICE_KEY,
  APP_METAFIELD_NAMESPACE,
  MAP_ENABLED_KEY,
} from "../lib/metafields.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return {
    shop: session.shop,
    scope: session.scope ?? "",
    namespace: APP_METAFIELD_NAMESPACE,
    actualPriceKey: ACTUAL_PRICE_KEY,
    mapEnabledKey: MAP_ENABLED_KEY,
  };
};

export default function SettingsRoute() {
  const { shop, scope, namespace, actualPriceKey, mapEnabledKey } =
    useLoaderData<typeof loader>();

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
