/**
 * PriceCharting / SportsCardsPro price guide client.
 *   https://www.pricecharting.com/api-documentation
 *   https://www.sportscardspro.com/api-documentation
 *
 * Both sites share the same API shape; PriceCharting covers Pokemon/TCG,
 * SportsCardsPro covers sports. Prices are integers in pennies. For cards,
 * `manual-only-price` is PSA 10, `graded-price` is grade 9, etc. (see
 * config/scan.config.js -> grades for the full mapping).
 *
 * Rate limit: 1 request/second per the docs. We share one limiter across sites.
 */
import { fetchJson, RateLimiter } from '../util/http.js';

const SITES = {
  pricecharting: 'https://www.pricecharting.com',
  sportscardspro: 'https://www.sportscardspro.com',
};

export class PriceChartingClient {
  /**
   * @param {{ tokens: Record<string,string>, minMsBetweenRequests?: number, cache?: import('../state/store.js').Store }} o
   */
  constructor({ tokens, minMsBetweenRequests = 1100, cache = null }) {
    this.tokens = tokens; // { pricecharting: '...', sportscardspro: '...' }
    this.limiter = new RateLimiter(minMsBetweenRequests);
    this.cache = cache;
    this.requestCount = 0;
  }

  hasSite(site) {
    return Boolean(this.tokens[site]);
  }

  async #get(site, path, params) {
    const token = this.tokens[site];
    if (!token) throw new Error(`no API token configured for ${site}`);
    const url = new URL(path, SITES[site]);
    url.searchParams.set('t', token);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    // PriceCharting occasionally answers 404 + {"error":"... DeadlineExceeded"}
    // for a perfectly good query; one retry almost always fixes it.
    for (let attempt = 1; ; attempt += 1) {
      this.requestCount += 1;
      try {
        const data = await this.limiter.schedule(() => fetchJson(url.toString(), { retries: 1 }));
        if (data.status !== 'success') throw new Error(`${site} error: ${data['error-message'] ?? 'unknown'}`);
        return data;
      } catch (err) {
        if (attempt <= 2 && /Deadline|timeout|HTTP 5\d\d/i.test(err.message)) continue;
        throw err;
      }
    }
  }

  /** Would searchProducts() be answered from the cache (no rate-limited call)? */
  isSearchCached(site, q) {
    return Boolean(this.cache?.get(`pc:search:${site}:${q.toLowerCase()}`));
  }

  /** Up to 20 products matching a free-text query, each with its full price row. */
  async searchProducts(site, q) {
    const key = `pc:search:${site}:${q.toLowerCase()}`;
    const cached = this.cache?.get(key);
    if (cached) return cached;
    const data = await this.#get(site, '/api/products', { q });
    const products = (data.products ?? []).map((p) => ({ ...p, site }));
    this.cache?.set(key, products);
    return products;
  }

  /** Full product row including prices. */
  async getProduct(site, id) {
    const key = `pc:product:${site}:${id}`;
    const cached = this.cache?.get(key);
    if (cached) return cached;
    const data = await this.#get(site, '/api/product', { id });
    const { status: _s, ...product } = data;
    product.site = site;
    this.cache?.set(key, product);
    return product;
  }

  static productUrl(product) {
    return `${SITES[product.site] ?? SITES.pricecharting}/game/${product.id}`;
  }
}

/** Convert a pennies field to dollars, or null when missing/zero. */
export function penniesToUsd(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n / 100 : null;
}
