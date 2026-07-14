# Onsite Backend

[![CI](https://github.com/ZaycevDmitriy/onsite-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/ZaycevDmitriy/onsite-backend/actions/workflows/ci.yml)
[![Release](https://github.com/ZaycevDmitriy/onsite-backend/actions/workflows/release.yml/badge.svg)](https://github.com/ZaycevDmitriy/onsite-backend/actions/workflows/release.yml)

**English** · [Русский](README.ru.md)

> **For recruiters (TL;DR)**
>
> - **What:** the REST API behind [Onsite](https://github.com/ZaycevDmitriy/field-service-crm),
>   a mobile mini-CRM for field-service technicians — it turns the offline-first app into a
>   multi-user CRM: JWT auth with roles, a server-side order registry, an offline sync protocol
>   with idempotent mutations, photo reports (S3), Expo push notifications.
> - **Stack:** TypeScript (`strict`), Node.js 24, Fastify 5 + TypeBox (schema-first),
>   PostgreSQL 16 + Drizzle ORM, MinIO/S3, Docker Compose, GitHub Actions + semantic-release.
> - **Where to look:** [Offline sync](#offline-sync) (cursor pull with tombstones and safety-lag,
>   server-authoritative conflict resolution), [Authentication](#authentication) (RS256, refresh
>   rotation with family revocation), [Architecture](#architecture) (Modular Monolith),
>   [Production deployment](#production-deployment-self-host).
> - **Try it:** `docker compose up` — migrations and demo seed apply automatically,
>   OpenAPI UI at `http://localhost:3000/docs`.

**Onsite Backend** is the server for the Onsite mobile mini-CRM (router installs, line
diagnostics, cable repair). It is a portfolio project focused on the hard parts of a real
field-service backend: offline synchronization, idempotency, conflict resolution, and a
self-hosted production setup.

## Overview

A dispatcher creates service orders and assigns them to technicians; a technician receives a
push notification, works offline in basements and industrial areas, and syncs when back online.
The server is the source of truth: every offline mutation is validated against the current state,
conflicts are resolved server-side, and the verdict ships back with a state snapshot so the
client can converge.

## Why this project matters

The constraints are taken from production practice, not invented for the demo:

- technicians work offline by default, so the sync protocol must be **idempotent and resumable** —
  every mutation carries a client `mutationId`, every pull is cursor-based and safe to repeat;
- concurrent writers commit out of order, so the pull cursor uses a **safety-lag** over a global
  sequence instead of naive timestamps;
- photos are large and unreliable to upload, so they are **staged first** and committed by a sync
  mutation later, with an orphan-cleanup worker;
- push delivery must not break the API request that triggered it, so notifications go through an
  **outbox table** and a background worker.

## What this project demonstrates

- Schema-first API design: TypeBox schemas drive validation and the OpenAPI spec; the committed
  `openapi.json` snapshot is checked by CI for drift
- An offline sync protocol: cursor pull with tombstones and safety-lag, batched idempotent
  mutations, server-authoritative conflict resolution with state snapshots
- JWT auth done properly: RS256, short-lived access tokens, opaque refresh tokens with rotation
  and family revocation on reuse, argon2id password hashing, login rate limiting
- An order state machine with an append-only `order_events` audit log
- Staged photo uploads to S3/MinIO with presigned URLs and idempotent multipart handling
- Expo push via the outbox pattern with receipt checking and dead-token deactivation
- Modular Monolith boundaries enforced by convention: modules own their tables and expose a
  public API through `index.ts`
- Observability: structured pino logs with request IDs, Prometheus metrics, a 5xx alert rule
- A full self-host production stack: Caddy with automatic TLS, GHCR images, daily backups
- Automated releases: Conventional Commits + semantic-release, OWASP API Top-10 audit before v1.0

## Features

- **Authentication** — login with email/password, RS256 access tokens, refresh rotation where
  reuse of a revoked token kills the whole session family; role-based access
  (`dispatcher` / `technician`).
- **Users** — account management by dispatchers; password reset revokes all refresh sessions;
  deactivation takes effect immediately.
- **Orders** — CRUD with keyset pagination, assignment, a status state machine
  (New → In Progress → Done / Cancelled), and a full event history per order. A technician
  requesting someone else's order gets a 404, not a 403.
- **Offline sync** — cursor-based pull of changed orders and unassignment tombstones in a single
  stream; batched offline mutations (status changes, photo commits), each idempotent and applied
  in its own transaction.
- **Photo reports** — staged multipart upload with an `Idempotency-Key`, commit via a sync
  mutation, download through short-lived presigned URLs, background cleanup of orphaned uploads.
- **Push notifications** — order assignment enqueues an Expo push through an outbox table; a
  worker sends in chunks, checks receipts, and deactivates dead tokens.
- **Operations** — rate limiting (global + stricter on `/v1/auth/*`), Prometheus metrics,
  `x-request-id` echoed in every response, a single error envelope `{ code, message, details? }`.

## Tech Stack

- **Runtime:** Node.js 24, TypeScript 6 (`strict`, no `any`), ESM (NodeNext)
- **Framework:** Fastify 5 + TypeBox type provider (schema-first), @fastify/jwt, @fastify/multipart, @fastify/rate-limit, @fastify/helmet
- **Database:** PostgreSQL 16, Drizzle ORM, forward-only migrations (drizzle-kit)
- **Storage:** S3-compatible (MinIO locally, presigned URLs via AWS SDK v3)
- **Push:** expo-server-sdk (outbox + worker)
- **Security:** argon2id (@node-rs/argon2), JWT RS256
- **Observability:** pino (structured JSON logs), prom-client
- **Tooling:** vitest (integration tests against real PostgreSQL/MinIO), ESLint 9, Prettier, semantic-release, Docker Compose

## Architecture

Modular Monolith. Modules live in `src/modules/`, shared infrastructure in `src/shared/`;
the composition root is `src/app.ts` + `src/main.ts`.

Hard boundaries:

- a module is consumed only through its public API (`index.ts`); each table is owned by exactly
  one module, neighbors go through its API;
- `shared/*` never imports from `modules/*`;
- `domain.ts` files are pure functions — no Drizzle, Fastify, AWS SDK, or env access; the status
  transition matrix is a constant table mirroring the mobile client's guards;
- routes are thin: a TypeBox schema plus a service call; a route without a schema is not
  registered;
- deferred cross-module actions go through queue tables (`push_outbox`), not direct calls.

## Project Structure

```
src/
  app.ts, main.ts       # composition root
  modules/
    auth/               # login, refresh rotation, JWT plugin wiring
    users/              # accounts, roles, argon2id
    orders/             # CRUD, assignment, state machine, order_events
    sync/               # cursor pull, batched idempotent mutations
    photos/             # staged uploads, presigned URLs, orphan cleanup
    notifications/      # devices, push outbox + worker
    health/             # liveness + dependency checks
  shared/
    config/             # env parsing and validation
    db/                 # Drizzle client, transactions
    errors/             # error envelope, error codes
    plugins/            # auth, metrics, rate limiting, request-id
  cli/                  # production entrypoints: migrate, create-first-user
deploy/                 # Caddyfile, Prometheus config, backup scripts
drizzle/                # SQL migrations
```

## Getting Started

Prerequisites: Docker (for the full stack) or Node.js 24 + a PostgreSQL/MinIO instance.

The whole stack — API, PostgreSQL, MinIO; migrations and demo seed apply automatically:

```bash
npx tsx scripts/generate-jwt-keys.ts >> .env   # RS256 key pair (one-time)
docker compose up
```

After startup:

- `http://localhost:3000/v1/health` — service and dependency status;
- `http://localhost:3000/docs` — OpenAPI UI.

The credentials in `compose.yml` (`onsite/onsite`, `minioadmin`) are for the local demo stack
only, not for production.

### Local development without Docker

```bash
nvm use               # Node 24 from .nvmrc
npm ci
cp .env.example .env  # adjust DATABASE_URL if needed
npx tsx scripts/generate-jwt-keys.ts >> .env  # JWT_PRIVATE_KEY / JWT_PUBLIC_KEY
npm run migrate
npm run seed
npm run dev
```

### Demo accounts (seed)

| Role       | Email                     | Password        |
| ---------- | ------------------------- | --------------- |
| Dispatcher | `dispatcher@onsite.local` | `dispatcher123` |
| Technician | `tech1@onsite.local`      | `technician123` |
| Technician | `tech2@onsite.local`      | `technician123` |

The seed creates 6 demo orders compatible with the mobile client's mock data. All data is
fictional. The seed refuses to run against production (`NODE_ENV=production` or a non-local
database host).

### Tests

Integration tests run against real PostgreSQL and MinIO — without `DATABASE_URL` they are
skipped; photo tests additionally need `S3_ENDPOINT`:

```bash
docker compose up -d postgres minio minio-init
DATABASE_URL=postgres://onsite:onsite@localhost:5432/onsite \
S3_ENDPOINT=http://localhost:9000 \
S3_ACCESS_KEY=minioadmin \
S3_SECRET_KEY=minioadmin \
  npm run migrate && npm test
```

## API Overview

Full contract: `openapi.json` (committed snapshot, CI fails on drift) or the live `/docs` UI.

| Area    | Endpoints                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------- |
| Auth    | `POST /v1/auth/login`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`                                            |
| Users   | `POST /v1/users`, `PATCH /v1/users/:id` (dispatcher only)                                                         |
| Orders  | `GET/POST /v1/orders`, `GET/PATCH /v1/orders/:id`, `POST /v1/orders/:id/assign`, `POST /v1/orders/:id/transition` |
| Sync    | `GET /v1/sync/orders?cursor&limit`, `POST /v1/sync/mutations` (technician only)                                   |
| Photos  | `POST /v1/orders/:id/photos` (multipart, `Idempotency-Key`), `GET /v1/photos/:id/file` (302 → presigned URL)      |
| Devices | `PUT /v1/devices` (Expo push token upsert)                                                                        |
| Ops     | `GET /v1/health`, `GET /metrics`                                                                                  |

## Authentication

- `POST /v1/auth/login` — email/password, returns an `accessToken` (JWT RS256, 15 min by
  default), an opaque `refreshToken` (30 days by default), and the `user` profile. 5 consecutive
  failures → 429 for 15 minutes.
- `POST /v1/auth/refresh` — rotation: the old token is retired; reuse of a retired token revokes
  the entire session family.
- `POST /v1/auth/logout` — revokes the refresh session family.

RS256 keys are provided via `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` env vars (base64-encoded PEM),
generated by `scripts/generate-jwt-keys.ts` — no keys in git.

## Offline Sync

Both endpoints are technician-only; the cursor and mutations are idempotent, conflicts are
resolved server-side (server-authoritative).

- `GET /v1/sync/orders?cursor&limit` — pulls the technician's changed orders and tombstones of
  removed/reassigned assignments as a single stream ordered by a global `bigint` sequence
  (`sync_seq`). On a partial page the cursor advances with a **safety-lag** (default 100) to
  compensate for concurrent transactions committing out of order — re-delivering the tail is
  safe because the pull is idempotent.
- `POST /v1/sync/mutations` — a batch of 1–500 offline mutations, each idempotent by client
  `mutationId` (a repeat returns the original verdict byte-for-byte) and applied in its own
  transaction, so one failure never blocks the rest of the batch.
  - `status_change` — a `baseStatus` mismatch or an invalid transition yields a `conflict`
    verdict with a snapshot of the current order state and a `sync_conflict` event;
  - `photo_add` — commits a previously staged photo; a photo report against an already
    Done/Cancelled order is still `applied` (valuable after the fact).

Every applied mutation writes an `order_events` entry with `source: 'sync'` and advances the
order's cursor.

## Production Deployment (self-host)

`compose.production.yml` is a complete self-host stack: Caddy (reverse proxy with automatic TLS
via Let's Encrypt) → API, PostgreSQL, MinIO, Prometheus (with a 5xx-rate alert rule), and daily
backups of both `pg_dump` and the photo bucket. The `api` / `migrate` services use a prebuilt
image from GHCR — no build on the VPS. The first dispatcher account is created with
`create-first-user`. Details: `deploy/` (Caddyfile, Prometheus config, backup scripts) and
`.env.production.example`.

## Releases

Trunk-based flow: `main` + `feature/*`. Versioning and release notes are automated with
[semantic-release](https://semantic-release.gitbook.io/) from
[Conventional Commits](https://www.conventionalcommits.org/) — the version is an output derived
from commit history, not set by hand. The release pipeline publishes a tag, a GitHub Release
with notes, and a Docker image to GHCR. Commit messages use an English type with a Russian
description.

## Design Decisions

- **Modular Monolith over microservices** — one deployable with enforced module boundaries;
  the sync protocol needs cross-module transactions anyway.
- **Schema-first with TypeBox** — one source of truth for validation, TypeScript types, and the
  OpenAPI spec; CI guards the committed spec snapshot against drift.
- **Server-authoritative conflict resolution** — the client never merges: it sends the base
  state it acted on, and the server either applies or returns a conflict with a snapshot.
- **A global sequence + safety-lag instead of timestamps** — monotonic cursors survive clock
  skew; the lag covers transactions that commit out of order.
- **Staged photos** — upload and commit are separate steps, so a technician can upload over a
  flaky connection long before the sync batch that references the photo.
- **Outbox for push** — assignment and notification are decoupled; Expo being down never fails
  the assign request.
- **404 instead of 403 for foreign resources** — a technician cannot probe for the existence of
  other technicians' orders or photos.

## Trade-offs

- In-process workers (push, photo cleanup) instead of a separate queue service — enough for the
  expected load, one less moving part to operate.
- `/metrics` is unauthenticated — protected by not publishing the port in the production
  compose, not by the application.
- No multi-tenant support: one installation serves one company — matching the self-host model.
- Refresh tokens are opaque DB rows, not JWTs — revocation and family tracking need server state
  anyway.

## Related Repository

The mobile client: [field-service-crm](https://github.com/ZaycevDmitriy/field-service-crm) —
offline-first Expo / React Native app (Expo Router, SQLite, EAS Build / OTA).

## License

[PolyForm Noncommercial 1.0.0](LICENSE) © 2026 Dmitriy Zaycev
