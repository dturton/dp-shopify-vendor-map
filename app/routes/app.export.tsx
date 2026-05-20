import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import {
  buildVariantSearch,
  getCollectionsForFilter,
  getVariantsForExport,
} from "../lib/metafields.server";
import { buildExportCsv } from "../lib/csv.server";

// Mirrors CSV_HEADERS in csv.server (kept here so the client bundle never
// imports the server-only csv module).
const EXPORT_COLUMNS =
  "variant_id, sku, vendor, map_price, actual_price, discount_percent";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  return { collections: await getCollectionsForFilter(admin) };
};

interface ExportData {
  csv: string;
  filename: string;
  rowCount: number;
  capped: boolean;
  token: string;
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ExportData> => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();

  const vendor = String(form.get("vendor") ?? "").trim();
  const collectionId = String(form.get("collection") ?? "").trim();
  const missing = form.get("missing") === "1";
  const minDiscount = Number(form.get("minDiscount") ?? "0") || 0;

  const search = buildVariantSearch({ vendor, collectionId });
  const { rows, capped } = await getVariantsForExport(admin, {
    search,
    filter: { missingActualPrice: missing, minDiscountPercent: minDiscount },
  });

  const date = new Date().toISOString().slice(0, 10);
  return {
    csv: buildExportCsv(rows),
    filename: `vendor-map-${date}.csv`,
    rowCount: rows.length,
    capped,
    token: Date.now().toString(),
  };
};

export default function ExportRoute() {
  const { collections } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ExportData>();
  const shopify = useAppBridge();

  const [vendor, setVendor] = useState("");
  const [collection, setCollection] = useState("");
  const [missing, setMissing] = useState(false);
  const [minDiscount, setMinDiscount] = useState("");

  const lastToken = useRef<string | null>(null);
  const isExporting = fetcher.state !== "idle";

  // Trigger a client-side download when the CSV comes back (avoids iframe
  // navigation issues in the embedded admin).
  useEffect(() => {
    const data = fetcher.data;
    if (fetcher.state !== "idle" || !data || data.token === lastToken.current) {
      return;
    }
    lastToken.current = data.token;

    const blob = new Blob([data.csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = data.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    shopify.toast.show(`Exported ${data.rowCount} variant${data.rowCount === 1 ? "" : "s"}`);
  }, [fetcher.state, fetcher.data, shopify]);

  const collectionOptions = [
    { label: "All collections", value: "" },
    ...collections.map((c) => ({ label: c.title, value: c.id })),
  ];

  const exportCsv = () => {
    const payload: Record<string, string> = {};
    if (vendor.trim()) payload.vendor = vendor.trim();
    if (collection) payload.collection = collection;
    if (missing) payload.missing = "1";
    if (minDiscount.trim() && Number(minDiscount) > 0) {
      payload.minDiscount = minDiscount.trim();
    }
    fetcher.submit(payload, { method: "post" });
  };

  return (
    <Page>
      <TitleBar title="Export CSV" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Export variant pricing
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Downloads a CSV with columns: {EXPORT_COLUMNS}. Leave filters
                  empty to export the whole catalog.
                </Text>
              </BlockStack>

              <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                <TextField
                  label="Vendor"
                  value={vendor}
                  onChange={setVendor}
                  autoComplete="off"
                  placeholder="All vendors"
                />
                <Select
                  label="Collection"
                  options={collectionOptions}
                  value={collection}
                  onChange={setCollection}
                />
                <TextField
                  label="Min discount %"
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  suffix="%"
                  value={minDiscount}
                  onChange={setMinDiscount}
                  autoComplete="off"
                  placeholder="Any"
                />
              </InlineGrid>

              <InlineStack gap="400" blockAlign="center">
                <Checkbox
                  label="Missing actual price only"
                  checked={missing}
                  onChange={setMissing}
                />
                <Button variant="primary" loading={isExporting} onClick={exportCsv}>
                  Export CSV
                </Button>
              </InlineStack>

              {fetcher.data?.capped && (
                <Banner tone="warning">
                  <Text as="p" variant="bodyMd">
                    The catalog exceeded the export cap; the file may be
                    incomplete. Narrow by vendor or collection to export the rest.
                  </Text>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
