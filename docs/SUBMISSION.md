# Submission pack

A draft of everything Devpost asks for, plus the demo video script. Every claim here is backed by `docs/BUILD_LOG.md` (status board and design decisions). Paste the sections into Devpost and edit them freely.

Deadline: **2026-11-12, 12:00 PST**.

---

## Devpost fields

### Name

hackapal

### Tagline (one line)

Agent-ready micro-stores: any AI assistant can shop from small sellers with no website, and PayPal pays each seller directly.

### Inspiration

Many of the best small sellers have no website. They include the home baker taking orders over chat, the neighbourhood grocer and the cleaner with a few free slots this week. AI assistants are becoming how people shop, but an assistant can only buy from a shop it can reach, and these sellers can't build an online store, a checkout and a payment integration. We wanted to give them a shop an AI can buy from, with PayPal handling the money and a human always approving the payment.

### What it does

- **A marketplace of three demo sellers:** Auntie's Kitchen (home bakery), Kampung Fresh Mart (groceries) and Kilat Home Cleaning (bookable cleaning visits). Any assistant that speaks MCP can browse and order from them. Claude in claude.ai does it through a custom connector.
- **The AI does the shopping, the human does the paying.** Claude lists the shops and products, confirms the items and total, and creates the order. The buyer gets a PayPal link and approves it themselves. Claude only says "paid" once PayPal has confirmed the capture.
- **One checkout for several sellers, each paid directly.** A cart with kuih lapis from the bakery and eggs from the grocer becomes **one** PayPal order with a purchase unit per seller. Each unit names that seller's own PayPal account as the payee. The buyer approves once, and each seller's share lands in their own account. The platform never holds the money.
- **The model can't set prices.** `create_order` takes product ids and quantities only. The server prices every cart from its own catalog in integer cents.
- **Each seller gets a real order card on Telegram, from their own shop's bot.** It lists their items and subtotal, the delivery address the buyer chose in PayPal, the buyer's contact, and any note the buyer gave Claude ("deliver after 6pm"). Only that seller is notified.
- **The money path is built to survive the real world.** Webhooks are verified against the raw body. Every PayPal POST carries a `PayPal-Request-Id`, so retries never charge twice. Stock is taken exactly once even when the webhook and the return page both report the payment. A declined card sends the buyer back to PayPal to choose another way to pay.

### How we built it

- **Server:** Node 22, TypeScript (strict), Express 5, zod. Deployed on Render, with orders and stock in Supabase Postgres.
- **AI interface:** an MCP server over Streamable HTTP (`@modelcontextprotocol/sdk`). The marketplace endpoint `/mcp` has `list_shops`, `list_products`, `create_order` and `get_order_status`, and each shop also has its own endpoint, `/s/<shop_id>/mcp`. Tool descriptions are written for the model ("Only the human buyer can pay", "Never say it is paid until COMPLETED").
- **PayPal:** Orders v2 through `@paypal/paypal-server-sdk`.
  - Server-side create and capture, with idempotency keys (`create-<order>`, `capture-<order>-<attempt>`).
  - Webhook signature verification and decline recovery.
  - Per-seller `payee`, multiple purchase units for a combined checkout, and `shipping_preference: GET_FROM_FILE` for sellers who deliver.
- **Seller notifications:** the Telegram Bot API, with one bot per shop.
- **Sponsor tools, used before writing PayPal code and logged in the build log:**
  - **APIMatic ContextMatic** answered SDK questions (models, controllers, retry and auth configuration, payee, shipping and payer fields). Reading the SDK source to check its answers led us to fix real issues (see Challenges).
  - **PayPal's AI Toolkit skill (`paypal-best-practices`)** set the rules we follow: idempotency keys, token caching, webhook verification and decline handling.
- **Testing:** 220 unit tests (vitest), plus scripts that drive the live sandbox end to end. Every check on the status board was proven with real sandbox orders, capture ids and merchant ids.

### Challenges we ran into

- **SDK retries made declines slow.** With retries on, the SDK retried every declared error, including a `422 INSTRUMENT_DECLINED`. A declined buyer waited about 9 seconds while the decline was attempted four times. We measured it, turned SDK retries off, and retry only 429, 5xx and network errors ourselves, with the same request id. A decline now returns in about 0.5 seconds.
- **A failed token fetch broke the SDK client for good.** The SDK caches the token as a promise, so one failed fetch made every later call fail. We now fetch tokens ourselves and rebuild the client after such a failure.
- **Our first "seller payout" proof was wrong.** The capture succeeded, but the merchant id showed the "second seller" was actually the account that owns our REST app, so it proved nothing. We created a real second sandbox merchant and proved the payout by checking that the capture's merchant id differs from ours.
- **The AI split a cart that it should have combined.** In one older chat, Claude created one order per shop. It was most likely still using an older copy of our tool list, from before the combined checkout existed. We rewrote the tool guidance in plain terms ("put everything in ONE call; do not create one order per shop"), and in a new chat Claude made one checkout.
- **Free hosting sleeps.** The server sometimes didn't answer after idling. An uptime monitor keeps it awake for judges.
- **Simulated webhooks can't prove anything.** PayPal's webhook simulator events can't pass signature verification, so every webhook check uses a real sandbox payment.

### Accomplishments that we're proud of

- **One PayPal approval paid two different sellers directly**, proven in sandbox: capture `6KR98118XM628793N` went to merchant `W9JBVPFWNL5ZU` and capture `9KP234742H667401D` to merchant `YTJXJV3Y82YMJ`, from one checkout.
- **Every end-to-end check is backed by evidence** (order ids, capture ids, webhook ids, merchant ids) in a public build log.
- **The buyer never types an address into a chat window.** PayPal collects it, and it reaches only the seller who needs it.

### What we learned

- With the AI in the loop, the safest design keeps money decisions on the server: prices, totals, payees and what counts as "paid". The model only expresses intent.
- Tool descriptions are part of the product. The agent's behaviour changed with one sentence.
- Verify claims against primary sources. Checking ContextMatic's answers against the SDK source and checking payouts against merchant ids both caught real mistakes.

### What's next

- **Seller self-onboarding:** a seller connects their PayPal account and Telegram chat from a join link, instead of being set up in code.
- **Production PayPal:** paying several merchants in one order worked in sandbox. With real money, PayPal may require a marketplace (Commerce Platform) agreement, and that is the path we would take.
- **Refunds and order tracking**, plus delivery tracking numbers through PayPal's tracking API.

### Built with

typescript, node.js, express, paypal-orders-v2, paypal-server-sdk, model-context-protocol, claude, supabase, postgresql, render, telegram-bot-api, zod, vitest, apimatic

---

## Devpost form answers

### Demo URL

`https://hackapal.onrender.com`. Use the home page, not `/mcp`: opening `/mcp` in a browser shows an error, because it only answers MCP clients. The home page lists the MCP links and the shops.

### Explain how your project meets the main technology requirement

**PayPal (sandbox):**
- **Orders v2 REST API**, through PayPal's TypeScript server SDK (`@paypal/paypal-server-sdk`). The server creates and captures every order. Prices come from the server's catalog, never from the AI.
- **Multi-seller payouts.** Each seller's purchase unit names that seller's own PayPal account as the `payee`. A cart from several shops becomes one order with a purchase unit per seller, so one buyer approval pays each seller directly (proven in sandbox with two different merchant ids).
- **Shipping address collection** (`shipping_preference: GET_FROM_FILE`) for sellers who deliver. The address goes only to that seller.
- **Webhooks** with signature verification (`verify-webhook-signature`), using the raw body. They handle `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.CAPTURE.DENIED`.
- **Idempotency** (`PayPal-Request-Id` on every POST), OAuth token caching, `debug_id` logging, and **negative testing** with `PayPal-Mock-Response` to prove decline recovery (`INSTRUMENT_DECLINED` sends the buyer back to choose another way to pay).
- **PayPal AI Toolkit:** its `paypal-best-practices` skill guided the integration (idempotency, tokens, webhooks, decline handling).

**AI:**
- **Claude (Anthropic)** is the shopping agent. It connects to hackapal as a custom MCP connector in claude.ai, lists shops and products, confirms the cart with the buyer, creates one order for the whole cart (including a delivery note), hands over the PayPal link, and checks payment status. It may only say "paid" when PayPal reports the capture as COMPLETED.
- **Model Context Protocol:** our MCP server (`@modelcontextprotocol/sdk`, Streamable HTTP) is the AI interface. It has a marketplace endpoint and a per-shop endpoint for each seller.
- **APIMatic ContextMatic** answered PayPal SDK questions during development (see its own field).

### Which additional sponsor tool(s) did you use?

**APIMatic Context Plugin.** We didn't use AG Grid.

### How would you rate your overall experience integrating PayPal? (1-10)

Your call. A fair 8 based on what we hit: the sandbox, Orders v2 and webhooks worked well, but the SDK's retry and token behaviour needed workarounds.

### Overall experience: why

Orders v2 and the sandbox made the core flow straightforward, and sandbox negative testing with `PayPal-Mock-Response` let us prove decline recovery without real cards. Multiple purchase units with different payees worked in sandbox, which made a one-checkout, many-sellers flow possible. Friction points: with retries enabled, the TypeScript server SDK retried every declared 4xx error, so a declined card took about 9 seconds and was attempted four times. A single failed token fetch also left the SDK client failing until it was rebuilt. Events from the webhook simulator can't pass signature verification, so every webhook test needs a real sandbox payment. Clearer docs on whether multi-payee orders need a partner agreement in production would help.

### APIMatic Context Plugin experience

ContextMatic was our first stop before writing PayPal code. `fetch_api`, `model_search` and `endpoint_search` gave the exact TypeScript SDK shapes we needed: OrdersController methods, camelCase models, `paypalMockResponse` for negative testing, token provider hooks, and later the `payee`, shipping and payer fields. That was faster than reading generated docs. Issues: several `ask` calls returned errors and had to be split into smaller questions. Two answers were wrong when checked against the installed SDK source: the error body field is `debug_id`, not `debugId`, and the retry defaults mean no retry happens even after raising `maxNumberOfRetries`. It also couldn't say whether one order may pay several merchants, so we proved that with a live probe. Overall it made us faster and pointed us to the right models, but we treated its answers as leads to verify, not ground truth. Every use is logged in `docs/BUILD_LOG.md`.

### Which AI tools have you leveraged while working on this project?

- **Claude Code (Anthropic):** pair-programmed the codebase, tests, scripts and docs, and drove the live sandbox probes.
- **Claude in claude.ai (Anthropic):** the shopping agent in the product and the demo, through our MCP connector.
- **APIMatic ContextMatic:** PayPal SDK context.
- **PayPal AI Toolkit (`paypal-best-practices` skill):** PayPal integration guidance.

### Project media

- Thumbnail: `docs/media/thumbnail.png` (1500x1000, 3:2).
- Gallery, in this order:
  1. `thumbnail.png`
  2. `how-it-works.png`
  3. `home-page.png` (the live directory)
  4. your claude.ai screenshot of the one-link $19.00 checkout
  5. the PayPal approval screen
  6. the two Telegram order cards
  7. each seller's sandbox account activity

  Items 4-7 should be your own real screenshots.
- File upload: not needed. The repo and video carry everything.

### Eligibility checkboxes

Tick them only if they're true for you: age of majority, an eligible jurisdiction (check the hackathon rules for your country), and not affiliated with the sponsors.

## Testing instructions for judges (Devpost field)

Write the sandbox buyer login here on Devpost only. **Never commit it to the repo.**

1. Open https://hackapal.onrender.com/health and wait for `"status":"ok"`.
2. In claude.ai, go to **Settings > Connectors > Add custom connector**. Name it `hackapal`, set the URL to `https://hackapal.onrender.com/mcp`, and use no authentication. Start a **new** chat with it switched on.
3. Ask "What shops are on hackapal?", then "Get me kuih lapis from Auntie's Kitchen and 2 trays of eggs from the grocer, deliver after 6pm."
4. Open the single PayPal link and log in as the sandbox buyer: `<sandbox buyer email>` / `<password>`. Pick an address and click **Pay Now**.
5. Ask Claude "Is it paid?" It confirms only after PayPal reports `COMPLETED`.

Also try asking for a discount. The price can't change, because the server sets it.

---

## Demo video script (about 2.5 minutes)

Record in one take per scene and keep the browser at 100% zoom. Use real sandbox runs, never a mock-up.

| # | Time | On screen | Voiceover |
| --- | --- | --- | --- |
| 1 | 0:00-0:15 | The home page https://hackapal.onrender.com listing the three shops | "Small sellers like a home baker, a corner grocer or a cleaner rarely have a website. hackapal gives them a shop that any AI assistant can buy from, with PayPal handling the money." |
| 2 | 0:15-0:35 | claude.ai: "What shops are on hackapal?" Claude lists the three shops | "Claude connects over MCP. It browses real shops with real stock." |
| 3 | 0:35-1:05 | "Get me kuih lapis from Auntie's Kitchen and 2 trays of eggs from the grocer, deliver after 6pm." Claude shows both sellers, $19.00 and **one** link | "Two sellers, one checkout. Claude passes items and quantities; the server prices everything, so the model can't change a price." |
| 4 | 1:05-1:30 | The PayPal sandbox screen: pick an address, Pay Now, then the "Payment complete" page | "Only the human pays. PayPal collects the delivery address, so the buyer never types it into a chat." |
| 5 | 1:30-1:55 | Two phones or two Telegram windows: the Auntie's Kitchen bot card ($8.00) and the Kampung Fresh Mart bot card ($11.00), each with the address and the note | "Each seller is notified by their own shop's bot, with only their items, the address, the buyer's contact and the note." |
| 6 | 1:55-2:15 | The PayPal sandbox activity for the second merchant showing $11.00 received, and the main account showing $8.00 | "One approval, and each seller's share landed straight in their own PayPal account. The platform never holds the money." |
| 7 | 2:15-2:30 | claude.ai: "Can you give me 50% off?" Claude declines. "Is it paid?" Claude: COMPLETED | "The AI does real work, but money decisions stay on the server, and Claude only says paid when PayPal says so." |

Optional extra (15 s): the declined-card recovery. Run `money-path --simulate-decline` and show PayPal asking for another way to pay, then the order reaching COMPLETED.

---

## Before you submit

- [ ] **Trim the PayPal webhook** (Developer Dashboard > Apps > hackapal > Webhooks) to these three events: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.CAPTURE.DENIED`.
- [ ] **README:** replace the `Demo video` placeholder with the video link. The sandbox buyer note can stay pointing at Devpost.
- [ ] Rename the claude.ai connector to `hackapal`, if it still says "Auntie's Kitchen".
- [ ] Check that UptimeRobot is green, then open `/health` once right before submitting.
- [ ] Restock if needed (`npm run stock`, or ask me).
- [ ] Repo is public with the MIT licence (already true).
