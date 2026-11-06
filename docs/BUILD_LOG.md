# Build log

Evidence log for the Day 1 risk spike. Every check is **PASS**, **FAIL** or **PENDING**, with evidence such as order ids, PayPal `debug_id`s, commit hashes and screenshots. Times are UTC.

## Status board

| ID | Check | Status | Evidence |
| --- | --- | --- | --- |
| P0 | Scaffold builds, starts, serves `/health`; unit tests green | **PASS** | Session 1: 68 tests passing (`npm test`); `npm run build` then `npm start` served `/health` 200; `PAYPAL_ENV=live` refused to start (exit 1, secret not echoed). |
| T1a | Money path: create, buyer approves in sandbox, server captures | **PASS** | Session 2, 14:05:56 UTC, `money-path` against `https://hackapal.onrender.com` (free plan, commit `90e3384`): `ord_jab40wv2dyyn` / PayPal `5RV89033GE8513535`, $12.00, `CREATED -> COMPLETED`, capture `4VC692588D376791G`. First approval attempt never reached PayPal (order stayed `PAYER_ACTION_REQUIRED`); the retry with the sandbox **personal** account worked. |
| T1b | Webhook arrives on Render and its signature verifies | **PASS** | Same order. Verified via `verify-webhook-signature`: `PAYMENT.CAPTURE.COMPLETED` `WH-8X6006461P224354H-0JK1246097384671E` (PayPal time 14:06:00, received 14:06:23) and `CHECKOUT.ORDER.APPROVED` `WH-2X611071MF8140702-8S364688956061725` (received 14:06:09, after the capture, so correctly a no-op). Webhook `1BT95182K4694261A` is subscribed to ~65 event types; trim to the three we handle. |
| T1c | Simulated `INSTRUMENT_DECLINED` goes to `NEEDS_NEW_FUNDING`, buyer re-approves, order reaches `COMPLETED` | **PASS** | Session 2, 14:09 UTC, `money-path --simulate-decline` on Render: `ord_8qdmwz20y7jn` / PayPal `8A37379456997943K`, path `CREATED -> NEEDS_NEW_FUNDING` (14:08:46) `-> COMPLETED` (14:09:01) after the buyer re-approved; capture `1CT929250U3943106`. Verified webhooks: two `CHECKOUT.ORDER.APPROVED` (one per approval; the one arriving during `NEEDS_NEW_FUNDING` was ignored as designed) and `PAYMENT.CAPTURE.COMPLETED` `WH-9VX27225X5129983A-9PU583963C394941H`. |
| T2a | `mcp-smoke` against local and deployed `/mcp`: tools listed, `create_order` returns a real approval link | **PASS** | Session 2. Local (~14:10 UTC, built server, real sandbox): `ord_dsewwn9nqznp` / PayPal `7HW025580S139021M`. Deployed (14:14 UTC, `https://hackapal.onrender.com/mcp`, commit `8edadd0`): tools `list_products, create_order, get_order_status`; `create_order` made `ord_tqhy1bqgt2c5` / PayPal `04S77614CV356142N`, $12.00, real `www.sandbox.paypal.com` approval link; `get_order_status` = `CREATED`. |
| T2b | claude.ai connector end to end: "buy 2 boxes of cookies from Auntie's Kitchen", total shown, link handed over, approved, `COMPLETED` confirmed via `get_order_status` | **PASS** | Session 2, 14:18 UTC, Baim in claude.ai with the custom connector `https://hackapal.onrender.com/mcp`: order `ord_0g3dfbjp6ygs` / PayPal `41555192XT0984904`, 2 x Chocolate chip cookies, $12.00, created 14:17:58, `COMPLETED` 14:18:12, capture `0XA58144BN509850X`. Server side verified from `/api/orders` (both webhooks verified: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`). The chat itself (tool calls, total, link, confirmation) is evidenced by Baim's screenshots. |
| P4 | PayPal sandbox MCP tool list without and with `x-feature-flags: commerce:true` | **PASS** (probe ran) | Session 2, 12:45 UTC, `npm run probe-paypal-mcp`: a plain client-credentials REST token works as `Bearer` on `https://mcp.sandbox.paypal.com/sse` (server "PayPal MCP Agent 1.0.0"). 46 tools both times; the commerce flag adds nothing; `search_product`, `create_cart`, `checkout_cart` absent. Streamable HTTP `/mcp` answers 404 to an authenticated POST. See "Phase 4 probe result". |
| M1 | Marketplace: three shops; each order is branded with its shop and names the shop's PayPal account as `payee` | **PASS** (local, real sandbox) | 2026-11-06 ~08:05 UTC, local server against the PayPal sandbox: `mcp-smoke` on `/s/kampung-fresh-mart/mcp` created `ord_0x79jhev2rky` / PayPal `7Y821307BC895403P`, $11.00; `probe-payee --show` returned `payee.email_address: johndblend@business.example.com`, `display_data.brand_name: Kampung Fresh Mart` (debug_id `f2498178aa5ce`). On `/mcp` (marketplace), `list_shops` was among the four tools and `standard-clean-3h` made `ord_w0b30ps4ga27` for Kilat Home Cleaning, $90.00. Not deployed yet. |
| M2 | Option B: capture succeeds and the money lands in the *payee's* account, not ours | **PENDING** | Probe order PayPal `8FM75136AH1854239` ($6, payee `johndblend@business.example.com`, created with HTTP 200, debug_id `ca56293b3da89`) is waiting for the sandbox buyer's approval; `probe-payee --capture ... --wait` captures as soon as it's approved. Still to check after the capture: `seller_receivable_breakdown`, johndblend's sandbox balance, and whether our webhook gets events for third-party-payee orders. |
| S5 | Telegram seller ping on a completed capture (optional) | **PASS** | 2026-11-02, Render commit `dce72b1`, `/health` `sellerPing: telegram`. Order `ord_jet2p1jq5qyk` (1 x Chocolate chip cookies, $6.00, PayPal `8NH10827F2507581S`) was created through the live claude.ai-style MCP connector and paid by Baim in sandbox. `COMPLETED` at 11:02:54 UTC, capture `93K55850CR203070G`; cookies stock 22 -> 21 with one movement row. Baim confirmed the Telegram message arrived (screenshot is Baim's). |

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
- **2026-11-06: paying each seller (option B).** Re-read `SKILL.md` and `references/checkout.md` before adding `payee` to the order request. `SKILL.md` lists "PayPal Commerce Platform (multi-party marketplaces)" under **Out of Scope** and points to the Commerce Platform docs. -> We don't use Commerce Platform (partner onboarding, `platform_fees`) for the hackathon. We use the plain Orders v2 `purchase_units[].payee`, which the checkout reference's request shape allows, with no platform fee (design decision 16).

### APIMatic Context Plugin (ContextMatic)

- **2026-11-06: payee for option B (design decision 16).** `model_search` for `PayeeBase` showed the SDK model has `emailAddress` and `merchantId`, and the TypeScript field on `PurchaseUnitRequest` is `payee`. -> `src/paypal.ts` sends `payee: { emailAddress }` only when the shop has a payee. `model_search` for the capture models showed the capture carries `sellerReceivableBreakdown` (gross, PayPal fee, net) but no payee field; the payee is echoed on the order's purchase unit. -> `probe-payee` reads both when it checks where the money went. Two `ask` calls on "who receives the funds when payee is set" returned a tool error, so that question is answered by the live probe (M2), not by ContextMatic.

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
    - **Before judging (Dec 2 to 16):** ~~move the order store to Supabase~~ (done 2026-11-02, see "Supabase order store" in the session log), and either add an uptime pinger on `/health` or switch to the paid size with the Render hackathon credit (`plan: 0.5c-512mb`, the old "starter"). A pinger that keeps the service awake 24/7 uses about 720 to 744 of the workspace's 750 free hours a month, so it only works for this one service. If the hours run out with no card on file, Render suspends every free service for the rest of the month.

15. **`/api` needs a key; `/mcp` stays public with rate limits** (Baim, 2026-11-02).
    - `/mcp` is the storefront: any buyer's assistant, and the judges' claude.ai connector, must reach it. claude.ai custom connectors offer no auth or full OAuth, with no static key, so a key there would break T2b. OAuth was rejected as days of work for a sandbox demo.
    - What `/mcp` exposes is bounded. Creating an order moves no money and takes no stock, and order ids are 60-bit random.
    - So it gets per-IP and global limits instead: 120 requests/min per IP (HTTP 429 with `Retry-After`), and `create_order` at most 20 per IP and 60 in total per 10 minutes (a tool error; PayPal is never called).
    - `/api/*` (`simulate_decline`, manual capture) requires `API_KEY` as `Authorization: Bearer` or `X-API-Key`, compared in constant time. Without a configured key `/api` answers 503, so it can't be left open by accident. Render generates the key (`generateValue: true`).
    - Limits are in memory, per instance: enough against a runaway client or a casual spammer, not against a distributed attack. Before any real money: proper auth (OAuth) for private shops and a shared limiter.
16. **A marketplace of shops, each paid directly (option B)** (Baim, 2026-11-06: "proceed with option b", "add another 2 shops", no platform fee).
    - **Shops live in code** (`src/catalog.ts`: Auntie's Kitchen, Kampung Fresh Mart, Kilat Home Cleaning). Self-service onboarding is out of scope for now (Baim: possible later, not a priority).
    - **Product ids are unique across the platform.** A product id alone names its shop, so `public.stock` and `public.orders` need no schema change, and an order's shop is derived from its items. `src/platform.ts` refuses duplicate ids at startup.
    - **One order, one shop.** `create_order` takes an optional `shop_id`; without it the shop of the items is used. A cart that mixes shops is refused (`MIXED_SHOPS`), and an item from another shop gets a message that names the right shop.
    - **Money goes straight to the seller.** The PayPal order's `brand_name` is the shop's name and `purchase_units[0].payee.email_address` is the shop's PayPal account when it has one. The grocer and the cleaner use the second sandbox merchant `johndblend@business.example.com`; Auntie's Kitchen keeps the app's own account. No `platform_fees` (that needs Commerce Platform onboarding). The payee is never shown to agents.
    - **Endpoints:** `/mcp` is the marketplace (`list_shops`, `list_products` with an optional `shop_id`, `create_order`, `get_order_status`). `/s/<shop_id>/mcp` is one shop's own link, without `list_shops`; it only answers for that shop's orders. `/` lists the shops and their links.
    - **Unchanged:** prices only from the server, request ids, retries, webhook verification and the status rules. Webhooks for every shop arrive at the same app (to be confirmed for third-party payees, M2); the return page and `get_order_status` capture anyway, so a missing webhook can't strand a payment.
    - **One Telegram chat** for the whole demo; the message names the shop. Per-seller chats would come with onboarding.

Assumptions (change them if wrong):

- `shipping_preference: NO_SHIPPING`. Fulfilment is pickup or local delivery arranged after payment.
- Quantity is 1 to 10 per product, after duplicate lines are merged.
- Stock is checked when an order is created and taken when its capture completes. Taking stock clamps at zero and reports any oversell.
- `get_order_status` reconciles with PayPal: if PayPal says APPROVED and we haven't captured, it captures (except in `NEEDS_NEW_FUNDING`, see decision 10). A lost webhook can't strand a buyer who clicked "Pay Now".
- Webhook handlers never move an order backwards. A late `CHECKOUT.ORDER.APPROVED` after `COMPLETED` does nothing.
- ~~`/mcp` has no authentication for now.~~ Superseded by design decision 15: `/mcp` stays public by design, with rate limits; `/api` needs a key.

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

### Supabase order store (2026-11-02)

- **Project:** new free Supabase project `hackapal` (`bfnxvbesrsjnfaionbcj`, ap-southeast-1), separate from the org's other project, which holds another app's live data. Baim chose this so a leaked hackapal key can't reach that data.
- **Schema:** `supabase/migrations/20261101000000_orders.sql`, applied through the Supabase connector. It has check constraints for the id format, USD, non-negative cents and known statuses, and a unique `paypal_order_id`. RLS is on with no policies and no grants for `anon`/`authenticated`. The security advisor reports only the expected INFO `rls_enabled_no_policy`.
- **Code:** `SupabaseOrderStore` implements `OrderStore` (merged in PR #5). The server uses it when `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are set, and `/health` reports `orderStore`.
- **Live checks on Render (commit `14738ae`):**
  - 02:40 UTC: `/health` showed `"orderStore": "supabase"`. `POST /api/orders` created `ord_d4e56g128jy0` (PayPal `1BE02912FU203531P`, $8.00); the row was visible in `public.orders` via SQL, and `GET /api/orders/ord_d4e56g128jy0` read it back.
  - The publishable key is refused for both reading and inserting: HTTP 401, `42501 permission denied for table orders`.
  - **Restart survival:** no traffic for 17 minutes, so the free instance slept. At 02:57 the wake-up request took 22.8 s and `/health` showed `uptimeSeconds: 13`, a fresh process. `ord_d4e56g128jy0` was still there.
- **Still in memory:** product stock (resets to the catalog values on restart) and the webhook dedupe set (safe because status changes are idempotent). The Supabase contract tests in `test/store-contract.test.ts` have not been run against the live project yet; they need `TEST_SUPABASE_URL` and `TEST_SUPABASE_SECRET_KEY` in the environment.

### Stock in Supabase (2026-11-02)

- **Why:** stock lived in memory, so every free-plan sleep or restart reset it to the catalog numbers, which allowed overselling.
- **Schema:** `supabase/migrations/20261102000000_stock.sql`, applied to project `hackapal`.
  - `public.stock`: one row per product id, `stock >= 0`.
  - `public.stock_movements`: primary key `(order_id, product_id)`, recording each sale with its `short_by`.
  - `public.take_stock(order_id, product_id, quantity)`: locks the stock row, inserts the movement (`on conflict do nothing`), then decrements, clamped at zero. A repeated call for the same order line changes nothing (`applied = false`), so a redelivered webhook, a second code path or a restart part-way through can't take twice.
  - Execute is granted to `service_role` only. Both tables have RLS on, no policies and no grants for `anon`/`authenticated`.
- **Code:**
  - Prices and product definitions stay in `src/catalog.ts`. Only the count moved.
  - `StockStore` has two implementations: `CatalogStockStore` (in memory, the fallback) and `SupabaseStockStore`. The Supabase one seeds missing catalog products from their initial stock with `insert ... on conflict do nothing`, so a live level is never overwritten.
  - `priceCart` checks against the live levels, `list_products` shows them, and stock is taken per order line when a capture completes.
  - A failed stock take is logged as `stock take failed` but never undoes a paid order.
  - `/health` reports `stockStore`.
- **Live SQL checks** (03:13 UTC, throwaway product `test-verify-0211`, removed afterwards):
  - First take of 2 from 3 left 1 (`applied`).
  - The same order line again changed nothing (`applied: false`).
  - Taking 5 of the remaining 1 for another order clamped at 0 with `short_by: 4`.
  - The publishable key is refused on `rpc/take_stock` and on `stock` (`42501`).
  - The security advisor reports only the intended INFO `rls_enabled_no_policy`, one per table.
- **Live on Render (commit `0f931f6`, 03:17 UTC):**
  - `/health` reported `"stockStore": "supabase"`.
  - The server seeded `public.stock` with 24, 15 and 10, and `list_products` over the deployed MCP endpoint returned those numbers.
  - Paid order `ord_zp6ht17jmjzp` (PayPal, 2 x Chocolate chip cookies, $12.00, approved by Baim in sandbox) reached `COMPLETED` at 03:19:36, capture `0MM61912RS3958306`. In the same instant, cookies stock went 24 -> 22 with exactly one `stock_movements` row (quantity 2, `short_by` 0).
  - The verified `PAYMENT.CAPTURE.COMPLETED` webhook arrived 21 s later (03:19:57). Stock stayed at 22 and there was still one movement, so the second completion path did not take stock again.
- **Not covered yet:**
  - The live Supabase contract tests need `TEST_SUPABASE_URL` and `TEST_SUPABASE_SECRET_KEY`.
  - Order completion and the stock take are separate statements, not one transaction. If the process dies between them, that sale's stock isn't taken; `stock take failed` or a missing movement row shows it.

### API key and rate limits live (2026-11-02, 03:27-03:30 UTC)

- Render commit `8579e13` (PR #8).
- Before Render picked up `API_KEY`, `/api` answered 503 `api_disabled`, so it fails closed.
- After the restart that picked it up, `/health` showed `apiKeyConfigured: true` and `/api/orders/...` without a key answered 401.
- `mcp-smoke` without any key still worked: tools listed, and `create_order` made `ord_xn154qv0bqeq`. So the claude.ai path is unaffected.
- A correct key wasn't tested live (this session doesn't hold it); the unit tests cover it.

### Telegram seller ping (2026-11-02)

- `src/telegram.ts`: `TelegramNotifier` implements the existing `SellerNotifier`. `OrderService` calls it once per order, on the move to `COMPLETED`, as fire-and-forget, so a Telegram outage never affects the payment.
- It sends Bot API `sendMessage` as plain text (no `parse_mode`), e.g. "New order for Auntie's Kitchen! 2 x Chocolate chip cookies, $12.00, paid via PayPal." plus the order and capture ids.
- It retries 429 (honouring `retry_after`), 5xx and network errors twice, then logs `telegram ping failed`.
- The bot token sits in the request URL, so the URL is never logged; a test checks the token never reaches the logs.
- On only if `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are both set. `/health` reports `sellerPing`.

### Bigger menu and seller restock (2026-11-06)

- **Menu:** five products added to Auntie's Kitchen (8 in total): kuih seri muka ($9), onde-onde ($7), curry puffs ($8), kuih bahulu ($10) and pandan chiffon cake ($15). Prices are still server-side in `src/catalog.ts`. New products are seeded into `public.stock` with their starting stock on the server's first stock read after deploy; existing live levels are never overwritten.
- **Restock:** `GET /api/stock` and `PUT /api/stock` (behind `API_KEY`), plus `npm run stock`.
  - Levels are absolute, so repeating a call is harmless.
  - Ids must be catalog products and levels whole numbers from 0 to 1000; otherwise nothing changes.
  - A sale at the same instant as a restock can be overwritten (acceptable for a manual action).
- **Why an endpoint and not SQL:** the Supabase connector is blocked in this session by a permission rule, and seller-managed stock is needed for the platform direction anyway.
- **Tests:** 175 passing (5 new). The script was tried against a local server: list, set, and a refused wrong key.

### Marketplace: three shops, each paid directly (2026-11-06)

- **What changed:** two new demo shops (Kampung Fresh Mart, 6 grocery products; Kilat Home Cleaning, 4 services where stock means open slots this week); `src/platform.ts` registry; `OrderService` resolves the shop per order and passes its name and payee to PayPal; marketplace and per-shop MCP endpoints; shop-aware return page, Telegram message, `/api/stock` (`?shop=`) and `POST /api/orders` (`shop_id`); directory page at `/`; `/health` lists the shop ids. `money-path --product`, `mcp-smoke <url> [product]`, `stock --shop`, `probe-payee --show`.
- **Evidence:** M1 above (local, real sandbox). M2 (does the capture pay johndblend?) is pending one sandbox approval.
- **Deploy note:** on the first stock read after deploy, the 10 new products are seeded into `public.stock` with their starting stock; existing levels aren't touched.
- **Tests:** 193 passing (18 new), 4 skipped (live Supabase).

## Handoff (latest, 2026-11-06)

1. Merge the marketplace PR; Render redeploys. Check `/health` lists three shops and that https://hackapal.onrender.com shows the directory.
2. M2: Baim approves `8FM75136AH1854239` as the sandbox buyer (or a fresh grocer order from `money-path --product eggs-30`). Then check the capture's `seller_receivable_breakdown` and johndblend's sandbox balance, and whether `/api/orders/<id>` shows verified webhooks for a grocer order.
3. Baim: restock Auntie's Kitchen with `npm run stock` if needed, rename the claude.ai connector to `hackapal`, and trim the PayPal webhook to the three handled events (finishing touch).
4. Then: demo video, Devpost write-up.

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
