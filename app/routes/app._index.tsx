import type { LoaderFunctionArgs } from "@remix-run/node";
import { Link as RemixLink } from "@remix-run/react";
import {
  BlockStack,
  Button,
  Card,
  InlineGrid,
  Layout,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  return (
    <Page>
      <TitleBar title="Sprayer Depot — Vendor MAP Pricing" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Manage Minimum Advertised Price (MAP) compliance
              </Text>
              <Text as="p" variant="bodyMd">
                Each variant&apos;s catalog price is the advertised{" "}
                <strong>MAP</strong>. This app stores a separate{" "}
                <strong>actual price</strong> per variant; a Cart Transform
                Function (Phase 3) swaps in the lower actual price once an item
                is added to the cart, so the storefront keeps showing the MAP.
              </Text>
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                <Button url="/app/variants" variant="primary">
                  View variants
                </Button>
                <Button url="/app/settings">Settings</Button>
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                How pricing is modeled
              </Text>
              <List>
                <List.Item>
                  <code>variant.price</code> = advertised MAP (unchanged).
                </List.Item>
                <List.Item>
                  <code>actual_price</code> metafield = charged price.
                </List.Item>
                <List.Item>
                  <code>map_enabled</code> metafield = per-variant kill switch.
                </List.Item>
                <List.Item>
                  Strikethrough is theme-side; <code>compareAtPrice</code> is
                  never touched.
                </List.Item>
              </List>
              <Text as="p" variant="bodySm" tone="subdued">
                Phase 1 is read-only.{" "}
                <RemixLink to="/app/variants">Browse variants →</RemixLink>
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
