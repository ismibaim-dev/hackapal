# Build log

Evidence log for the Day 1 risk spike. Every check is **PASS**, **FAIL** or **PENDING**, with evidence such as order ids, PayPal `debug_id`s, commit hashes and screenshots. Times are UTC.

## Status board

| ID | Check | Status | Evidence |
| --- | --- | --- | --- |
| P0 | Scaffold builds, starts, serves `/health`; unit tests green | **PASS** | Session 1: 68 tests passing (`npm test`); `npm run build` then `npm start` served `/health` 200; `PAYPAL_ENV=live` refused to start (exit 1, secret not echoed). |
| T1a | Money path: create, buyer approves in sandbox, server captures | PENDING | |
| T1b | Webhook arrives on Render and its signature verifies | PENDING | |
| T1c | Simulated `INSTRUMENT_DECLINED` goes to `NEEDS_NEW_FUNDING`, buyer re-approves, order reaches `COMPLETED` | PENDING | |
| T2a | `mcp-smoke` against local and deployed `/mcp`: tools listed, `create_order` returns a real approval link | PENDING | |
| T2b | claude.ai connector end to end: "buy 2 boxes of cookies from Auntie's Kitchen", total shown, link handed over, approved, `COMPLETED` confirmed via `get_order_status` | PENDING | |
| P4 | PayPal sandbox MCP tool list without and with `x-feature-flags: commerce:true` | PENDING | |
| S5 | Telegram seller ping on a completed capture (optional) | PENDING | |

## Sponsor tools used

Record every real use: date, tool, what was asked, what it said, and which code or decision it changed (commit). Judges for the sponsor prizes will look here.

### PayPal AI Toolkit (`paypal-best-practices` skill)

- **Session 1 (2026-11-01):** not used yet. The PayPal plugin (source `github.com/paypal/ai-toolkit`) is in the Claude plugin directory but was not enabled in this session. Baim is enabling it for session 2. No PayPal code was written before it is available, as the brief requires.

### APIMatic Context Plugin (ContextMatic)

- **Session 1 (2026-11-01):** not used yet. It is a remote MCP server at `https://chatbotapi.apimatic.io/mcp/plugins` and requires an OAuth sign-in (an unauthenticated request returns 401, with protected-resource metadata naming `https://chatbotapi.apimatic.io` as the authorization server, scope `mcp:tools`). Baim is adding it as a claude.ai custom connector for session 2. Worth noting for the write-up: `@paypal/paypal-server-sdk` is itself APIMatic-generated (it depends on `@apimatic/core`).

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

Assumptions (change them if wrong):

- `shipping_preference: NO_SHIPPING`. Fulfilment is pickup or local delivery arranged after payment.
- Quantity is 1 to 10 per product, after duplicate lines are merged.
- Stock is checked when an order is created and taken when its capture completes. Taking stock clamps at zero and reports any oversell.
- `get_order_status` reconciles with PayPal: if PayPal says APPROVED and we haven't captured, it captures. A lost webhook can't strand a buyer who clicked "Pay Now".
- Webhook handlers never move an order backwards. A late `CHECKOUT.ORDER.APPROVED` after `COMPLETED` does nothing.
- `/mcp` has no authentication for now. That's acceptable in sandbox only, and must change before any real money.

## Environment findings (session 1, 2026-11-01)

- **PayPal sandbox API is reachable** from the Claude Code cloud container. `POST /v1/oauth2/token` without credentials returned 401 `invalid_client` (`paypal-debug-id: f190520033768`).
- **PayPal sandbox MCP server** answers at both `https://mcp.sandbox.paypal.com/sse` and `https://mcp.sandbox.paypal.com/mcp`. Both return 401 with OAuth protected-resource metadata (authorization server `https://mcp.sandbox.paypal.com`). Open question for P4: does it accept a plain REST client-credentials token as `Bearer`?
- **Idempotency** ([PayPal docs](https://developer.paypal.com/api/rest/reference/idempotency/)): a repeated `PayPal-Request-Id` returns the latest status of the earlier request; simultaneous duplicates may fail; behaviour after error responses isn't documented.
- **Commerce tools** ([PayPal blog](https://developer.paypal.com/community/blog/expanding-paypal-mcp-capabilities)): gift cards only for now; the documented header is `x-feature-flags: commerce:true`.
- **Versions chosen (2026-11-01):** express 5.3, zod 4.6, typescript 7.0 (native compiler), vitest 5.0, tsx 4.23. For Phases 1 and 2: `@paypal/paypal-server-sdk` (2.5.0 is latest) and `@modelcontextprotocol/sdk` (1.32.2 is latest).
- **Windows:** the lockfile includes the win32-x64 native binaries (esbuild, rolldown, TypeScript 7), so `npm ci` should work on Baim's machine. If it ever complains about a missing native binding, run `npm install` once to repair it.

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
