# OWASP API Security Top 10 (2023) — how VibeMatch v2 addresses each risk

Every row names the code that implements the control and the test that fails if it regresses.
Paths are relative to `backend/`.

## The 12 API-security tips

| Tip | Where | Test |
|---|---|---|
| Use HTTPS | `src/middleware/security.ts` (`enforceHttps`, HSTS via helmet), `src/config/env.ts` (production requires an `https://` `PUBLIC_URL`), `deploy/nginx.conf` (TLS 1.2/1.3) | `gateway.test.ts` "production: redirects HTTP→HTTPS…" |
| Use OAuth2 | `modules/auth/session.service.ts` (rotating refresh tokens, reuse detection), `auth.routes.ts` (`/auth/token` RFC 6749, `/auth/revoke` RFC 7009) | `auth.test.ts` "refresh tokens (OAuth2 rotation)", "OAuth2 token endpoint" |
| Use WebAuthn | `modules/auth/webauthn.service.ts` (passkeys for admins: step-up and passwordless) | `webauthn.test.ts` (software authenticator, real verification) |
| Leveled API keys | `core/security/api-key.ts`, `middleware/authenticate.ts` (`apiKeyGuard`), `modules/admin/api-keys/*` | `api-keys.test.ts`, `gateway.test.ts` "leveled API keys" |
| Authorization | `gateway/route-registry.ts` (deny-by-default), `middleware/authenticate.ts` (`authorize`), service-level ownership checks | `authz-matrix.test.ts` (walks **every** route) |
| Rate limiting | `middleware/rate-limit.ts` (memory/Redis stores, named policies), `realtime/socket-limiter.ts` | `gateway.test.ts` "rate limiting", `realtime.test.ts` "abuse protection" |
| API versioning | `/api/v1` prefix + `Accept-Version` negotiation + `Deprecation`/`Sunset` (`core/http/versioning.ts`) | `gateway.test.ts` "versioning" |
| Whitelisting | zod `.strict()` on every body/query/params (`gateway/route-registry.ts`), CORS allow-list, admin IP allow-list (`middleware/ip-allowlist.ts`), settings field allow-lists (`modules/settings/settings.groups.ts`), upload type sniffing (`middleware/upload.ts`), payment return-URL allow-list | `gateway.test.ts`, `settings.test.ts` "rejects unknown fields", `payments.test.ts` "returnUrl must be on the allow-list" |
| Check OWASP API Top 10 | this document | — |
| Use an API gateway | `gateway/route-registry.ts` (single declarative pipeline) + `deploy/nginx.conf` (edge) | `gateway.test.ts` |
| Error handling | `core/errors/*`, `middleware/error-handler.ts` (RFC 9457 problem+json, no stack traces) | `gateway.test.ts` "error handling (RFC 9457)" |
| Input validation | zod schemas per route, `middleware/sanitize.ts` (Mongo-operator / prototype-pollution keys), body size limit | `gateway.test.ts` "validation & whitelisting", "rejects Mongo operator injection" |

## Top 10

### API1 — Broken Object Level Authorization
* The conversation key is derived from the **caller** and the partner id, so a user can only ever address their own threads (`modules/chat/chat.service.ts` → `conversationKey`).
* Notifications are looked up with `{ id, userId }`; another user's id is indistinguishable from a missing one (`notification.service.ts` → `markRead`).
* A paid Stripe/PayPal/Razorpay payment is bound to the buyer at checkout and rejected for anyone else (`payment.service.ts` → `payment_owner_mismatch`).
* Tests: `chat.test.ts` "pages messages … BOLA", `social.test.ts` "is owner-scoped", `payments.test.ts` "IDOR: someone else's paid session cannot be claimed".

### API2 — Broken Authentication
* Login only authenticates existing accounts (v1 created one for any unknown username — L1). Same answer for unknown user and wrong password; a dummy bcrypt comparison equalises timing (`core/security/password.ts`).
* Lock-out after repeated failures is atomic (`user.repository.ts` → `recordFailedLogin`), plus a per-IP+account limiter on `/auth/*`.
* Access tokens live 15 minutes; refresh tokens are single-use, stored hashed, and replay revokes the whole session (`session.service.ts`).
* Passwords: bcrypt cost ≥ 12 (configurable), 72-byte limit enforced instead of silent truncation, common-password deny-list.
* Tests: `auth.test.ts` (L1 regression, lock-out, rotation/reuse, cookies), `webauthn.test.ts`.

### API3 — Broken Object Property Level Authorization
* Responses are built by explicit DTO mappers (`modules/users/user.mapper.ts`): a new database column can never leak by accident.
* Requests use strict schemas: `role`, `gems`, `isBanned`, `followersCount` … are rejected with 422, not ignored.
* Settings: secrets are AES-256-GCM encrypted at rest and returned masked (`modules/settings/settings.service.ts`); the public bundle is an explicit allow-list.
* Tests: `social.test.ts` "shows a public profile without private fields", `settings.test.ts` "exposes only the public subset — never a secret", `admin.test.ts` "edits profile fields (whitelist)".

### API4 — Unrestricted Resource Consumption
* Global / user / auth / sensitive / upload / admin rate-limit policies; Redis-backed when `REDIS_URL` is set.
* JSON body limit, upload size limits, magic-byte image sniffing, Socket.IO `maxHttpBufferSize` and per-event budgets.
* Cursor pagination with a hard page cap; admin tables capped at 100; exports and backups **stream** instead of buffering.
* Idempotency keys stop retry storms from repeating expensive or paid actions.
* Tests: `gateway.test.ts` (429, 413), `realtime.test.ts` (rate-limited socket events, oversized frames), `pagination.test.ts`, `admin.test.ts` (NDJSON export).

### API5 — Broken Function Level Authorization
* `RouteRegistry.add` refuses a route without an explicit `auth` mode; admin routes additionally honour an IP allow-list, an admin rate-limit and the API-key level cap (a `mobile` key can never reach an admin route, even with an admin token).
* `authz-matrix.test.ts` iterates the live registry: anonymous → 401, user/guest → 403, admin → passes the gate, for **every** admin route; guests are excluded from user routes unless listed.
* Admin actions cannot target admins or the caller themself (`admin-users.service.ts` → `guardTarget`).

### API6 — Unrestricted Access to Sensitive Business Flows
* Gems move only through `GemService` (guarded `$inc`, immutable ledger, transactions when available): `gems.test.ts` proves 20 parallel spends of 10 against 100 gems succeed exactly 10 times.
* Gifts and VIP take their price from the database, require an `Idempotency-Key`, and compensate on failure (`economy.test.ts`).
* Purchases are fulfilled exactly once per gateway transaction (unique index + ledger reference) and self-heal after a crash (`payments.test.ts`).
* One like per person, follow is idempotent, report de-duplication, contact-form reCAPTCHA, guests cannot buy/gift/follow.

### API7 — Server Side Request Forgery
* No endpoint fetches a user-supplied URL. Avatars are uploaded as files (type-sniffed) or taken as an https URL from the verified identity token and **stored, never fetched**. v1's `ip-api.com` call and avatar download were removed; country comes from the CDN header.
* Outbound calls go to fixed vendor hosts (Stripe, PayPal, Razorpay, Google, Apple, Twilio, Metered, Xirsys) with timeouts (`modules/payments/providers/http.ts`).
* Redirect URLs for payments are validated against an origin allow-list (`payment.service.ts` → `resolveReturnBase`).

### API8 — Security Misconfiguration
* `config/env.ts` fails fast on missing/placeholder secrets, non-HTTPS production URLs, wildcard CORS, bad encryption keys.
* helmet with a locked-down CSP, CORS allow-list, `trust proxy` never `true`, no `X-Powered-By`, `Cache-Control: no-store` on API responses, errors never leak internals, request bodies are never logged (v1 logged settings including secrets — L12), log redaction paths.
* Tests: `env.test.ts`, `gateway.test.ts` "security & transport".

### API9 — Improper Inventory Management
* One versioned prefix; the OpenAPI document is generated from the route registry and snapshot-tested (`openapi.test.ts`), so documentation cannot drift. v1's unversioned and duplicated routes (`/languages` twice, `/api/purchases`) are gone.
* Installer routes are available only while the app is uninstalled (`install.service.ts`), and never delete data (L8).

### API10 — Unsafe Consumption of APIs
* Every third-party call has a timeout; vendor failures become 502 (or a documented degradation, e.g. ICE → public STUN).
* Payment confirmations are verified against the gateway (signature, order state, amount, owner) and webhooks are authenticated (Stripe signature, PayPal verify API, Razorpay HMAC) — never trusted from the client (`payment.types.ts` explains the contract).
* Receipts: Google Play product/package must match the pack; App Store transaction must match the configured product and must not be cancelled.
* Tests: `payments.test.ts` (tampering, foreign sessions, bad signatures), `ice-presence.test.ts` (vendor outage fallback).

## Legacy findings → resolution

| # | Legacy problem | Resolution | Pinned by |
|---|---|---|---|
| L1 | Login auto-creates accounts for any password | explicit `register`; login never creates | `auth.test.ts` "L1 regression" |
| L2 | Public/partial-role admin settings read | admin-only masked read; public bundle allow-list | `settings.test.ts`, `authz-matrix.test.ts` |
| L3 | `req.body` written into settings | strict per-group schemas | `settings.test.ts` "rejects unknown fields" |
| L4 | Client-supplied prices/gem amounts | prices from DB; strict bodies reject `cost`/`price` | `economy.test.ts`, `payments.test.ts` |
| L5 | Read-modify-write balances | guarded atomic `$inc` + ledger | `gems.test.ts` race test |
| L6 | Identity from request body; unauthenticated delete | identity from token; ownership by construction | `chat.test.ts`, `authz-matrix.test.ts` |
| L7 | Socket events trusted client `userId`; module-level state | handshake auth; queue/session ports (Redis-ready) | `realtime.test.ts`, `matching.test.ts` |
| L8 | Installer could wipe users | one-shot claim; never deletes | `backup-install.test.ts` "installer" |
| L9 | Backup restore wiped/inserted unvalidated | streamed export, schema-validated dry-run-first restore | `backup-install.test.ts` |
| L10 | `cors: *`, no helmet/limits/compression | see API4/API8 | `gateway.test.ts` |
| L11 | N+1 queries, unbounded lists | batched lookups, cursor pagination | `chat.test.ts` "no N+1", `admin.test.ts` reports |
| L12 | Logged request bodies; external license call | redacted structured logs; license call removed | `logger-id-clock.test.ts` |
| L13 | Hard-coded package name / PayPal sandbox | configuration | `payments.test.ts` |
| L14 | Dead/undefined helper code | removed | typecheck + lint in `npm run verify` |
