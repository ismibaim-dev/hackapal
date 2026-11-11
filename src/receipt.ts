import PDFDocument from 'pdfkit';
import type { ShopInfo } from './catalog.js';
import { formatUsd } from './money.js';
import type { Buyer } from './paypal.js';
import type { Order } from './store.js';

/**
 * The seller's payment receipt as a PDF, sent with the Telegram order card. Built in memory and
 * never stored: it holds the buyer's contact and address, which only that seller should see.
 * `order` is the seller's own slice (their lines, subtotal and capture in a combined checkout).
 */

const INK = '#1d1b18';
const MUTE = '#6b645c';
const LINE = '#e2d9cc';
const ACCENT = '#b4532a';
const GREEN = '#1f7a3d';

/** The built-in PDF fonts only cover Latin-1; anything else (emoji, CJK) would print as garbage. */
function latin1(text: string): string {
  return text.replace(/[^ -~ -ÿ]/gu, '?');
}

export function formatReceiptDate(iso: string): string {
  const d = new Date(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** Receipt number: unique per order and seller, so each seller's receipt in a combined checkout differs. */
export function receiptNumber(order: Order, shop: Readonly<ShopInfo>): string {
  return `${order.id.replace(/^ord_/, 'R-').toUpperCase()}-${shop.id.split('-').map((w) => w[0]).join('').toUpperCase()}`;
}

export interface ReceiptOptions {
  /** Test seam: uncompressed streams so the text can be searched. */
  compress?: boolean;
}

export function renderReceiptPdf(
  order: Order,
  shop: Readonly<ShopInfo>,
  buyer: Buyer | undefined,
  options: ReceiptOptions = {},
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 56,
    compress: options.compress ?? true,
    info: { Title: `Receipt ${receiptNumber(order, shop)}`, Author: shop.name, Producer: 'hackapal' },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const t = (s: string) => latin1(s);

  // Header: seller and the word RECEIPT, with a PAID stamp.
  doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(10).text('PAYMENT RECEIPT', left, 56, { characterSpacing: 1.5 });
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(24).text(t(shop.name), left, 72);
  doc.fillColor(MUTE).font('Helvetica').fontSize(10).text(t(`${shop.category} · ${shop.area}`), left, 102);
  doc.roundedRect(right - 92, 60, 92, 34, 6).lineWidth(2).strokeColor(GREEN).stroke();
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(16).text('PAID', right - 92, 70, { width: 92, align: 'center' });

  // Meta row.
  let y = 136;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(LINE).stroke();
  y += 14;
  const meta: [string, string][] = [
    ['Receipt no.', receiptNumber(order, shop)],
    ['Order', order.id],
    ['Paid on', formatReceiptDate(order.updatedAt)],
    ['Paid with', 'PayPal'],
  ];
  const shares = [0.3, 0.24, 0.3, 0.16];
  let x = left;
  meta.forEach(([k, v], i) => {
    const colW = width * shares[i]!;
    doc.fillColor(MUTE).font('Helvetica').fontSize(8.5).text(k.toUpperCase(), x, y, { width: colW - 8, characterSpacing: 0.6 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(t(v), x, y + 13, { width: colW - 8 });
    x += colW;
  });
  y += 44;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();

  // Buyer and delivery.
  y += 18;
  const half = width / 2;
  const block = (title: string, lines: string[], x: number) => {
    doc.fillColor(MUTE).font('Helvetica').fontSize(8.5).text(title.toUpperCase(), x, y, { characterSpacing: 0.6 });
    doc.fillColor(INK).font('Helvetica').fontSize(10.5);
    let ly = y + 14;
    for (const line of lines) {
      doc.text(t(line), x, ly, { width: half - 16 });
      ly = doc.y + 2;
    }
    return ly;
  };
  const billed = [buyer?.name, buyer?.email, buyer?.phone].filter((s): s is string => Boolean(s));
  const shipTo = buyer?.shipTo ? [buyer.shipTo.name, ...buyer.shipTo.lines].filter((s): s is string => Boolean(s)) : [];
  const yA = block('Billed to', billed.length > 0 ? billed : ['Shared by PayPal on request'], left);
  const yB = block(shipTo.length > 0 ? 'Deliver to' : 'Fulfilment', shipTo.length > 0 ? shipTo : ['Pickup or arranged with the seller'], left + half);
  y = Math.max(yA, yB) + 18;

  // Items table.
  const cols = { item: left, qty: left + width * 0.58, unit: left + width * 0.7, amount: left + width * 0.84 };
  doc.rect(left, y, width, 24).fill('#f4efe7');
  doc.fillColor(MUTE).font('Helvetica-Bold').fontSize(9);
  doc.text('ITEM', cols.item + 10, y + 8);
  doc.text('QTY', cols.qty, y + 8, { width: width * 0.1, align: 'right' });
  doc.text('UNIT PRICE', cols.unit, y + 8, { width: width * 0.13, align: 'right' });
  doc.text('AMOUNT', cols.amount, y + 8, { width: width * 0.16 - 10, align: 'right' });
  y += 24;
  for (const line of order.items) {
    const rowTop = y + 9;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text(t(line.name), cols.item + 10, rowTop, { width: width * 0.55 });
    const nameBottom = doc.y;
    doc.fillColor(MUTE).font('Helvetica').fontSize(9).text(t(line.unit), cols.item + 10, nameBottom + 1, { width: width * 0.55 });
    const rowBottom = doc.y;
    doc.fillColor(INK).font('Helvetica').fontSize(10.5);
    doc.text(String(line.quantity), cols.qty, rowTop, { width: width * 0.1, align: 'right' });
    doc.text(formatUsd(line.unitPriceCents), cols.unit, rowTop, { width: width * 0.13, align: 'right' });
    doc.text(formatUsd(line.lineTotalCents), cols.amount, rowTop, { width: width * 0.16 - 10, align: 'right' });
    y = rowBottom + 9;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
  }

  // Totals.
  y += 12;
  const totalX = left + width * 0.55;
  const totalW = width * 0.45 - 10;
  doc.fillColor(MUTE).font('Helvetica').fontSize(10.5).text('Subtotal', totalX, y);
  doc.fillColor(INK).text(formatUsd(order.totalCents), totalX, y, { width: totalW, align: 'right' });
  y += 18;
  doc.fillColor(MUTE).text('Delivery', totalX, y);
  doc.fillColor(INK).text('Arranged by the seller', totalX, y, { width: totalW, align: 'right' });
  y += 22;
  doc.moveTo(totalX, y).lineTo(right, y).lineWidth(1.5).strokeColor(INK).stroke();
  y += 10;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text(`Total paid (${order.currency})`, totalX, y);
  doc.text(formatUsd(order.totalCents), totalX, y, { width: totalW, align: 'right' });
  y += 30;

  // Payment reference and the buyer's note.
  doc.fillColor(MUTE).font('Helvetica').fontSize(9).text('PAYPAL CAPTURE', left, y, { characterSpacing: 0.6 });
  doc.fillColor(INK).font('Courier').fontSize(10).text(t(order.captureId ?? 'pending'), left, y + 13);
  y += 40;
  if (order.buyerNote) {
    doc.fillColor(MUTE).font('Helvetica').fontSize(9).text('NOTE FROM THE BUYER', left, y, { characterSpacing: 0.6 });
    doc.fillColor(INK).font('Helvetica-Oblique').fontSize(10.5).text(t(order.buyerNote), left, y + 14, { width });
    y = doc.y + 18;
  }

  // Footer.
  const footY = doc.page.height - doc.page.margins.bottom - 30;
  doc.moveTo(left, footY).lineTo(right, footY).lineWidth(1).strokeColor(LINE).stroke();
  doc.fillColor(MUTE).font('Helvetica').fontSize(8.5).text(
    t(`Issued by hackapal for ${shop.name}. Payment processed by PayPal (sandbox: no real money moved). Please contact the buyer to confirm delivery, pickup or the booking time.`),
    left,
    footY + 8,
    { width, align: 'center' },
  );

  doc.end();
  return done;
}
