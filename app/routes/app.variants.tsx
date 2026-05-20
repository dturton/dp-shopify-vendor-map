import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, useNavigation } from "@remix-run/react";
import {
  Badge,
  Card,
  EmptyState,
  IndexTable,
  Page,
  Text,
  Thumbnail,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import {
  getVariantsPage,
  VARIANTS_PAGE_SIZE,
  type PageDirection,
} from "../lib/metafields.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");
  const direction: PageDirection = before ? "previous" : "next";
  const cursor = before ?? after ?? null;

  const page = await getVariantsPage(admin, {
    direction,
    cursor,
    pageSize: VARIANTS_PAGE_SIZE,
  });

  return page;
};

function formatMoney(amount: string, currency: string): string {
  const value = Number(amount);
  if (Number.isNaN(value)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    // Unknown currency code — fall back to a plain rendering.
    return `${value.toFixed(2)} ${currency}`;
  }
}

export default function VariantsRoute() {
  const { currencyCode, rows, pageInfo } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  const goNext = () => {
    if (pageInfo.endCursor) {
      navigate(`?after=${encodeURIComponent(pageInfo.endCursor)}`);
    }
  };
  const goPrevious = () => {
    if (pageInfo.startCursor) {
      navigate(`?before=${encodeURIComponent(pageInfo.startCursor)}`);
    }
  };

  const rowMarkup = rows.map((row, index) => (
    <IndexTable.Row id={row.id} key={row.id} position={index}>
      <IndexTable.Cell>
        <Thumbnail
          source={row.imageUrl ?? ImageIcon}
          alt={row.imageAlt}
          size="small"
        />
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          {row.productTitle}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{row.variantTitle}</IndexTable.Cell>
      <IndexTable.Cell>{row.sku ?? "—"}</IndexTable.Cell>
      <IndexTable.Cell>{row.vendor ?? "—"}</IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" numeric alignment="end">
          {formatMoney(row.mapPrice, currencyCode)}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {row.actualPrice ? (
          <Text as="span" numeric alignment="end">
            {formatMoney(row.actualPrice, row.actualPriceCurrency ?? currencyCode)}
          </Text>
        ) : (
          <Text as="span" tone="subdued" alignment="end">
            Not set
          </Text>
        )}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {row.mapEnabled ? (
          <Badge tone="success">Enabled</Badge>
        ) : (
          <Badge>Disabled</Badge>
        )}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page fullWidth>
      <TitleBar title="Variants — MAP pricing" />
      <Card padding="0">
        {rows.length === 0 ? (
          <EmptyState
            heading="No variants found"
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>
              This store has no product variants yet, or none matched. Add
              products in the Shopify admin to manage their MAP pricing here.
            </p>
          </EmptyState>
        ) : (
          <IndexTable
            resourceName={{ singular: "variant", plural: "variants" }}
            itemCount={rows.length}
            selectable={false}
            loading={isLoading}
            headings={[
              { title: "Image" },
              { title: "Product" },
              { title: "Variant" },
              { title: "SKU" },
              { title: "Vendor" },
              { title: "MAP", alignment: "end" },
              { title: "Actual price", alignment: "end" },
              { title: "MAP enabled" },
            ]}
            pagination={{
              hasNext: pageInfo.hasNextPage,
              hasPrevious: pageInfo.hasPreviousPage,
              onNext: goNext,
              onPrevious: goPrevious,
            }}
          >
            {rowMarkup}
          </IndexTable>
        )}
      </Card>
    </Page>
  );
}
