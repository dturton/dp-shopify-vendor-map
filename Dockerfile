# Multi-stage build for Fly.io.
#
# Node 22 (the template's node:18 violates this app's `engines` field, and
# `.npmrc` sets engine-strict=true so `npm ci` would hard-fail). The build stage
# installs all deps (Vite is a devDependency) so `npm run build` works; the
# runtime stage keeps only production deps.

# ---- Build stage -----------------------------------------------------------
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Runtime stage ---------------------------------------------------------
FROM node:22-alpine
RUN apk add --no-cache openssl
ENV NODE_ENV=production
WORKDIR /app
EXPOSE 3000

COPY package.json package-lock.json* ./
# `prisma` (CLI) and @prisma/client are production deps, so they survive --omit=dev.
# The Shopify CLI is not needed at runtime.
RUN npm ci --omit=dev && npm remove @shopify/cli && npm cache clean --force

COPY prisma ./prisma
COPY --from=build /app/build ./build
COPY --from=build /app/public ./public

# docker-start runs `prisma generate && prisma migrate deploy` then serves.
CMD ["npm", "run", "docker-start"]
