import { createCatalog, SHOPS, type Catalog, type Product, type ShopInfo, type ShopSeed, type StockResult } from './catalog.js';

/**
 * The marketplace: several small sellers, each with its own catalog, prices and PayPal
 * payee (design decision 16). Shops are defined in code (src/catalog.ts). Product ids are
 * unique across the whole platform, so a product id alone names its shop and the stock
 * tables need no shop column.
 */

/** The stock-related part of a catalog. A single Catalog satisfies it, and so does the platform. */
export type Inventory = Pick<Catalog, 'listProducts' | 'getProduct' | 'productIds' | 'takeStock' | 'setStock'>;

/** A product with the shop that sells it. */
export interface ShopProduct extends Product {
  shopId: string;
}

export interface Platform {
  /** Every shop, in display order. */
  shops(): Readonly<ShopInfo>[];
  shop(shopId: string): Readonly<ShopInfo> | undefined;
  catalog(shopId: string): Catalog | undefined;
  /** The shop that sells this product, if any. */
  shopOfProduct(productId: string): Readonly<ShopInfo> | undefined;
  /** All products of all shops, for the stock stores. */
  readonly inventory: Inventory;
}

export class PlatformConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformConfigError';
  }
}

/** Build the platform from catalogs. Refuses duplicate shop or product ids at startup. */
export function platformFromCatalogs(catalogs: readonly Catalog[]): Platform {
  if (catalogs.length === 0) throw new PlatformConfigError('a platform needs at least one shop');
  const byShop = new Map<string, Catalog>();
  const byProduct = new Map<string, Catalog>();
  for (const catalog of catalogs) {
    if (byShop.has(catalog.shop.id)) throw new PlatformConfigError(`duplicate shop id "${catalog.shop.id}"`);
    byShop.set(catalog.shop.id, catalog);
    for (const productId of catalog.productIds()) {
      const other = byProduct.get(productId);
      if (other) {
        throw new PlatformConfigError(
          `product id "${productId}" is used by both "${other.shop.id}" and "${catalog.shop.id}"; product ids must be unique`,
        );
      }
      byProduct.set(productId, catalog);
    }
  }

  const owner = (productId: string): Catalog => {
    const catalog = byProduct.get(productId);
    if (!catalog) throw new Error(`Unknown product: ${productId}`);
    return catalog;
  };

  const inventory: Inventory = {
    listProducts: () => catalogs.flatMap((c) => c.listProducts()),
    getProduct: (id) => byProduct.get(id)?.getProduct(id),
    productIds: () => [...byProduct.keys()],
    takeStock: (productId, quantity): StockResult => owner(productId).takeStock(productId, quantity),
    setStock: (productId, stock) => owner(productId).setStock(productId, stock),
  };

  return {
    shops: () => catalogs.map((c) => c.shop),
    shop: (shopId) => byShop.get(shopId)?.shop,
    catalog: (shopId) => byShop.get(shopId),
    shopOfProduct: (productId) => byProduct.get(productId)?.shop,
    inventory,
  };
}

/** The platform with the demo shops (or the given seeds). Each call gets fresh in-memory stock. */
export function createPlatform(seeds: readonly Readonly<ShopSeed>[] = SHOPS): Platform {
  return platformFromCatalogs(seeds.map((seed) => createCatalog(seed)));
}

/** What agents may see about a shop. Leaves out the payee: a seller's PayPal account is not public. */
export function publicShop(shop: Readonly<ShopInfo>): Omit<ShopInfo, 'payeeEmail'> {
  const { payeeEmail: _payee, ...rest } = shop;
  return rest;
}
