# CLAUDE.md

Guidance for Claude Code sessions in this repo.

## Project

hackapal is an agent-ready micro-store for the PayPal AI Hackathon (Devpost, deadline 2026-11-12 12:00 PST). A small seller with no website gets a shop that AI assistants can browse and buy from over MCP. The agent creates a PayPal order, the human buyer approves in PayPal, we capture server-side, and the seller is notified. Judging: Technological Implementation, Design, Impact, Innovation, Presentation. PayPal must be central and the AI must do real work. The repo stays public under MIT.

**Start here:** `docs/BUILD_LOG.md` has the status board, the design decisions and the handoff for the next session.

## Hard rules for the money path

- Sandbox only (config refuses anything else). USD. Integer cents everywhere; decimal strings only at the PayPal and display edges (`src/money.ts`).
- Orders are created and priced on the server only, from `src/catalog.ts` via `priceCart`. Never accept prices from the model or the client.
- One order belongs to one shop. Its PayPal `brand_name` and `payee` come only from that shop in `src/catalog.ts`, never from the caller. Never show a seller's PayPal account to agents. Product ids must stay unique across shops (`src/platform.ts` enforces it).
- `PayPal-Request-Id` on every PayPal POST. Capture key: `capture-<orderId>-<attempt>`.
- Cache the OAuth token until shortly before expiry. Credentials come only from env vars; never log, print or commit them.
- Retry 429/5xx with backoff (POSTs are safe to retry thanks to `PayPal-Request-Id`). Log the PayPal `debug_id` on every error.
- Verify webhook signatures with the raw request body embedded unmodified. There is no global `express.json()` for that reason.
- Orders v2 only: no `v1/payments`, NVP or SOAP. Prefer `@paypal/paypal-server-sdk`; use `fetch` only where the SDK doesn't cover a call.
- Before writing PayPal code, consult the PayPal AI Toolkit's `paypal-best-practices` skill (vendored in `.claude/skills/paypal-best-practices/`) and the APIMatic ContextMatic plugin, and log each use in `docs/BUILD_LOG.md` (APIMatic use is needed for its sponsor prize). If a tool is missing, say so in one line, log it, and continue with PayPal's REST docs.

## Conventions

- Node 22 LTS, TypeScript strict ESM (`NodeNext`, so relative imports end in `.js`), Express 5, zod 4, vitest 5. MCP via `@modelcontextprotocol/sdk`.
- The owner develops on Windows 10: npm scripts and tsx only, no bash-only commands in scripts or docs, no `rm -rf`.
- Branch `claude/pensive-faraday-ina38x` (`day1-spike` is retired), small Conventional Commits, draft PR.
- Before pushing, run `npm run typecheck` and `npm test`, plus `npm run build` if `src` changed.
- When a step needs the owner (dashboard clicks, credentials, deploys, approving a sandbox payment), stop, give exact step-by-step instructions, and wait.
