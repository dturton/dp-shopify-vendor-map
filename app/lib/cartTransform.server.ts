import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

/**
 * Activation for the Cart Transform Function.
 *
 * One Cart Transform is allowed per shop, so activation is idempotent: we check
 * for an existing transform first and only create one if missing. The function
 * is referenced by its extension handle (extensions/cart-transform), which only
 * resolves once the app (with the extension) has been deployed.
 */
export const CART_TRANSFORM_HANDLE = "cart-transform";

const LIST_CART_TRANSFORMS = `#graphql
  query ExistingCartTransforms {
    cartTransforms(first: 1) {
      nodes {
        id
        functionId
      }
    }
  }
`;

const CREATE_CART_TRANSFORM = `#graphql
  mutation CreateCartTransform($functionHandle: String!) {
    cartTransformCreate(functionHandle: $functionHandle, blockOnFailure: false) {
      cartTransform {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/** Returns the existing cart transform id, or null if none is active. */
export async function getCartTransformId(
  admin: AdminApiContext,
): Promise<string | null> {
  const response = await admin.graphql(LIST_CART_TRANSFORMS);
  const body = (await response.json()) as {
    data?: { cartTransforms: { nodes: { id: string }[] } };
  };
  return body.data?.cartTransforms.nodes[0]?.id ?? null;
}

export type EnsureCartTransformResult =
  | { ok: true; created: boolean; id: string }
  | { ok: false; message: string };

/** Creates the cart transform if one doesn't already exist (idempotent). */
export async function ensureCartTransform(
  admin: AdminApiContext,
): Promise<EnsureCartTransformResult> {
  const existing = await getCartTransformId(admin);
  if (existing) return { ok: true, created: false, id: existing };

  const response = await admin.graphql(CREATE_CART_TRANSFORM, {
    variables: { functionHandle: CART_TRANSFORM_HANDLE },
  });
  const body = (await response.json()) as {
    data?: {
      cartTransformCreate: {
        cartTransform: { id: string } | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    };
  };

  const result = body.data?.cartTransformCreate;
  if (result?.cartTransform) {
    return { ok: true, created: true, id: result.cartTransform.id };
  }

  const message =
    result?.userErrors.map((error) => error.message).join("; ") ||
    "Could not activate the cart transform. Deploy the app first, then try again.";
  return { ok: false, message };
}
