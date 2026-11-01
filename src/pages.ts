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
}

const TONE_COLOUR = { success: '#1a7f37', info: '#0b57d0', warning: '#9a6700' } as const;

export function renderPage({ title, paragraphs, link, tone = 'info' }: PageOptions): string {
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n      ');
  const action = link ? `<p><a class="button" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>` : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>${escapeHtml(title)} - Auntie's Kitchen</title>
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
      <p><small>Auntie's Kitchen &middot; payments by PayPal (sandbox)</small></p>
    </main>
  </body>
</html>
`;
}
