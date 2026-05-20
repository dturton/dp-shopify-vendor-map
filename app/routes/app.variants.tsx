import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Card,
  Checkbox,
  EmptyState,
  IndexTable,
  Modal,
  Page,
  Text,
  TextField,
  Thumbnail,
  useIndexResourceState,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import {
  getShopCurrency,
  getVariantsPage,
  saveVariantPricing,
  VARIANTS_PAGE_SIZE,
  type PageDirection,
  type SaveUserError,
  type VariantPricingInput,
  type VariantRow,
} from "../lib/metafields.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");
  const direction: PageDirection = before ? "previous" : "next";
  const cursor = before ?? after ?? null;

  return getVariantsPage(admin, {
    direction,
    cursor,
    pageSize: VARIANTS_PAGE_SIZE,
  });
};

interface ActionData {
  ok: boolean;
  variantsSaved: number;
  userErrors: SaveUserError[];
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionData> => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") !== "save") {
    return { ok: false, variantsSaved: 0, userErrors: [{ field: null, message: "Unknown action." }] };
  }

  const raw = formData.get("changes");
  if (typeof raw !== "string") {
    return { ok: false, variantsSaved: 0, userErrors: [{ field: null, message: "No changes submitted." }] };
  }

  let changes: VariantPricingInput[];
  try {
    changes = JSON.parse(raw) as VariantPricingInput[];
  } catch {
    return { ok: false, variantsSaved: 0, userErrors: [{ field: null, message: "Malformed changes payload." }] };
  }

  if (changes.length === 0) {
    return { ok: true, variantsSaved: 0, userErrors: [] };
  }

  const currencyCode = await getShopCurrency(admin);
  const result = await saveVariantPricing(admin, changes, currencyCode);
  return { ok: result.userErrors.length === 0, ...result };
};

type RowEdit = { actualPrice: string; mapEnabled: boolean };
type EditState = Record<string, RowEdit>;

function buildEdits(rows: VariantRow[]): EditState {
  const state: EditState = {};
  for (const row of rows) {
    state[row.id] = { actualPrice: row.actualPrice ?? "", mapEnabled: row.mapEnabled };
  }
  return state;
}

function currencySymbol(currency: string): string {
  try {
    const parts = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).formatToParts(0);
    return parts.find((part) => part.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

/** Wrapper that stops row-selection toggling when interacting with cell inputs. */
function CellInput({ children }: { children: ReactNode }) {
  return (
    <span
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </span>
  );
}

export default function VariantsRoute() {
  const { currencyCode, rows, pageInfo } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const fetcher = useFetcher<ActionData>();
  const shopify = useAppBridge();

  const [edits, setEdits] = useState<EditState>(() => buildEdits(rows));
  const [percentOpen, setPercentOpen] = useState(false);
  const [percentValue, setPercentValue] = useState("10");

  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(rows);

  // Reset local edits and selection whenever the page data changes
  // (pagination or post-save revalidation).
  useEffect(() => {
    setEdits(buildEdits(rows));
    clearSelection();
  }, [rows, clearSelection]);

  const isSaving = fetcher.state !== "idle";

  // Surface the save result.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && fetcher.data.variantsSaved > 0) {
      const n = fetcher.data.variantsSaved;
      shopify.toast.show(`Saved ${n} variant${n === 1 ? "" : "s"}`);
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const originals = useMemo(() => buildEdits(rows), [rows]);
  const rowById = useMemo(
    () => new Map(rows.map((row) => [row.id, row])),
    [rows],
  );

  const dirtyIds = useMemo(
    () =>
      rows
        .filter((row) => {
          const current = edits[row.id];
          const original = originals[row.id];
          if (!current || !original) return false;
          return (
            current.actualPrice.trim() !== original.actualPrice.trim() ||
            current.mapEnabled !== original.mapEnabled
          );
        })
        .map((row) => row.id),
    [rows, edits, originals],
  );
  const isDirty = dirtyIds.length > 0;

  const updateEdit = useCallback((id: string, patch: Partial<RowEdit>) => {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);

  const stageForSelected = useCallback(
    (compute: (row: VariantRow, current: RowEdit) => RowEdit) => {
      setEdits((prev) => {
        const next = { ...prev };
        for (const id of selectedResources) {
          const row = rowById.get(id);
          if (row) next[id] = compute(row, prev[id]);
        }
        return next;
      });
      clearSelection();
    },
    [selectedResources, rowById, clearSelection],
  );

  const applyPercentOff = useCallback(() => {
    const pct = Number(percentValue);
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
      shopify.toast.show("Enter a percentage between 0 and 100", { isError: true });
      return;
    }
    stageForSelected((row) => {
      const map = Number(row.mapPrice);
      const actualPrice = Number.isFinite(map)
        ? (map * (1 - pct / 100)).toFixed(2)
        : "";
      return { actualPrice, mapEnabled: true };
    });
    setPercentOpen(false);
  }, [percentValue, stageForSelected, shopify]);

  const copyMapToActual = useCallback(() => {
    stageForSelected((row, current) => ({
      ...current,
      actualPrice: Number.isFinite(Number(row.mapPrice))
        ? Number(row.mapPrice).toFixed(2)
        : row.mapPrice,
    }));
  }, [stageForSelected]);

  const clearActual = useCallback(() => {
    stageForSelected((_row, current) => ({ ...current, actualPrice: "" }));
  }, [stageForSelected]);

  const handleSave = useCallback(() => {
    const changes: VariantPricingInput[] = dirtyIds.map((id) => {
      const edit = edits[id];
      const trimmed = edit.actualPrice.trim();
      return {
        variantId: id,
        actualPrice: trimmed === "" ? null : trimmed,
        mapEnabled: edit.mapEnabled,
      };
    });
    fetcher.submit(
      { intent: "save", changes: JSON.stringify(changes) },
      { method: "post" },
    );
  }, [dirtyIds, edits, fetcher]);

  const handleDiscard = useCallback(() => setEdits(buildEdits(rows)), [rows]);

  const goNext = () =>
    pageInfo.endCursor &&
    navigate(`?after=${encodeURIComponent(pageInfo.endCursor)}`);
  const goPrevious = () =>
    pageInfo.startCursor &&
    navigate(`?before=${encodeURIComponent(pageInfo.startCursor)}`);

  const symbol = currencySymbol(currencyCode);
  const userErrors = fetcher.data && !fetcher.data.ok ? fetcher.data.userErrors : [];

  const rowMarkup = rows.map((row, index) => {
    const edit = edits[row.id] ?? { actualPrice: row.actualPrice ?? "", mapEnabled: row.mapEnabled };
    return (
      <IndexTable.Row
        id={row.id}
        key={row.id}
        position={index}
        selected={selectedResources.includes(row.id)}
      >
        <IndexTable.Cell>
          <Thumbnail source={row.imageUrl ?? ImageIcon} alt={row.imageAlt} size="small" />
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
            {symbol}
            {Number(row.mapPrice).toFixed(2)}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <CellInput>
            <TextField
              label="Actual price"
              labelHidden
              type="number"
              min={0}
              step={0.01}
              prefix={symbol}
              value={edit.actualPrice}
              onChange={(value) => updateEdit(row.id, { actualPrice: value })}
              autoComplete="off"
              placeholder="Not set"
            />
          </CellInput>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <CellInput>
            <Checkbox
              label="MAP enabled"
              labelHidden
              checked={edit.mapEnabled}
              onChange={(checked) => updateEdit(row.id, { mapEnabled: checked })}
            />
          </CellInput>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page
      fullWidth
      title="Variants — MAP pricing"
      subtitle={isDirty ? `${dirtyIds.length} unsaved change${dirtyIds.length === 1 ? "" : "s"}` : undefined}
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        loading: isSaving,
        disabled: !isDirty || isSaving,
      }}
      secondaryActions={[
        { content: "Discard", onAction: handleDiscard, disabled: !isDirty || isSaving },
      ]}
    >
      <TitleBar title="Variants — MAP pricing" />
      <BlockStack gap="300">
        {userErrors.length > 0 && (
          <Banner title="Some changes could not be saved" tone="critical">
            <BlockStack gap="100">
              {userErrors.map((error, i) => (
                <Text as="p" key={i} variant="bodySm">
                  {error.field?.length ? `${error.field.join(".")}: ` : ""}
                  {error.message}
                </Text>
              ))}
            </BlockStack>
          </Banner>
        )}
        <Card padding="0">
          {rows.length === 0 ? (
            <EmptyState
              heading="No variants found"
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>
                This store has no product variants yet. Add products in the
                Shopify admin to manage their MAP pricing here.
              </p>
            </EmptyState>
          ) : (
            <IndexTable
              resourceName={{ singular: "variant", plural: "variants" }}
              itemCount={rows.length}
              selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              promotedBulkActions={[
                { content: "Apply % off MAP", onAction: () => setPercentOpen(true) },
                { content: "Copy MAP → actual", onAction: copyMapToActual },
                { content: "Clear actual price", onAction: clearActual },
              ]}
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
      </BlockStack>

      <Modal
        open={percentOpen}
        onClose={() => setPercentOpen(false)}
        title="Apply percentage off MAP"
        primaryAction={{ content: "Apply", onAction: applyPercentOff }}
        secondaryActions={[{ content: "Cancel", onAction: () => setPercentOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">
              Sets <code>actual_price</code> to the discounted amount for{" "}
              {selectedResources.length} selected variant
              {selectedResources.length === 1 ? "" : "s"} and enables MAP. Review
              and Save to apply.
            </Text>
            <TextField
              label="Percent off"
              type="number"
              min={0}
              max={100}
              step={1}
              suffix="%"
              value={percentValue}
              onChange={setPercentValue}
              autoComplete="off"
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
