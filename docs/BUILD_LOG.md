# Build log

Evidence log for the Day 1 risk spike. Every check is **PASS**, **FAIL** or **PENDING**, with evidence such as order ids, PayPal `debug_id`s, commit hashes and screenshots. Times are UTC.

## Status board

| ID | Check | Status | Evidence |
| --- | --- | --- | --- |
| P0 | Scaffold builds, starts, serves `/health`; unit tests green | **PASS** | Session 1: 68 tests passing (`npm test`); `npm run build` then `npm start` served `/health` 200; `PAYPAL_ENV=live` refused to start (exit 1, secret not echoed). |
| T1a | Money path: create, buyer approves in sandbox, server captures | **PASS** | Session 2, 14:05:56 UTC, `money-path` against `https://hackapal.onrender.com` (free plan, commit `90e3384`): `ord_jab40wv2dyyn` / PayPal `5RV89033GE8513535`, $12.00, `CREATED -> COMPLETED`, capture `4VC692588D376791G`. First approval attempt never reached PayPal (order stayed `PAYER_ACTION_REQUIRED`); the retry with the sandbox **personal** account worked. |
| T1b | Webhook arrives on Render and its signature verifies | **PASS** | Same order. Verified via `verify-webhook-signature`: `PAYMENT.CAPTURE.COMPLETED` `WH-8X6006461P224354H-0JK1246097384671E` (PayPal time 14:06:00, received 14:06:23) and `CHECKOUT.ORDER.APPROVED` `WH-2X611071MF8140702-8S364688956061725` (received 14:06:09, after the capture, so correctly a no-op). Webhook `1BT95182K4694261A` is subscribed to ~65 event types; trim to the three we handle. |
| T1c | Simulated `INSTRUMENT_DECLINED` goes to `NEEDS_NEW_FUNDING`, buyer re-approves, order reaches `COMPLETED` | **PASS** | Session 2, 14:09 UTC, `money-path --simulate-decline` on Render: `ord_8qdmwz20y7jn` / PayPal `8A37379456997943K`, path `CREATED -> NEEDS_NEW_FUNDING` (14:08:46) `-> COMPLETED` (14:09:01) after the buyer re-approved; capture `1CT929250U3943106`. Verified webhooks: two `CHECKOUT.ORDER.APPROVED` (one per approval; the one arriving during `NEEDS_NEW_FUNDING` was ignored as designed) and `PAYMENT.CAPTURE.COMPLETED` `WH-9VX27225X5129983A-9PU583963C394941H`. |
| T2a | `mcp-smoke` against local and deployed `/mcp`: tools listed, `create_order` returns a real approval link | **PASS (local)**, deployed PENDING | Session 2, ~14:10 UTC, built server on localhost with real sandbox credentials: tools `list_products, create_order, get_order_status`; `create_order` made `ord_dsewwn9nqznp` / PayPal `7HW025580S139021M`, $12.00, real `www.sandbox.paypal.com` approval link; `get_order_status` = `CREATED`. Deployed run waits for the merge to `main` (Render deploys `main`). |
| T2b | claude.ai connector end to end: "buy 2 boxes of cookies from Auntie's Kitchen", total shown, link handed over, approved, `COMPLETED` confirmed via `get_order_status` | PENDING | |
| P4 | PayPal sandbox MCP tool list without and with `x-feature-flags: commerce:true` | **PASS** (probe ran) | Session 2, 12:45 UTC, `npm run probe-paypal-mcp`: a plain client-credentials REST token works as `Bearer` on `https://mcp.sandbox.paypal.com/sse` (server "PayPal MCP Agent 1.0.0"). 46 tools both times; the commerce flag adds nothing; `search_product`, `create_cart`, `checkout_cart` absent. Streamable HTTP `/mcp` answers 404 to an authenticated POST. See "Phase 4 probe result". |
| S5 | Telegram seller ping on a completed capture (optional) | PENDING | |

## Sponsor tools used

Record every real use: date, tool, what was asked, what it said, and which code or decision it changed (commit). Judges for the sponsor prizes will look here.

### PayPal AI Toolkit (`paypal-best-practices` skill)

- **Session 1 (2026-11-01):** not used yet. The PayPal plugin (source `github.com/paypal/ai-toolkit`) is in the Claude plugin directory but was not enabled in this session. Baim is enabling it for session 2. No PayPal code was written before it is available, as the brief requires.
- **Session 2 (2026-11-01, ~12:40 UTC): vendored and read.** The plugin still wasn't loaded (`ListPlugins` / `SearchSkills` for "paypal" returned nothing). Per Baim's decision the skill is now vendored, unmodified, from `paypal/ai-toolkit` commit `1401791` into `.claude/skills/paypal-best-practices/` with its Apache-2.0 `LICENSE` and a `SOURCE.md` (commit `43705ce`). Read before writing PayPal code: `SKILL.md` (routing table, pre-delivery checklist), `references/checkout.md`, `authentication.md`, `webhooks.md`, `webhook-sandbox.md`, `mcp-tools.md`, `agentic-commerce.md` and the error table in `js-sdk-v6.md`. What it said and what it changed:
  - Read `expires_in` from the token response (up to 8 h), cache, refresh proactively. -> `src/paypal-auth.ts` keeps one token until 5 minutes before its own `expires_in`.
  - `PayPal-Request-Id` on every POST, same value on retries; 429 gets exponential backoff using `Retry-After`; log `debug_id` from every error. -> Matches our rules; the SDK retry config below honours `Retry-After`.
  - `INSTRUMENT_DECLINED` (422): ask the buyer for another funding source, never auto-retry the same instrument. -> No automatic capture retry; status `NEEDS_NEW_FUNDING` and the buyer is sent back to the same approval link.
  - Webhooks: pass the five `PAYPAL-*` headers plus the raw body exactly as received (re-serialising breaks it); return 200 fast and process asynchronously (PayPal retries after 30 s); dedupe by event `id`; subscribe to explicit event types, not `*`. -> Matches the Phase 1 webhook design.
  - **Fidelity gap:** events from `simulate-event` or the Dashboard Webhooks Simulator carry the literal `webhook_id` `"WEBHOOK_ID"` and can never pass `verify-webhook-signature`. -> T1b must be proven with a real sandbox capture (or `POST /v1/notifications/webhooks-events/{id}/resend` of a real event). A simulator delivery is not evidence.
  - Sandbox webhook delivery takes ~10 s to 75 s+. -> `money-path` waits long enough before calling a webhook missing.
  - `mcp-tools.md` confirms `search_product`, `create_cart` and `checkout_cart` are remote-only and need `x-feature-flags: commerce:true`. -> Used by the P4 probe.
  - `agentic-commerce.md`: Agent Ready uses Braintree delegated payment tokens and is early-access. -> Confirms the wedge: we use plain Orders v2 with a human approving in PayPal, no delegated tokens.
  - **Gap:** the skill doesn't cover `PayPal-Mock-Response` negative testing; that comes from PayPal's REST docs plus ContextMatic (below).

### APIMatic Context Plugin (ContextMatic)

- **Session 1 (2026-11-01):** not used yet. It is a remote MCP server at `https://chatbotapi.apimatic.io/mcp/plugins` and requires an OAuth sign-in (an unauthenticated request returns 401, with protected-resource metadata naming `https://chatbotapi.apimatic.io` as the authorization server, scope `mcp:tools`). Baim is adding it as a claude.ai custom connector for session 2. Worth noting for the write-up: `@paypal/paypal-server-sdk` is itself APIMatic-generated (it depends on `@apimatic/core`).
- **Session 2 (2026-11-01, ~12:45 UTC): used before any PayPal code.** Connector available as `ContextMatic_APIMatic`. Calls: `fetch_api(typescript, "paypal")` -> "PayPal Server SDK"; 7 `ask` calls (3 returned a tool error and were split into smaller questions); `endpoint_search("getOrder")` (returned GetOrder, ConfirmOrder, CreateOrder, CaptureOrder); `model_search` for `PaypalWalletExperienceContext`, `PurchaseUnitRequest`, `ItemRequest`, `CustomError`; `update_activity(sdk_setup)` after installing `@paypal/paypal-server-sdk` 2.5.0. What it said and what it changed:
  1. **Orders:** `new OrdersController(client)`; `createOrder({ body, paypalRequestId, prefer })`, `getOrder({ id })`, `captureOrder({ id, paypalRequestId, paypalMockResponse, prefer })`. Bodies use camelCase models (`purchaseUnits`, `unitAmount`, `customId`, `paymentSource.paypal.experienceContext` with `brandName`, `userAction`, `shippingPreference`, `returnUrl`, `cancelUrl`); item `quantity` is a string. -> `src/paypal.ts` uses the SDK for all three Orders calls.
  2. **Per-request headers:** no generic header hook, but the Orders methods take `paypalMockResponse`, which is sent as `PayPal-Mock-Response`. -> The simulated decline goes through the SDK; no `fetch` fallback needed for it.
  3. **Token:** the SDK fetches and refreshes on its own, and `clientCredentialsAuthCredentials` accepts `oAuthTokenProvider(lastToken, authManager)`, `oAuthOnTokenUpdate` and `oAuthClockSkew`. -> We plug our own cache into `oAuthTokenProvider`, so the SDK and our `fetch` calls (webhook verification, not in the SDK) share one token.
  4. **Retries:** `maxNumberOfRetries` defaults to 0 and `httpMethodsToRetry` to GET and PUT, so **POST is not retried by default**. -> We first enabled POST retries in the SDK, then measured (correction (d) below) and moved retries into our wrapper instead.
  5. **Errors:** Orders failures throw `CustomError` (extends `ApiError`: `statusCode`, `headers`, `body`, `result`). -> Our error mapper reads those.
  - **Corrections from reading the installed source** (`@apimatic/core` 0.10.30), worth telling APIMatic: (a) `retryConfig.maximumRetryWaitTime` defaults to 0 and is the *total* wait budget, so with the defaults no retry ever happens even after raising `maxNumberOfRetries`. `Retry-After` is honoured. (b) ContextMatic described the error field as `debugId`, but `CustomError.result` is the raw JSON body, so it's `result.debug_id` (and `details[].issue`). (c) The SDK keeps the last token as a promise; if a token fetch ever rejects, every later call on that client rejects too (verified with a throwaway script: a provider that fails once, then three `getOrder` calls, all three fail with the first error and the provider is never called again). Our wrapper fetches the token itself before each SDK call and rebuilds the client after a non-HTTP failure. (d) **Retrying declared errors:** the request pipeline runs auth -> retry -> error mapping, so every *declared* error status (for capture: 400, 401, 403, 404, 422, 500) is thrown inside the retry loop and retried like a timeout when `retryOnTimeout` is true (its default). Measured live in sandbox: a `getOrder` 404 took 8.7 s with retries enabled (three extra calls) versus 0.75 s with them off, and a capture 422 took 9.3 s. A declined buyer would wait about 9 s, and the decline would be attempted four times. **Fix (commit `44e6343`):** SDK retries are off (`maxNumberOfRetries: 0`, `retryOnTimeout: false`); `PayPalClient` retries 429, 5xx and network errors itself with the same `PayPal-Request-Id` and `Retry-After`, never 4xx. Re-measured: 404 in 0.78 s, 422 in 0.52 s.

## Design decisions

Agreed in the session 1 plan review. They refine the brief where it would break or make the demo flaky.

1. **Capture idempotency key per attempt.** The capture `PayPal-Request-Id` is `capture-<orderId>-<attempt>`, where the attempt is `Order.captureAttempts` and increases after each decline. PayPal's idempotency docs say two *simultaneous* requests with the same id can make the second fail, and they don't define what a repeated id returns after a 422. So the return page and the webhook share one in-process capture call per order (single-flight), and a retry after a decline gets a fresh key.
2. **Simulated decline is one-shot and per order** (`Order.simulateDecline`, cleared after the first capture attempt). A global switch would decline the retry forever, and the `CHECKOUT.ORDER.APPROVED` webhook could capture without the mock first.
3. **Two extra statuses.** `PAYMENT_PENDING` (capture returned PENDING) and `FAILED` (`PAYMENT.CAPTURE.DENIED`, or the order can't be paid any more) join the brief's five. Only `COMPLETED` and `FAILED` are final. `CANCELLED` is not final, because the buyer can still reopen the link while the PayPal order is valid.
4. **`money-path` drives our server over HTTP**, not PayPal directly. Each process has its own in-memory store, so a script talking to PayPal directly would trigger webhooks on a server that has never heard of the order. Needs a small internal API (`/api/orders`) that shares the service code with the MCP tools.
5. **Test 1 is split.** The webhook check (T1b) needs a public URL, so it can only pass after the Render deploy.
6. **The commerce probe doesn't change the architecture.** PayPal's blog says `search_product`, `create_cart` and `checkout_cart` cover gift cards from PayPal's own catalog, not merchant catalogs. It's still worth running for the pitch.
7. **Node 22 LTS.** Node 20 reached end of life in April 2026. `engines` allows 20.12 or newer (needed for `process.loadEnvFile`), and Render is pinned to 22 via `.node-version`.
8. **Strategic risk.** PayPal already ships *Agent Ready* (existing merchants take payments from AI agents) and *Store Sync* (merchant catalogs from platforms like Wix and BigCommerce into AI agents, US and USD only, by request). Our wedge has to be sellers with no platform at all.

Added in session 2, while building Phase 1:

9. **The capture attempt also goes up after any 4xx**, not only after a decline (refines 1). PayPal may answer a repeated `PayPal-Request-Id` with the stored result, so a capture that got `ORDER_NOT_APPROVED` must not reuse its key once the buyer has approved. Network errors and 5xx keep the key, so a retry can't capture twice.
10. **After a decline, only the buyer captures again.** The order waits in `NEEDS_NEW_FUNDING` until the buyer comes back through `/paypal/return` (or someone calls `POST /api/orders/:id/capture`). `get_order_status` reconciliation and a late `CHECKOUT.ORDER.APPROVED` webhook don't capture, because PayPal still reports the old approval. With the mock, an automatic capture would succeed without the buyer re-approving, and T1c would pass for the wrong reason.
11. **Retries live in our code, not the SDK** (see ContextMatic correction (d)): the SDK retries every declared 4xx as if it were a timeout.
12. **`PUBLIC_BASE_URL` falls back to `RENDER_EXTERNAL_URL`**, which Render sets on every web service, so the return URL is right on the first deploy.
13. *(Superseded by 14 for now.)* **Render plan id `0.5c-512mb`.** The current Blueprint spec lists size-based ids; that is the old "Starter" size (0.5 CPU, 512 MB).
14. **We're on Render's free plan for now** (Baim, 2026-11-01: the paid size made Render ask for a card). What that means:
    - The service sleeps after about 15 minutes without inbound traffic. The first request after that takes about a minute while it wakes. Render may also restart a free service at any time.
    - A restart or sleep wipes the in-memory order store (and the webhook dedupe memory). Orders created before it are gone, and their late webhooks are logged as "unknown order" and ignored.
    - **During tests, approve payments within a few minutes** of creating the order, and don't push to the deployed branch mid-test (auto-deploy restarts the service).
    - A PayPal webhook that hits a sleeping service waits for the wake-up. If PayPal gives up first, it redelivers later. That's safe: events are deduped by id, and status changes are idempotent (see "Webhook retries" in the session 2 follow-up).
    - **Before judging (Dec 2 to 16):** move the order store to Supabase, and either add an uptime pinger on `/health` or switch to the paid size with the Render hackathon credit (`plan: 0.5c-512mb`, the old "starter"). A pinger that keeps the service awake 24/7 uses about 720 to 744 of the workspace's 750 free hours a month, so it only works for this one service. If the hours run out with no card on file, Render suspends every free service for the rest of the month.

Assumptions (change them if wrong):

- `shipping_preference: NO_SHIPPING`. Fulfilment is pickup or local delivery arranged after payment.
- Quantity is 1 to 10 per product, after duplicate lines are merged.
- Stock is checked when an order is created and taken when its capture completes. Taking stock clamps at zero and reports any oversell.
- `get_order_status` reconciles with PayPal: if PayPal says APPROVED and we haven't captured, it captures (except in `NEEDS_NEW_FUNDING`, see decision 10). A lost webhook can't strand a buyer who clicked "Pay Now".
- Webhook handlers never move an order backwards. A late `CHECKOUT.ORDER.APPROVED` after `COMPLETED` does nothing.
- `/mcp` has no authentication for now. That's acceptable in sandbox only, and must change before any real money.

## Environment findings (session 1, 2026-11-01)

- **PayPal sandbox API is reachable** from the Claude Code cloud container. `POST /v1/oauth2/token` without credentials returned 401 `invalid_client` (`paypal-debug-id: f190520033768`).
- **PayPal sandbox MCP server** answers at both `https://mcp.sandbox.paypal.com/sse` and `https://mcp.sandbox.paypal.com/mcp`. Both return 401 with OAuth protected-resource metadata (authorization server `https://mcp.sandbox.paypal.com`). Open question for P4: does it accept a plain REST client-credentials token as `Bearer`?
- **Idempotency** ([PayPal docs](https://developer.paypal.com/api/rest/reference/idempotency/)): a repeated `PayPal-Request-Id` returns the latest status of the earlier request; simultaneous duplicates may fail; behaviour after error responses isn't documented.
- **Commerce tools** ([PayPal blog](https://developer.paypal.com/community/blog/expanding-paypal-mcp-capabilities)): gift cards only for now; the documented header is `x-feature-flags: commerce:true`.
- **Versions chosen (2026-11-01):** express 5.3, zod 4.6, typescript 7.0 (native compiler), vitest 5.0, tsx 4.23. For Phases 1 and 2: `@paypal/paypal-server-sdk` (2.5.0 is latest) and `@modelcontextprotocol/sdk` (1.32.2 is latest).
- **Windows:** the lockfile includes the win32-x64 native binaries (esbuild, rolldown, TypeScript 7), so `npm ci` should work on Baim's machine. If it ever complains about a missing native binding, run `npm install` once to repair it.

## Phase 4 probe result (session 2, 2026-11-01 12:45 UTC)

`scripts/probe-paypal-mcp.ts` gets a sandbox token with our app's client credentials, then lists tools on both transports, with and without `x-feature-flags: commerce:true`.

- **Auth:** the plain REST token is accepted as `Bearer` on the SSE endpoint, no OAuth dance needed (session 1's open question). That matches PayPal's own AI Toolkit `.mcp.json`.
- **SSE, no flag:** 46 tools. Orders: `create_order`, `get_order`, `pay_order`. Catalog: `create_product`, `list_products`, `show_product_details`, `update_product`. The rest cover invoices (17 tools), subscriptions and recurring series, disputes, refunds, shipment tracking, `list_transactions` and `get_merchant_insights`.
- **SSE, with the commerce flag:** the same 46 tools. **`search_product`, `create_cart`, `checkout_cart` are not exposed** for our sandbox app, so the header is not enough on its own. That fits the blog post (gift-card catalog, by request).
- **Streamable HTTP (`/mcp`):** 404 Not Found on the initialize POST, with or without the flag. Only SSE is live for us.
- **What it means for the pitch:** PayPal's MCP server gives the *merchant's* agent tools to run the merchant's own PayPal account (create an order, list my products, invoices). hackapal is the other side: it lets a *buyer's* agent shop a seller who has no website or platform, with PayPal approval as the human checkpoint. No architecture change, as design decision 6 expected.

## Screenshots to take

- [ ] PayPal sandbox checkout showing "Auntie's Kitchen" and $12.00
- [ ] Our "Payment complete, you can go back to your assistant." page
- [ ] Simulated decline: PayPal asking for another funding source
- [ ] PayPal developer dashboard: webhook delivery for `PAYMENT.CAPTURE.COMPLETED` with HTTP 200
- [ ] Render logs: webhook verified, and a `debug_id` line on an error
- [ ] MCP Inspector listing our three tools
- [ ] claude.ai conversation: tool calls, total shown, link handed over, `COMPLETED` confirmed
- [ ] Probe output with and without the commerce flag
- [ ] Telegram ping (if Phase 5 happens)

## Session log

### Session 1 (2026-11-01): plan review and Phase 0

- Inspected the repo: one commit, README with only a title, **no LICENSE** (the hackathon needs MIT), so one was added.
- Phase 0 on branch `day1-spike`, in small Conventional Commits: MIT license and `.gitignore`; TypeScript/Express scaffold with zod config (sandbox guard), logger and `/health`; the Auntie's Kitchen catalog with pricing in integer cents; the in-memory order store; docs.
- Verified: typecheck clean, 68 unit tests passing, production build starts and serves `/health`, invalid config refuses to start.
- Deliberately not done: any PayPal code. Per the brief it waits until the sponsor tools are available (session 2).

### Session 2 (2026-11-01, 12:32 to ~13:10 UTC): sponsor tools, Phase 4, Phase 1, render.yaml

- **Branch:** `claude/pensive-faraday-ina38x` (PR #1 from `day1-spike` had already been merged into `main`). Baim's decisions are recorded under "Handoff to session 2".
- **Environment:** `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_ENV` present (values not printed); `PAYPAL_WEBHOOK_ID` not set yet (expected).
- **Sponsor tools:** PayPal skill vendored and read; ContextMatic used for the SDK questions; both logged above with what they changed.
- **Dependencies:** `@paypal/paypal-server-sdk` 2.5.0 and `@modelcontextprotocol/sdk` 1.32.2 both work with zod 4.6 and TypeScript 7.0. No pin-back needed.
- **Phase 4:** done in about 3 minutes, result above (P4).
- **Phase 1 code:** `src/paypal-http.ts`, `src/paypal-auth.ts`, `src/paypal.ts`, `src/orders.ts`, `src/paypal-routes.ts`, `src/api-routes.ts`, `src/pages.ts`, `scripts/money-path.ts`. Tests: 137 passing (68 new: `orders` 25, `paypal` 16, `routes` 12, `paypal-http` 9, `paypal-auth` 6; plus 1 new config test). They cover request ids, retry/backoff, `Retry-After`, the token cache, `debug_id` logging, the verify payload containing the raw body byte for byte, single-flight capture, decline recovery, webhook dedupe and never-backwards.
- **Live sandbox checks from the container** (no buyer approval needed):
  - 12:49 UTC, SDK directly: order `4XH687100W6322708` created (status `PAYER_ACTION_REQUIRED`, `payer-action` link on `www.sandbox.paypal.com`, `custom_id` round-trips). The same `PayPal-Request-Id` returned the same order. Capture before approval: 422 `ORDER_NOT_APPROVED`, `debug_id f93639164818b`. Unknown order: 404 `INVALID_RESOURCE_ID`, `debug_id ca53b053ebecf`. One token fetch for all of it.
  - 12:57 UTC, built server (`node dist/server.js`) over HTTP: `POST /api/orders` created `ord_ac3qt4qygfz4` (PayPal `6U09316128118382V`, $12.00). `/paypal/return` before approval showed "Payment not approved yet" (422 `ORDER_NOT_APPROVED`, `debug_id f809132666479`). `/paypal/cancel` moved it to `CANCELLED`. The webhook without `PAYPAL_WEBHOOK_ID` answered 503. Shutdown was clean.
  - SDK retry bug found and fixed (ContextMatic correction (d)): PayPal errors went from about 9 s to 0.5-0.8 s.
- **Phase 3:** `render.yaml` written. Next step needs Baim (Render and PayPal dashboards), see "Handoff to session 3".

### Session 2 follow-up (2026-11-01, after PR #2 merged): free plan, `/health`, webhook retries

- **Branch** restarted from the merged `main` (`26d8460`), same name. `render.yaml` switched to `plan: free` (`64ca87b`); everything else unchanged. Render's docs list no free-plan limits on the region, health check, build/start commands or env vars. See design decision 14.
- **`/health` after a cold start:** the handler is synchronous and does no I/O (no PayPal, no store). Measured from spawning `node dist/server.js` to the first `/health` 200: 726, 349 and 372 ms over three runs. The first response took 8-20 ms, later ones about 4 ms. Importing the PayPal SDK (about 250 ms) is the largest share of startup. The roughly one-minute wake on the free plan is Render starting the instance, not the app. New test: `/health` answers while every PayPal call hangs.
- **Webhook retries:**
  1. PayPal redelivers only when it doesn't get a 2xx. We answer 503 when verification is unavailable or `PAYPAL_WEBHOOK_ID` is unset, and 400 for a bad signature or JSON. The event id is remembered only after verification, so a redelivery after a 503 is processed normally.
  2. Dedupe by event id is implemented, not just planned (`OrderService.handleWebhookEvent`, in memory, last 5000 ids). The check and the insert happen with no `await` in between, so two concurrent deliveries of one event can't both get through.
  3. Even without that memory (a free-plan restart), the handlers are idempotent: statuses never move backwards, stock and the seller ping happen only on the move to `COMPLETED`, and capture is single-flight with a stable request id.
  4. Hardened: the verify call's `PayPal-Request-Id` was `verify-<transmission_id>`, a value the sender chooses. It is now random per delivery, so a stored verification result can never be replayed for another delivery.
  - New tests: a redelivered event answered 200 twice but processed once; the same capture under a new event id takes stock once; a fresh verify request id per delivery. 141 tests passing.

## Handoff to session 3

State: Phase 1 code is done and unit-tested. T1a, T1b and T1c need the Render deploy. Phase 2 (MCP) hasn't started.

1. Baim deploys the Blueprint and sets up the sandbox webhook (steps in the session 2 chat and in `README.md` "Deploy to Render").
2. Check `https://<service>.onrender.com/health`: expect `credentialsConfigured: true` and `webhookConfigured: true`.
3. T1a + T1b: `npm run money-path -- --base-url https://<service>.onrender.com`. Baim approves as the sandbox **buyer**. Expect `CREATED -> COMPLETED`, a capture id, and `webhook verified: PAYMENT.CAPTURE.COMPLETED` within about 2 minutes.
4. T1c: the same with `--simulate-decline`. Expect `CREATED -> NEEDS_NEW_FUNDING -> COMPLETED` after Baim approves a second time.
5. Then Phase 2 (`/mcp`, three tools, `mcp-smoke`), T2a, and T2b with Baim.

## Handoff to session 2

### Decisions from Baim (session 2, 2026-11-01, 12:37 UTC)

These override anything below that disagrees with them.

0. **Branch.** `day1-spike` is retired (PR #1 was merged into `main`). Work happens on `claude/pensive-faraday-ina38x`, with a new draft PR from it.
1. **Missing tools don't block work.** Only the APIMatic plugin is a sponsor-prize requirement; the PayPal skill is not. If a tool is missing: tell Baim in one line, log it here, and continue with PayPal's REST docs.
2. **The PayPal skill is vendored** so every session has it: `skills/paypal-best-practices` (with `references/`) from `github.com/paypal/AI-Toolkit` is copied into `.claude/skills/paypal-best-practices/`, with its Apache-2.0 license and a source note. Read it and ask ContextMatic the SDK questions, and log both, before writing the Orders and webhook code.
3. **Order of work:** Phase 4 probe (15 minutes max; try the client-credentials token as `Bearer` first, which is what PayPal's own AI Toolkit `.mcp.json` does) -> Phase 1 code and tests -> Phase 3 `render.yaml`, then stop and walk Baim through the Render deploy and webhook setup -> T1a, T1b and T1c against the Render URL -> Phase 2 -> T2a -> T2b with Baim. Reason: the cloud container isn't reachable from Baim's browser, so return URLs and webhooks need the public URL anyway.
4. **Dependency fights:** if the MCP SDK or the PayPal SDK fights zod 4 or TypeScript 7, pin back (zod 3 or TypeScript 5.x) instead of debugging, and log it.
5. **Timebox:** if one blocker takes more than 30 minutes, stop, log it and tell Baim.

### Original handoff (session 1)

Paste this into the new session:

> Continue the hackapal Day 1 spike on branch `day1-spike` (there is a draft PR from it). Read `CLAUDE.md` and the "Handoff to session 2" section of `docs/BUILD_LOG.md` first. Phase 0 is done. Check that the paypal-best-practices skill and the APIMatic ContextMatic connector are available and that the `PAYPAL_*` env vars are set (don't print them). Use both tools before writing PayPal code and log it in the build log. Then run the Phase 4 probe, then Phases 1 and 2. Stop when you need me to approve a sandbox payment.

### First steps

1. **Check the tools.** Look for the PayPal plugin's `paypal-best-practices` skill and the ContextMatic connector tools (expected: `fetch_api`, `ask`, `endpoint_search`, `model_search`, ...). If either is missing, stop and tell Baim. Don't silently fall back.
2. **Check the environment.** `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_ENV=sandbox` must be present. Check presence only; never print values.
3. **Git.** Work on `day1-spike` (`git fetch origin day1-spike`, then check it out), not the session's default branch. Small Conventional Commits; push to `day1-spike`.
4. **Sponsor tools before PayPal code.** Ask ContextMatic how `@paypal/paypal-server-sdk` 2.x handles: orders create/get/capture; per-request custom headers (for `PayPal-Mock-Response`); plugging in our own OAuth token cache (token provider hook); retry configuration (check whether POST is retried by default; we want it retried, since every POST carries a `PayPal-Request-Id`); how errors expose `debug_id`. Read `paypal-best-practices` for Orders v2, webhooks and negative testing. Log each use above under "Sponsor tools used".
5. **Phase 4 probe early.** It's cheap, independent, and only needs credentials.

### Remaining spec (condensed from the brief, so nothing depends on chat history)

**Phase 1: money path (Test 1)**

- `src/paypal.ts`: token cache (refresh shortly before expiry), `createOrder`, `getOrder`, `captureOrder`, `verifyWebhook`. Use the SDK for Orders where it covers the call; use `fetch` for webhook verification and the sandbox mock header if the SDK can't send it. `PayPal-Request-Id` on every POST, retry 429/5xx with backoff, log `debug_id` on every error, no deprecated APIs.
- `createOrder`: `intent: CAPTURE`; one purchase unit with items (name, quantity, `unit_amount`, `category: PHYSICAL_GOODS`) and `amount.breakdown.item_total`; `custom_id` set to our order id; `payment_source.paypal.experience_context` with `brand_name: "Auntie's Kitchen"`, `user_action: PAY_NOW`, `shipping_preference: NO_SHIPPING`, `return_url: ${PUBLIC_BASE_URL}/paypal/return`, `cancel_url: ${PUBLIC_BASE_URL}/paypal/cancel`. Approval link is `rel: payer-action`, falling back to `approve`. Request id: `create-<orderId>`. Amounts come from `priceCart` only and are converted with `toDecimalString`.
- `GET /paypal/return?token=<paypalOrderId>`: single-flight capture with `capture-<orderId>-<attempt>`, update the store, show a small HTML page: "Payment complete, you can go back to your assistant." On 422 `INSTRUMENT_DECLINED`: status `NEEDS_NEW_FUNDING`, increase `captureAttempts`, redirect (302) the buyer to the same `approvalUrl`.
- `GET /paypal/cancel`: mark `CANCELLED` (never over a final status), show a friendly page.
- `POST /webhooks/paypal`: `express.raw()` on this route only. Verify via `POST /v1/notifications/verify-webhook-signature`, splicing the raw body in **unmodified** as `webhook_event` (re-serialised JSON can fail verification). Dedupe by event id. Return 200 as soon as it's verified, then process: `CHECKOUT.ORDER.APPROVED` (capture if not yet captured, respecting `simulateDecline`), `PAYMENT.CAPTURE.COMPLETED` (`COMPLETED`, take stock, seller ping), `PAYMENT.CAPTURE.DENIED` (`FAILED`). Never move an order backwards.
- Sandbox decline switch: when `order.simulateDecline` is set, send `PayPal-Mock-Response: {"mock_application_codes": "INSTRUMENT_DECLINED"}` on that capture call only, then clear the flag.
- Internal API for scripts: `POST /api/orders` (`{ items, simulate_decline? }`, the latter honoured only in sandbox), `GET /api/orders/:id` (refreshes from PayPal if not final), `POST /api/orders/:id/capture`.
- `scripts/money-path.ts [--base-url http://localhost:3000] [--simulate-decline]`: create an order for 2 x `choc-chip-cookies`, print the approval link, poll while Baim approves as the sandbox buyer; if it's approved but not captured after a while, ask the server to capture; print the final status and capture id.
- Tests: pricing is covered already. Add PayPal client tests with mocked `fetch`: request ids, retry/backoff, token cache, `debug_id` logging, and the verify payload containing the raw body byte for byte.

**Phase 2: robot door (Test 2)**

- `POST /mcp`: Streamable HTTP, stateless (a new server and transport per request, `sessionIdGenerator: undefined`). Check the current SDK README for the exact pattern. `GET` and `DELETE /mcp` return 405.
- Tools, zod-validated, with descriptions written for an AI agent:
  - `list_products`: shop name, products, USD prices, stock.
  - `create_order({ items: [{ product_id, quantity }] })`: prices only from our catalog (reuse `CartInputSchema`). Returns our order id, itemised total and the approval link. The description must tell the agent to confirm items and total with the buyer first, that only the human can pay by opening the link, and never to claim payment is done.
  - `get_order_status({ order_id })`: refresh from PayPal if not final. Returns a status from `ORDER_STATUSES` in `src/store.ts`. The agent may only say "paid" on `COMPLETED`.
- `scripts/mcp-smoke.ts <url>`: connect as an MCP client, list tools, call `list_products` and `create_order`, print the approval link.
- Tell Baim how to test locally with MCP Inspector (`npx @modelcontextprotocol/inspector`, transport Streamable HTTP, URL `http://localhost:3000/mcp`).

**Phase 3: deploy to Render**

- `render.yaml`: one Node web service, region `singapore`, plan `starter`, `healthCheckPath: /health`, build `npm ci && npm run build`, start `npm start`. `PAYPAL_ENV=sandbox` as a plain value; secrets with `sync: false` (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PUBLIC_BASE_URL`, `TELEGRAM_*`). Node comes from `.node-version`. Don't set `NODE_ENV=production`: `npm ci` would skip the devDependencies the build needs.
- Then **stop** and walk Baim through: creating the Blueprint; setting env vars; setting `PUBLIC_BASE_URL` to the `onrender.com` URL; adding a sandbox webhook pointing at `https://<service>.onrender.com/webhooks/paypal` with `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.CAPTURE.DENIED`; copying its ID into `PAYPAL_WEBHOOK_ID`; adding `https://<service>.onrender.com/mcp` as a custom connector in claude.ai.

**Phase 4: probe PayPal's commerce MCP tools**

- `scripts/probe-paypal-mcp.ts`: get an access token via client credentials, connect to `https://mcp.sandbox.paypal.com/sse` with `Authorization: Bearer <token>`, list tools twice (without and with `x-feature-flags: commerce:true`), and report whether `search_product`, `create_cart` and `checkout_cart` appear. If SSE fails, try Streamable HTTP at `https://mcp.sandbox.paypal.com/mcp`. Record the result here (P4).

**Phase 5 (only if time is left): seller ping**

- When a capture completes and both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set, send a Telegram Bot API message like "New order! 2 x Chocolate chip cookies, $12.00, paid via PayPal".

**Definition of done**

- Test 1: a sandbox order goes from created to approved by Baim to captured; the webhook arrives and verifies; the simulated decline recovers.
- Test 2: in claude.ai Baim says "buy 2 boxes of cookies from Auntie's Kitchen", Claude calls our tools, shows the total and gives the PayPal link, Baim approves, and Claude confirms `COMPLETED` via `get_order_status`.
- This log marks every check PASS or FAIL with evidence, records the commerce-flag result, and records where the PayPal AI Toolkit and the APIMatic plugin were used.
- README has the pitch, how to run locally, env vars and the Judge quickstart placeholder (done in session 1).
- Final report to Baim: what passed, what failed, what to fix first, and a go/no-go on the idea.
