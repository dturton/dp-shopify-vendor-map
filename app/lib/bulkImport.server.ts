import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import {
  ACTUAL_PRICE_KEY,
  APP_METAFIELD_NAMESPACE,
  MAP_ENABLED_KEY,
  normalizeAmount,
} from "./metafields.server";
import type { ImportChange } from "./csvImport.server";

/**
 * Large-import path: writes actual_price/map_enabled for many variants via
 * bulkOperationRunMutation over a JSONL of metafieldsSet variables.
 *
 * NOTE: the staged-upload + poll flow could not be exercised in development
 * (it needs a live store), so it is implemented to Shopify's docs and should be
 * verified against a real store. Clears (blank actual_price) are handled on the
 * synchronous path by the caller; only sets go through here.
 */

const BULK_SET_MUTATION =
  "mutation CsvImportSet($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }";

const STAGED_UPLOADS_CREATE = `#graphql
  mutation BulkImportStagedUpload($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const BULK_RUN_MUTATION = `#graphql
  mutation RunBulkImport($mutation: String!, $stagedUploadPath: String!) {
    bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
      bulkOperation {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const BULK_OPERATION_QUERY = `#graphql
  query BulkImportStatus($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        objectCount
        errorCode
        url
        partialDataUrl
      }
    }
  }
`;

/** Builds one JSONL line per variant: map_enabled + actual_price metafieldsSet vars. */
export function buildImportJsonl(sets: ImportChange[], currencyCode: string): string {
  return sets
    .map((change) =>
      JSON.stringify({
        metafields: [
          {
            ownerId: change.variantId,
            namespace: APP_METAFIELD_NAMESPACE,
            key: MAP_ENABLED_KEY,
            type: "boolean",
            value: change.mapEnabled ? "true" : "false",
          },
          {
            ownerId: change.variantId,
            namespace: APP_METAFIELD_NAMESPACE,
            key: ACTUAL_PRICE_KEY,
            type: "money",
            value: JSON.stringify({
              amount: normalizeAmount(change.actualPrice ?? "0"),
              currency_code: currencyCode,
            }),
          },
        ],
      }),
    )
    .join("\n");
}

interface StagedTarget {
  url: string;
  parameters: { name: string; value: string }[];
}

async function createStagedUpload(admin: AdminApiContext): Promise<StagedTarget> {
  const response = await admin.graphql(STAGED_UPLOADS_CREATE, {
    variables: {
      input: [
        {
          resource: "BULK_MUTATION_VARIABLES",
          filename: "vendor-map-import.jsonl",
          mimeType: "text/jsonl",
          httpMethod: "POST",
        },
      ],
    },
  });
  const body = (await response.json()) as {
    data?: {
      stagedUploadsCreate: {
        stagedTargets: StagedTarget[];
        userErrors: { message: string }[];
      };
    };
  };
  const payload = body.data?.stagedUploadsCreate;
  if (!payload || payload.userErrors.length > 0 || payload.stagedTargets.length === 0) {
    throw new Error(
      `stagedUploadsCreate failed: ${JSON.stringify(payload?.userErrors ?? "no data")}`,
    );
  }
  return payload.stagedTargets[0];
}

async function uploadJsonl(target: StagedTarget, jsonl: string): Promise<string> {
  const form = new FormData();
  for (const param of target.parameters) {
    form.append(param.name, param.value);
  }
  // The file field must be appended last.
  form.append("file", new Blob([jsonl], { type: "text/jsonl" }), "vendor-map-import.jsonl");

  const upload = await fetch(target.url, { method: "POST", body: form });
  if (!upload.ok) {
    throw new Error(`staged upload failed: HTTP ${upload.status}`);
  }
  const key = target.parameters.find((param) => param.name === "key")?.value;
  if (!key) throw new Error("staged upload did not return a key");
  return key;
}

/**
 * Uploads the JSONL and starts the bulk mutation. Returns the BulkOperation GID
 * to poll. Throws on any setup error.
 */
export async function startBulkImport(
  admin: AdminApiContext,
  sets: ImportChange[],
  currencyCode: string,
): Promise<string> {
  const target = await createStagedUpload(admin);
  const stagedUploadPath = await uploadJsonl(target, buildImportJsonl(sets, currencyCode));

  const response = await admin.graphql(BULK_RUN_MUTATION, {
    variables: { mutation: BULK_SET_MUTATION, stagedUploadPath },
  });
  const body = (await response.json()) as {
    data?: {
      bulkOperationRunMutation: {
        bulkOperation: { id: string; status: string } | null;
        userErrors: { message: string }[];
      };
    };
  };
  const result = body.data?.bulkOperationRunMutation;
  if (!result?.bulkOperation || result.userErrors.length > 0) {
    throw new Error(
      `bulkOperationRunMutation failed: ${JSON.stringify(result?.userErrors ?? "no data")}`,
    );
  }
  return result.bulkOperation.id;
}

export interface BulkStatus {
  status: string;
  objectCount: number;
  errorCode: string | null;
  url: string | null;
}

/** Polls a BulkOperation's status by id. */
export async function pollBulkOperation(
  admin: AdminApiContext,
  id: string,
): Promise<BulkStatus | null> {
  const response = await admin.graphql(BULK_OPERATION_QUERY, { variables: { id } });
  const body = (await response.json()) as {
    data?: {
      node: {
        status: string;
        objectCount: string | number | null;
        errorCode: string | null;
        url: string | null;
      } | null;
    };
  };
  const node = body.data?.node;
  if (!node) return null;
  return {
    status: node.status,
    objectCount: Number(node.objectCount ?? 0),
    errorCode: node.errorCode,
    url: node.url,
  };
}
