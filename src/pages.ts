/**
 * Tiny HTML pages for the buyer's browser after PayPal (return, cancel, errors).
 * No templates or client JS; everything dynamic is escaped.
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export interface PageOptions {
  title: string;
  /** Plain text paragraphs; escaped. */
  paragraphs: string[];
  link?: { href: string; label: string };
  tone?: 'success' | 'info' | 'warning';
  /** The seller this page is about. Omitted: the platform's name. */
  shopName?: string;
}

const PLATFORM_NAME = 'hackapal';

const TONE_COLOUR = { success: '#1a7f37', info: '#0b57d0', warning: '#9a6700' } as const;

export function renderPage({ title, paragraphs, link, tone = 'info', shopName = PLATFORM_NAME }: PageOptions): string {
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n      ');
  const action = link ? `<p><a class="button" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>` : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>${escapeHtml(title)} - ${escapeHtml(shopName)}</title>
    <style>
      body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #faf7f2; color: #1f1f1f; margin: 0; }
      main { max-width: 32rem; margin: 12vh auto; padding: 2rem; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
      h1 { font-size: 1.4rem; color: ${TONE_COLOUR[tone]}; margin-top: 0; }
      p { line-height: 1.5; }
      .button { display: inline-block; padding: .6rem 1rem; background: #0070ba; color: #fff; border-radius: 6px; text-decoration: none; }
      small { color: #666; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      ${body}
      ${action}
      <p><small>${escapeHtml(shopName)} &middot; payments by PayPal (sandbox)</small></p>
    </main>
  </body>
</html>
`;
}

export interface DirectoryShop {
  name: string;
  category: string;
  area: string;
  description: string;
  products: number;
  mcpUrl: string;
}

/** The front page: what hackapal is and the MCP link for the marketplace and for each shop. */
export function renderDirectory({ marketplaceMcpUrl, shops }: { marketplaceMcpUrl: string; shops: DirectoryShop[] }): string {
  const cards = shops
    .map(
      (s) => `<li>
        <h2>${escapeHtml(s.name)}</h2>
        <p class="meta">${escapeHtml(s.category)} &middot; ${escapeHtml(s.area)} &middot; ${s.products} products</p>
        <p>${escapeHtml(s.description)}</p>
        <p class="meta">This shop only: <code>${escapeHtml(s.mcpUrl)}</code></p>
      </li>`,
    )
    .join('\n      ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${PLATFORM_NAME} - shops your AI assistant can buy from</title>
    <style>
      body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #faf7f2; color: #1f1f1f; margin: 0; }
      main { max-width: 44rem; margin: 6vh auto; padding: 0 1rem; }
      h1 { font-size: 1.6rem; margin-bottom: .25rem; }
      h2 { font-size: 1.1rem; margin: 0 0 .25rem; }
      p { line-height: 1.5; }
      ul { list-style: none; padding: 0; }
      li { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.08); padding: 1rem 1.25rem; margin: 0 0 1rem; }
      code { background: #f0ece4; padding: .1rem .35rem; border-radius: 4px; font-size: .9em; overflow-wrap: anywhere; }
      .meta, small { color: #666; font-size: .9rem; }
      .hero { background: #fff; border-radius: 12px; padding: 1rem 1.25rem; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
    </style>
  </head>
  <body>
    <main>
      <h1>${PLATFORM_NAME}</h1>
      <p>Small local sellers with no website, ready for AI assistants. Your assistant browses the shops and creates
        the order; you approve the payment in PayPal; the seller is paid directly and gets a message.</p>
      <div class="hero">
        <p><strong>Add this MCP server to your assistant</strong> (all shops):</p>
        <p><code>${escapeHtml(marketplaceMcpUrl)}</code></p>
        <p class="meta">Then ask: "What can I buy from the shops on hackapal?"</p>
      </div>
      <ul>
      ${cards}
      </ul>
      <p><small>Payments by PayPal (sandbox). No real money moves.</small></p>
    </main>
  </body>
</html>
`;
}
