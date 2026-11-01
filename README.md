# hackapal

**An agent-ready micro-store:** a small seller with no website gets a shop that AI assistants can browse and buy from over MCP, with PayPal handling the money.

> Built for the PayPal AI Hackathon on Devpost. **Status: Day 1 risk spike in progress.** Results and evidence live in [docs/BUILD_LOG.md](docs/BUILD_LOG.md).

## How it works

1. An AI assistant (Claude, via a claude.ai custom connector) calls our MCP tools: `list_products`, then `create_order`.
2. The server prices the cart from its own catalog (never from the model), creates a PayPal order with Orders v2 and hands back the approval link.
3. The buyer opens the link and approves in PayPal. Only the human can pay.
4. The server captures the payment, either on PayPal's return redirect or from the verified `CHECKOUT.ORDER.APPROVED` webhook if the buyer closed the tab early.
5. The seller gets a ping, and the assistant checks `get_order_status`. It may only say "paid" once the status is `COMPLETED`.

Built so far: scaffold, the demo shop "Auntie's Kitchen", server-side pricing in integer cents, the order store and `/health`. The PayPal and MCP pieces are next (see the status board in the build log).

## Run locally

You need Node.js 22 LTS (20.12 or newer works) and npm. Windows (PowerShell), macOS and Linux all work.

```bash
npm install
```

Create your `.env` from the template (PowerShell shown; on macOS/Linux use `cp .env.example .env`):

```powershell
Copy-Item .env.example .env
```

Start the server with auto-reload, then open http://localhost:3000/health:

```bash
npm run dev
```

Run the tests:

```bash
npm test
```

## Environment variables

| Variable | Needed for | Notes |
| --- | --- | --- |
| `PAYPAL_ENV` | always | Must be `sandbox`. Any other value refuses to start. |
| `PAYPAL_CLIENT_ID` | PayPal calls | Sandbox REST app client ID. |
| `PAYPAL_CLIENT_SECRET` | PayPal calls | Sandbox REST app secret. Environment only, never committed. |
| `PAYPAL_WEBHOOK_ID` | webhooks | ID of the sandbox webhook that points at `/webhooks/paypal`. |
| `PUBLIC_BASE_URL` | buyer redirects | Where PayPal sends the buyer back. Defaults to `http://localhost:$PORT`; on Render use the `onrender.com` URL. |
| `PORT` | optional | Defaults to 3000. Render sets it for you. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | optional | Seller ping on new paid orders. Both or neither. |
| `LOG_LEVEL` | optional | `debug`, `info` (default), `warn`, `error` or `silent`. |

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start with auto-reload (tsx watch). |
| `npm run build`, `npm start` | Compile to `dist/` and run it. This is what Render does. |
| `npm test` | Unit tests (vitest). |
| `npm run typecheck` | Strict type check of `src`, `scripts` and `test`. |
| `npm run money-path` | Test 1: sandbox order from create to buyer approval to capture. *Coming in Phase 1.* |
| `npm run mcp-smoke` | Test 2: call our MCP tools as a client. *Coming in Phase 2.* |
| `npm run probe-paypal-mcp` | Check whether PayPal's MCP commerce tools appear behind `x-feature-flags: commerce:true`. *Coming in Phase 4.* |

## Project layout

```text
src/
  config.ts   env loading and validation (sandbox guard)
  log.ts      JSON-lines logger with secret redaction
  app.ts      Express routes
  server.ts   entry point
  money.ts    integer-cents helpers
  catalog.ts  the demo shop and its products
  pricing.ts  server-side cart pricing and validation
  store.ts    order store interface + in-memory implementation
test/         vitest unit tests
scripts/      manual end-to-end scripts (money path, MCP smoke, PayPal MCP probe)
docs/         build log and evidence
```

## Safety rules

Already enforced:

- Sandbox only: any `PAYPAL_ENV` other than `sandbox` stops the server at startup.
- Prices come only from the server catalog, and all money math is in integer cents.
- Credentials come only from environment variables, and logs redact secret-looking keys.

Coming with the PayPal phase: a `PayPal-Request-Id` on every POST, a cached OAuth token, retries with backoff on 429/5xx, the PayPal `debug_id` logged on every error, verified webhook signatures, and Orders v2 only (no `v1/payments`, NVP or SOAP).

## Judge quickstart

_Placeholder: this gets filled in once the deployed demo and the claude.ai connector are verified._

- MCP endpoint: `https://<service>.onrender.com/mcp` (to be confirmed)
- Try it: add that URL as a custom connector in claude.ai, then say "buy 2 boxes of cookies from Auntie's Kitchen".
- Sandbox buyer login: to be shared on the Devpost page.
- Demo video: to be added.

## License

[MIT](LICENSE)
