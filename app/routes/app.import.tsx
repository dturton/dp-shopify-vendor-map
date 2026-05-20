import { useCallback, useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Prisma } from "@prisma/client";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  DropZone,
  IndexTable,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getShopCurrency, saveVariantPricing, type SaveUserError } from "../lib/metafields.server";
import {
  buildImportPreview,
  IMPORT_BULK_THRESHOLD,
  type ImportChange,
  type ImportRowPreview,
  type ImportSummary,
} from "../lib/csvImport.server";
import { pollBulkOperation, startBulkImport } from "../lib/bulkImport.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const jobs = await db.csvJob.findMany({
    where: { shopDomain: session.shop },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  return {
    jobs: jobs.map((job) => ({
      id: job.id,
      status: job.status,
      successCount: job.successCount,
      errorCount: job.errorCount,
      createdAt: job.createdAt.toISOString(),
    })),
  };
};

type ActionData =
  | { step: "error"; message: string }
  | {
      step: "preview";
      jobId: string;
      previewRows: ImportRowPreview[];
      summary: ImportSummary;
      previewCapped: boolean;
    }
  | { step: "running"; jobId: string; total: number }
  | { step: "status"; running: boolean; statusLabel: string }
  | { step: "done"; applied: number; userErrors: SaveUserError[] };

interface StoredPayload {
  changes: ImportChange[];
  summary: ImportSummary;
  userErrors?: SaveUserError[];
  bulkOperationId?: string;
  total?: number;
}

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "preview") {
    const csv = String(form.get("csv") ?? "");
    if (csv.trim() === "") {
      return { step: "error", message: "The file is empty." };
    }
    const { preview, headerError } = await buildImportPreview(admin, csv);
    if (headerError || !preview) {
      return { step: "error", message: headerError ?? "Could not parse the file." };
    }
    const job = await db.csvJob.create({
      data: {
        shopDomain: session.shop,
        status: "PENDING",
        payload: {
          changes: preview.changes,
          summary: preview.summary,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return {
      step: "preview",
      jobId: job.id,
      previewRows: preview.previewRows,
      summary: preview.summary,
      previewCapped: preview.summary.total > preview.previewRows.length,
    };
  }

  if (intent === "cancel") {
    const jobId = String(form.get("jobId") ?? "");
    if (jobId) {
      await db.csvJob.deleteMany({
        where: { id: jobId, shopDomain: session.shop, status: "PENDING" },
      });
    }
    return { step: "error", message: "" };
  }

  if (intent === "confirm") {
    const jobId = String(form.get("jobId") ?? "");
    const job = await db.csvJob.findFirst({
      where: { id: jobId, shopDomain: session.shop },
    });
    if (!job || job.status !== "PENDING") {
      return { step: "error", message: "Import job not found or already processed." };
    }

    const payload = job.payload as unknown as StoredPayload;
    const changes = payload.changes ?? [];
    await db.csvJob.update({ where: { id: job.id }, data: { status: "PROCESSING" } });

    try {
      const currencyCode = await getShopCurrency(admin);

      // Large imports use bulkOperationRunMutation for the price writes; clears
      // (delete actual_price) always go through the synchronous path.
      if (changes.length > IMPORT_BULK_THRESHOLD) {
        const sets = changes.filter((change) => change.actualPrice !== null);
        const clears = changes.filter((change) => change.actualPrice === null);
        if (clears.length > 0) {
          await saveVariantPricing(admin, clears, currencyCode);
        }
        const bulkOperationId = await startBulkImport(admin, sets, currencyCode);
        await db.csvJob.update({
          where: { id: job.id },
          data: {
            payload: {
              ...payload,
              bulkOperationId,
              total: changes.length,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        return { step: "running", jobId: job.id, total: changes.length };
      }

      const result = await saveVariantPricing(admin, changes, currencyCode);
      const errorCount = result.userErrors.length;
      await db.csvJob.update({
        where: { id: job.id },
        data: {
          status: errorCount > 0 ? "FAILED" : "COMPLETED",
          successCount: Math.max(0, changes.length - errorCount),
          errorCount,
          completedAt: new Date(),
          payload: {
            ...payload,
            userErrors: result.userErrors,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return { step: "done", applied: changes.length, userErrors: result.userErrors };
    } catch (error) {
      await db.csvJob.update({
        where: { id: job.id },
        data: { status: "FAILED", errorCount: changes.length, completedAt: new Date() },
      });
      return {
        step: "error",
        message: error instanceof Error ? error.message : "Import failed.",
      };
    }
  }

  if (intent === "poll") {
    const jobId = String(form.get("jobId") ?? "");
    const job = await db.csvJob.findFirst({
      where: { id: jobId, shopDomain: session.shop },
    });
    if (!job) return { step: "error", message: "Import job not found." };

    const payload = job.payload as unknown as StoredPayload;
    if (!payload.bulkOperationId) {
      return { step: "status", running: false, statusLabel: job.status };
    }

    const status = await pollBulkOperation(admin, payload.bulkOperationId);
    const label = status?.status ?? "UNKNOWN";

    if (label === "COMPLETED") {
      await db.csvJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          successCount: payload.total ?? 0,
          completedAt: new Date(),
        },
      });
      return { step: "status", running: false, statusLabel: "COMPLETED" };
    }
    if (label === "FAILED" || label === "CANCELED") {
      await db.csvJob.update({
        where: { id: job.id },
        data: { status: "FAILED", completedAt: new Date() },
      });
      return { step: "status", running: false, statusLabel: label };
    }
    return { step: "status", running: true, statusLabel: label };
  }

  return { step: "error", message: "Unknown action." };
};

function statusBadge(status: ImportRowPreview["status"]) {
  switch (status) {
    case "update":
      return <Badge tone="info">Update</Badge>;
    case "unchanged":
      return <Badge>Unchanged</Badge>;
    case "notfound":
      return <Badge tone="warning">Not found</Badge>;
    case "invalid":
      return <Badge tone="critical">Invalid</Badge>;
  }
}

function jobBadge(status: string) {
  const tone =
    status === "COMPLETED"
      ? "success"
      : status === "FAILED"
        ? "critical"
        : status === "PROCESSING"
          ? "attention"
          : undefined;
  return <Badge tone={tone}>{status}</Badge>;
}

export default function ImportRoute() {
  const { jobs } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const shopify = useAppBridge();

  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState("");
  const [runningJobId, setRunningJobId] = useState<string | null>(null);

  const data = fetcher.data;
  const isBusy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    if (data?.step === "done") {
      shopify.toast.show(`Imported ${data.applied} variant${data.applied === 1 ? "" : "s"}`);
    } else if (data?.step === "running") {
      setRunningJobId(data.jobId);
    } else if (data?.step === "status" && !data.running) {
      setRunningJobId(null);
      shopify.toast.show(`Bulk import ${data.statusLabel.toLowerCase()}`);
    }
  }, [fetcher.state, data, shopify]);

  const handleDrop = useCallback((_files: File[], accepted: File[]) => {
    const file = accepted[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () =>
      setCsvText(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  }, []);

  const runPreview = () =>
    fetcher.submit({ intent: "preview", csv: csvText }, { method: "post" });

  const inPreview = data?.step === "preview";

  return (
    <Page>
      <TitleBar title="Import CSV" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Import variant pricing
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Upload a CSV with a <code>variant_id</code> column (the GID from
                  export) plus <code>actual_price</code>. A blank actual_price
                  clears it. <code>map_enabled</code> is optional — if omitted, a
                  price enables MAP and a blank disables it. You&apos;ll preview
                  changes before anything is written.
                </Text>
              </BlockStack>

              <DropZone
                accept=".csv,text/csv"
                type="file"
                allowMultiple={false}
                onDrop={handleDrop}
              >
                {fileName ? (
                  <BlockStack gap="100" inlineAlign="center">
                    <Text as="p" variant="bodyMd">
                      {fileName}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Drop a different file to replace
                    </Text>
                  </BlockStack>
                ) : (
                  <DropZone.FileUpload actionTitle="Add CSV" />
                )}
              </DropZone>

              <InlineStack gap="200">
                <Button
                  variant="primary"
                  onClick={runPreview}
                  loading={isBusy && !inPreview}
                  disabled={csvText.trim() === "" || isBusy}
                >
                  Preview changes
                </Button>
              </InlineStack>

              {data?.step === "error" && data.message && (
                <Banner tone="critical">
                  <Text as="p" variant="bodyMd">
                    {data.message}
                  </Text>
                </Banner>
              )}

              {data?.step === "done" && (
                <Banner tone={data.userErrors.length ? "warning" : "success"}>
                  <BlockStack gap="100">
                    <Text as="p" variant="bodyMd">
                      Applied {data.applied} change
                      {data.applied === 1 ? "" : "s"}.
                    </Text>
                    {data.userErrors.map((error, i) => (
                      <Text as="p" key={i} variant="bodySm">
                        {error.message}
                      </Text>
                    ))}
                  </BlockStack>
                </Banner>
              )}

              {runningJobId && (
                <Banner tone="info">
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">
                      Bulk import is running in the background
                      {data?.step === "status" ? ` (status: ${data.statusLabel})` : ""}.
                      Large imports may take a few minutes.
                    </Text>
                    <InlineStack>
                      <Button
                        loading={isBusy}
                        onClick={() =>
                          fetcher.submit(
                            { intent: "poll", jobId: runningJobId },
                            { method: "post" },
                          )
                        }
                      >
                        Check status
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </Banner>
              )}

              {data?.step === "status" && !data.running && (
                <Banner tone={data.statusLabel === "COMPLETED" ? "success" : "critical"}>
                  <Text as="p" variant="bodyMd">
                    Bulk import {data.statusLabel.toLowerCase()}.
                  </Text>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {inPreview && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Preview
                </Text>
                <Text as="p" variant="bodyMd">
                  {data.summary.updates} to update · {data.summary.unchanged}{" "}
                  unchanged · {data.summary.notFound} not found ·{" "}
                  {data.summary.invalid} invalid (of {data.summary.total} rows)
                  {data.previewCapped
                    ? ` — showing the first ${data.previewRows.length}`
                    : ""}
                  .
                </Text>

                <IndexTable
                  resourceName={{ singular: "row", plural: "rows" }}
                  itemCount={data.previewRows.length}
                  selectable={false}
                  headings={[
                    { title: "Row" },
                    { title: "Variant" },
                    { title: "Status" },
                    { title: "Actual price" },
                    { title: "MAP enabled" },
                  ]}
                >
                  {data.previewRows.map((row, index) => (
                    <IndexTable.Row id={`${row.rowNumber}`} key={row.rowNumber} position={index}>
                      <IndexTable.Cell>{row.rowNumber}</IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodySm">
                          {row.variantId.replace("gid://shopify/ProductVariant/", "#")}
                        </Text>
                        {row.message ? (
                          <Text as="span" tone="subdued" variant="bodySm">
                            {" "}
                            — {row.message}
                          </Text>
                        ) : null}
                      </IndexTable.Cell>
                      <IndexTable.Cell>{statusBadge(row.status)}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {(row.currentActualPrice ?? "—") + " → " + (row.newActualPrice ?? "—")}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {(row.currentMapEnabled === null
                          ? "—"
                          : row.currentMapEnabled
                            ? "On"
                            : "Off") +
                          " → " +
                          (row.newMapEnabled ? "On" : "Off")}
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>

                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    loading={isBusy}
                    disabled={data.summary.updates === 0 || isBusy}
                    onClick={() =>
                      fetcher.submit(
                        { intent: "confirm", jobId: data.jobId },
                        { method: "post" },
                      )
                    }
                  >
                    {`Confirm import (${data.summary.updates})`}
                  </Button>
                  <Button
                    disabled={isBusy}
                    onClick={() =>
                      fetcher.submit(
                        { intent: "cancel", jobId: data.jobId },
                        { method: "post" },
                      )
                    }
                  >
                    Cancel
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                Recent imports
              </Text>
              {jobs.length === 0 ? (
                <Text as="p" variant="bodyMd" tone="subdued">
                  No imports yet.
                </Text>
              ) : (
                <BlockStack gap="200">
                  {jobs.map((job) => (
                    <InlineStack key={job.id} align="space-between" blockAlign="center">
                      <Text as="span" variant="bodySm">
                        {new Date(job.createdAt).toLocaleString()}
                      </Text>
                      <InlineStack gap="300" blockAlign="center">
                        <Text as="span" variant="bodySm">
                          {job.successCount} ok / {job.errorCount} errors
                        </Text>
                        {jobBadge(job.status)}
                      </InlineStack>
                    </InlineStack>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
