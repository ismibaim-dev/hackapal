import { z } from 'zod';
import type { Catalog } from './catalog.js';
import { multiplyCents, sumCents, type Currency } from './money.js';

export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 10;
export const MAX_LINES = 20;

/**
 * What a caller (MCP tool, REST endpoint) may send. There are deliberately no price
 * fields: unknown keys are stripped, so a price from a model or client never gets in.
 */
export const CartItemSchema = z.object({
  product_id: z.string().trim().min(1).max(64).describe('Product id from list_products'),
  quantity: z
    .number()
    .int()
    .min(MIN_QUANTITY)
    .max(MAX_QUANTITY)
    .describe(`Whole number of units, ${MIN_QUANTITY} to ${MAX_QUANTITY}`),
});

export const CartInputSchema = z.object({
  items: z.array(CartItemSchema).min(1).max(MAX_LINES),
});

export type CartInput = z.infer<typeof CartInputSchema>;

export interface QuoteLine {
  productId: string;
  name: string;
  unit: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface Quote {
  currency: Currency;
  lines: QuoteLine[];
  /** Sum of line totals. Equals totalCents while there is no tax or shipping. */
  itemTotalCents: number;
  totalCents: number;
}

export type PricingIssue =
  | { code: 'UNKNOWN_PRODUCT'; productId: string; message: string }
  | { code: 'INVALID_QUANTITY'; productId: string; quantity: number; message: string }
  | { code: 'OUT_OF_STOCK'; productId: string; requested: number; available: number; message: string };

export type PricingResult = { ok: true; quote: Quote } | { ok: false; issues: PricingIssue[] };

/**
 * Prices a cart from the catalog only. Duplicate lines for the same product are
 * combined first, then every problem is collected so an agent can fix them in one go.
 * Read-only: stock is checked here and taken later, when a capture completes.
 */
export function priceCart(
  catalog: Catalog,
  input: CartInput,
  /** Live stock per product id (from a StockStore). Without it, the catalog's own stock is used. */
  stockLevels?: ReadonlyMap<string, number>,
): PricingResult {
  const issues: PricingIssue[] = [];
  const merged = new Map<string, { quantity: number; lines: number }>();

  // Each line is checked before merging (not only by the schema), so a caller that
  // skipped validation can't sneak a zero or negative line into a combined total.
  for (const item of input.items) {
    const productId = item.product_id.trim();
    if (!isValidQuantity(item.quantity)) {
      issues.push(quantityIssue(productId, item.quantity, ''));
      continue;
    }
    const entry = merged.get(productId) ?? { quantity: 0, lines: 0 };
    entry.quantity += item.quantity;
    entry.lines += 1;
    merged.set(productId, entry);
  }

  const lines: QuoteLine[] = [];

  for (const [productId, { quantity, lines: lineCount }] of merged) {
    const product = catalog.getProduct(productId);
    if (!product) {
      issues.push({
        code: 'UNKNOWN_PRODUCT',
        productId,
        message: `Unknown product_id "${productId}". Valid ids: ${catalog.productIds().join(', ')}.`,
      });
      continue;
    }

    if (!isValidQuantity(quantity)) {
      issues.push(quantityIssue(productId, quantity, lineCount > 1 ? ' after combining duplicate lines' : ''));
      continue;
    }

    const available = stockLevels ? (stockLevels.get(productId) ?? 0) : product.stock;
    if (quantity > available) {
      issues.push({
        code: 'OUT_OF_STOCK',
        productId,
        requested: quantity,
        available,
        message:
          available === 0
            ? `"${product.name}" is sold out.`
            : `Only ${available} left of "${product.name}" (asked for ${quantity}).`,
      });
      continue;
    }

    lines.push({
      productId,
      name: product.name,
      unit: product.unit,
      quantity,
      unitPriceCents: product.priceCents,
      lineTotalCents: multiplyCents(product.priceCents, quantity),
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  const itemTotalCents = sumCents(lines.map((l) => l.lineTotalCents));
  return {
    ok: true,
    quote: { currency: catalog.shop.currency, lines, itemTotalCents, totalCents: itemTotalCents },
  };
}

function isValidQuantity(quantity: unknown): quantity is number {
  return (
    typeof quantity === 'number' &&
    Number.isSafeInteger(quantity) &&
    quantity >= MIN_QUANTITY &&
    quantity <= MAX_QUANTITY
  );
}

function quantityIssue(productId: string, quantity: number, suffix: string): PricingIssue {
  return {
    code: 'INVALID_QUANTITY',
    productId,
    quantity,
    message: `Quantity for "${productId}" must be a whole number from ${MIN_QUANTITY} to ${MAX_QUANTITY}${suffix} (got ${quantity}).`,
  };
}
