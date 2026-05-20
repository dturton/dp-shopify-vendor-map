# Sprayer Depot — Vendor MAP Pricing

A Shopify **custom app** for Sprayer Depot that manages **Minimum Advertised
Price (MAP)** compliance. Admins manage a per-variant *actual price*; a Cart
Transform Function (Phase 3) swaps the advertised MAP for the lower actual price
once an item is in the cart — so the storefront keeps showing the MAP while the
customer is charged less at checkout.

## How pricing is modeled

| Concept            | Where it lives                                  |
| ------------------ | ----------------------------------------------- |
| Advertised MAP     | `variant.price` (the catalog price — unchanged) |
| Charged price      | `actual_price` variant metafield (`money`)      |
| Per-variant toggle | `map_enabled` variant metafield (`boolean`)     |
| Strikethrough      | Theme-side (`original_line_price` vs `final_line_price`) |

- **Absolute prices**, not percentages.
- **All customers** get the discount (no B2B gating, no tag filtering).
- `compareAtPrice` is **never** touched — strikethrough is the theme's job.
- There is **no** `map_price` metafield: `variant.price` *is* the MAP.

## Stack

- Remix + TypeScript (`@shopify/shopify-app-remix`), strict mode
- Polaris + App Bridge React (embedded admin)
- Prisma + **PostgreSQL** (session storage + `CsvJob` tracking)
- Cart Transform Function (TypeScript → WASM) — Phase 3
- `@shopify/cli` for dev/deploy; hosting target **Fly.io**

## Repo layout

```
sprayer-vendor-map/
├── shopify.app.toml            # scopes, webhooks, app-owned metafield definitions
├── shopify.web.toml
├── fly.toml                    # Fly.io config (not deployed yet)
├── Dockerfile                  # multi-stage, Node 22
├── prisma/schema.prisma        # Session + CsvJob (Postgres)
├── app/
│   ├── shopify.server.ts       # shopifyApp(): SingleMerchant distribution
│   ├── db.server.ts
│   ├── lib/
│   │   ├── metafields.server.ts  # $app keys, read/scan/export, metafieldsSet/Delete
│   │   ├── csv.server.ts         # CSV (de)serialize + export builder
│   │   ├── csvImport.server.ts   # parse/validate/diff import rows
│   │   ├── bulkImport.server.ts  # >200-row bulkOperationRunMutation path
│   │   └── cartTransform.server.ts # idempotent cartTransformCreate activation
│   └── routes/
│       ├── app._index.tsx        # overview
│       ├── app.variants.tsx      # editable variant list (inline + bulk actions)
│       ├── app.import.tsx        # CSV import (preview → confirm)
│       ├── app.export.tsx        # CSV export
│       ├── app.settings.tsx
│       ├── webhooks.app.uninstalled.tsx
│       ├── webhooks.app.scopes_update.tsx
│       ├── webhooks.customers.data_request.tsx   # GDPR
│       ├── webhooks.customers.redact.tsx          # GDPR
│       └── webhooks.shop.redact.tsx               # GDPR
└── extensions/
    └── cart-transform/         # Cart Transform Function (TypeScript → wasm)
        ├── shopify.extension.toml
        ├── src/cart_transform_run.graphql
        └── src/cart_transform_run.ts
```

## Metafield definitions & the `$app` namespace

The two variant metafields are declared **declaratively** in `shopify.app.toml`
(`[variant.metafields.app.*]`) and installed/updated on `shopify app deploy`.
Being in the reserved **`$app`** namespace makes them app-owned, which is what
grants the Cart Transform Function its *implicit* read access.

> **Note / deviation from the original spec.** The spec called for the
> `$app:vendor_map` *sub-namespace*. TOML declarative definitions only support
> the bare `app` namespace (sub-namespaces aren't expressible in TOML), so the
> runtime namespace is `$app` with keys `actual_price` / `map_enabled`. This is
> functionally equivalent for implicit function access. To use a sub-namespace
> you would have to create the definitions at runtime via `metafieldDefinitionCreate`
> instead. See [declarative custom data definitions](https://shopify.dev/docs/apps/build/custom-data/declarative-custom-data-definitions).

After install, the definitions appear under **Settings → Custom data → Variants**
in the Shopify admin.

## Prerequisites

- Node `>=20.19 <22 || >=22.12` (CI/Docker use Node 22)
- A PostgreSQL database (local for dev; Fly Postgres / managed PG for prod)
- A Shopify Partner account with access to the Sprayer Depot store
- `@shopify/cli` (bundled as a dependency; `npm run shopify`)

## Environment variables

Copy `.env.example` → `.env` and fill in. `.env` is gitignored.

| Variable              | Required | Notes                                                                 |
| --------------------- | -------- | --------------------------------------------------------------------- |
| `DATABASE_URL`        | yes      | Postgres connection string (Prisma).                                  |
| `SHOPIFY_API_KEY`     | dev: no  | Injected by `shopify app dev`. Set manually in production.            |
| `SHOPIFY_API_SECRET`  | dev: no  | Injected by `shopify app dev`. Set manually in production.            |
| `SHOPIFY_APP_URL`     | dev: no  | Injected by `shopify app dev`. Set to the Fly URL in production.      |
| `SCOPES`              | yes\*    | `read_products,write_products` (must match `shopify.app.toml`).       |
| `SHOP_CUSTOM_DOMAIN`  | no       | Optional custom shop domain for local testing.                        |

\* The CLI injects `SCOPES` during `dev`; set it yourself when self-hosting.

## Local development

1. **Start Postgres.** For example, with Docker:

   ```bash
   docker run --name sprayer-pg -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=sprayer_vendor_map -p 5432:5432 -d postgres:16
   ```

   Then set `DATABASE_URL` in `.env` (see `.env.example`).

2. **Apply migrations** (also run automatically by `shopify app dev`):

   ```bash
   npm run setup        # prisma generate && prisma migrate deploy
   ```

3. **Run the app:**

   ```bash
   npm run dev          # shopify app dev
   ```

   The CLI prompts you to log in, select the Partner org, and connect/create the
   app. It injects `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`,
   and `SCOPES`, then opens a tunnel and an install link for your dev store.

### Useful scripts

| Script               | What it does                          |
| -------------------- | ------------------------------------- |
| `npm run dev`        | `shopify app dev`                     |
| `npm run build`      | Production build (`remix vite:build`) |
| `npm run lint`       | ESLint                                |
| `npm run typecheck`  | `tsc --noEmit`                        |
| `npm run setup`      | `prisma generate && migrate deploy`   |
| `npm run deploy`     | `shopify app deploy` (config + extensions) |

## Installing on Sprayer Depot's store (custom distribution)

This is a **custom app** (single merchant), not an App Store listing.

1. In the **Partner Dashboard** → the app → **Distribution**, choose **Custom
   distribution** and enter the Sprayer Depot store domain.
2. Generate the **install link** and open it as a store admin to install.
3. On install, the app requests `read_products,write_products`, and the metafield
   definitions are created (via `shopify app deploy` of the config).
4. Verify under **Settings → Custom data → Variants** that `Actual price` and
   `MAP enabled` definitions exist.

## Deploying to Fly.io (not done yet)

`fly.toml` and the `Dockerfile` are Fly-ready. When you're ready:

```bash
fly launch --no-deploy            # or reuse the included fly.toml
fly postgres create
fly postgres attach <pg-app>      # sets DATABASE_URL
fly secrets set SHOPIFY_API_KEY=... SHOPIFY_API_SECRET=... \
  SHOPIFY_APP_URL=https://<app>.fly.dev SCOPES=read_products,write_products
fly deploy                        # release_command runs `prisma migrate deploy`
```

Then update `application_url` / redirect URLs to the Fly URL and run
`shopify app deploy`.

## Cart Transform caveats (Phase 3)

- **Shopify Plus required** for the price override. `lineUpdate` (price `update`)
  operations only apply on stores on the Shopify Plus plan — confirm Sprayer
  Depot's plan. The function still installs/activates on non-Plus; it just won't
  change prices.
- Cart Transform only affects **customer-facing carts**. **Draft Orders** and
  admin-created orders are **not** transformed — this is a platform limitation,
  not worked around.
- There is **one active Cart Transform per shop**. Don't create a second one;
  merge logic into the existing function.
- The function has an ~11ms compute budget — its input query selects only what
  it needs (line `cost`, `merchandise.id`, `isGiftCard`, both metafields,
  `presentmentCurrencyRate`).
- **Multi-currency:** `fixedPricePerUnit.amount` is in *presentment* currency, so
  `actual_price` (shop currency) is multiplied by `presentmentCurrencyRate`.
- **Activation:** runs automatically on install (`afterAuth`, idempotent) once the
  function is deployed; otherwise activate from **Settings → Cart Transform**.
  Requires `shopify app deploy` first so the `cart-transform` function exists.

## Phase 1 — done

Read-only foundation:

- [x] Remix + TS scaffold, `read_products,write_products`, SingleMerchant
- [x] Postgres Prisma schema (`Session`, `CsvJob`)
- [x] App-owned variant metafield definitions (`$app`, declarative TOML)
- [x] GDPR + uninstall webhooks
- [x] Read-only variants `IndexTable` (50/page, cursor pagination)

## Phase 2 — bulk admin UI — done

- [x] Inline-editable cells: `actual_price` input + `map_enabled` toggle, with
      dirty-tracking and Save/Discard
- [x] Bulk save via `metafieldsSet` / `metafieldsDelete` (chunked to **25 per call**)
- [x] Filters: vendor, collection, missing `actual_price`, discount ≥ X%
- [x] Bulk actions: apply X% off MAP, clear `actual_price`, copy MAP → `actual_price`
- [x] CSV import (preview diff → confirm; `bulkOperationRunMutation` JSONL for
      >200 rows; tracked via `CsvJob`)
- [x] CSV export: variant id, SKU, vendor, MAP, actual_price, computed % off

### Behavior notes

- **Variants (`/app/variants`)** — edit `actual_price` (money) and `map_enabled`
  inline; **Save** writes changed rows only. Select rows for bulk actions
  (**Apply % off MAP**, **Copy MAP → actual**, **Clear actual price**); these
  *stage* edits for review, then **Save** commits.
- **Filters** — `vendor`/`collection` are filtered server-side (and survive
  pagination). `missing actual_price` and `discount ≥ X%` can't be searched
  server-side, so they run a **bounded catalog scan** (fetch cap 2,000, display
  cap 250), narrowed by any vendor/collection filter; pagination is disabled in
  scan mode. Narrow by vendor/collection for very large catalogs.
- **CSV export (`/app/export`)** — honors the same filters; the file downloads
  client-side (Blob) to work inside the embedded admin. Catalog fetch cap 10,000.
- **CSV import (`/app/import`)** — match key is **`variant_id`** (the export GID).
  `actual_price` blank ⇒ clears it. `map_enabled` is optional: if the column is
  absent it's derived (a price enables MAP, a blank disables). You preview a diff
  before anything is written; only changed rows are applied. ≤ 200 rows write
  synchronously via `metafieldsSet`; **> 200 rows** use `bulkOperationRunMutation`
  (staged JSONL upload) and finish in the background — use **Check status** to
  finalize. Jobs are tracked in the `CsvJob` table (see **Recent imports**).

> **Not yet verified on a live store:** the large-import bulk path
> (staged upload + `bulkOperationRunMutation` + poll) is implemented to Shopify's
> docs but could not be exercised in development. Test it against the real store.

## Phase 3 — Cart Transform Function — done

- [x] `extensions/cart-transform` (TypeScript), target `cart.transform.run`
- [x] `src/cart_transform_run.graphql`: line `cost`, `merchandise` (id, `isGiftCard`,
      `$app` `actual_price` + `map_enabled`), `presentmentCurrencyRate`
- [x] `src/cart_transform_run.ts`: per-unit `lineUpdate` → `fixedPricePerUnit` =
      `actual_price` (converted to presentment) when `map_enabled` is true,
      `actual_price` is set, and it's below the current MAP; else no-op
- [x] Idempotent activation via `cartTransformCreate(functionHandle)` —
      `afterAuth` + Settings fallback
- [x] Multi-currency via `presentmentCurrencyRate`; gift cards skipped
- [x] Tests (vitest) build the wasm and assert apply / skip-disabled / skip-gift-card

Build/test the function locally:

```bash
cd extensions/cart-transform
npm run typegen      # regenerate generated/api.ts from the schema + query
npm run build        # compile to dist/function.wasm
npm test             # run the wasm against tests/fixtures
```

> **Not yet verified on a live store:** activation (`cartTransformCreate`) and the
> in-cart price swap need a real store (and Shopify Plus for price overrides).
> The function logic itself is verified via the wasm test fixtures above.
