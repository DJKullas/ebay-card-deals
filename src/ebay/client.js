/**
 * Client for the RapidAPI "Real-Time eBay Data" API
 * (https://rapidapi.com/mahmudulhasandev/api/real-time-ebay-data).
 *
 * Endpoints used:
 *   GET /ebay_search      – wraps eBay's Browse API item_summary/search. Supports
 *                           category_ids, epid, sort=endingSoonest and the Browse
 *                           `filter` syntax (buyingOptions, itemEndDate, conditionIds...).
 *   GET /product_get.php  – scrapes a single listing page; the only way to get
 *                           item specifics (Card Number, Set, Certification Number).
 */
import { fetchJson } from '../util/http.js';

const HOST = 'real-time-ebay-data.p.rapidapi.com';

export class EbayClient {
  constructor({ apiKey, tld = 'com' }) {
    if (!apiKey) throw new Error('RAPIDAPI_KEY is required');
    this.headers = { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': HOST };
    this.tld = tld;
    this.requestCount = 0;
    /** Monthly quota as reported by RapidAPI on the last response. */
    this.quota = { limit: null, remaining: null, resetSeconds: null };
  }

  /**
   * Can we afford an *optional* request without eating into what the
   * mandatory searches need for the rest of the billing period?
   */
  canSpendOptional({ intervalMinutes, mandatoryPerRun, reserve = 100 }) {
    const { remaining, resetSeconds } = this.quota;
    if (remaining === null || resetSeconds === null) return true; // unknown → don't block
    const runsLeft = Math.ceil(resetSeconds / (intervalMinutes * 60));
    return remaining - runsLeft * mandatoryPerRun - reserve > 0;
  }

  async #get(path, params) {
    const url = new URL(`https://${HOST}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    this.requestCount += 1;
    return fetchJson(url.toString(), {
      headers: this.headers,
      onResponse: (res) => {
        const n = (h) => (res.headers.get(h) ? Number(res.headers.get(h)) : null);
        this.quota = {
          limit: n('x-ratelimit-requests-limit') ?? this.quota.limit,
          remaining: n('x-ratelimit-requests-remaining') ?? this.quota.remaining,
          resetSeconds: n('x-ratelimit-requests-reset') ?? this.quota.resetSeconds,
        };
      },
    });
  }

  /**
   * Search listings via the Browse API wrapper.
   * @param {object} o
   * @param {string} o.query
   * @param {string[]} [o.categoryIds]
   * @param {string} [o.epid]
   * @param {string[]} [o.buyingOptions]  e.g. ['AUCTION','FIXED_PRICE']
   * @param {string[]} [o.conditionIds]
   * @param {Date} [o.endBefore]          only items ending before this time
   * @param {string} [o.sort]             endingSoonest | price | -price | newlyListed
   * @param {number} [o.limit]
   * @param {number} [o.offset]
   */
  async search({ query, categoryIds, epid, buyingOptions, conditionIds, endBefore, sort = 'endingSoonest', limit = 200, offset = 0 }) {
    const filters = [];
    if (buyingOptions?.length) filters.push(`buyingOptions:{${buyingOptions.join('|')}}`);
    if (conditionIds?.length) filters.push(`conditionIds:{${conditionIds.join('|')}}`);
    // NOTE: the RapidAPI wrapper silently drops itemEndDate when it has a lower
    // bound ("[lo..hi]"), so only the upper bound is sent and callers must
    // filter on endDate themselves (eBay never returns ended items anyway).
    if (endBefore) filters.push(`itemEndDate:[..${isoNoMillis(endBefore)}]`);
    const data = await this.#get('/ebay_search', {
      q: query,
      category_ids: categoryIds?.join(','),
      epid,
      filter: filters.join(',') || undefined,
      sort,
      limit,
      offset,
    });
    return {
      total: Number(data.total ?? 0),
      items: (data.itemSummaries ?? []).map(normaliseSummary),
    };
  }

  /**
   * Fetch every page of a search (up to maxPages).
   */
  async searchAll(opts, { maxPages = 2, pageSize = 200 } = {}) {
    const all = [];
    let total = Infinity;
    for (let page = 0; page < maxPages && page * pageSize < total; page += 1) {
      const { total: t, items } = await this.search({ ...opts, limit: pageSize, offset: page * pageSize });
      total = t;
      all.push(...items);
      if (items.length < pageSize) break;
    }
    return { total, items: all };
  }

  /**
   * Scrape a listing page for item specifics. Slow (~5-8s). Returns
   * { specifics: {name: value}, description, title } or null on failure.
   */
  async itemDetails(itemWebUrl) {
    const clean = itemWebUrl.split('?')[0];
    const data = await this.#get('/product_get.php', { url: clean });
    const body = data?.body;
    if (!body) return null;
    const specifics = {};
    for (const row of body.productInformation ?? []) {
      if (row?.name && row?.value) specifics[row.name] = String(row.value);
    }
    return { title: body.title, specifics, description: body.description ?? '' };
  }
}

function isoNoMillis(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Flatten an eBay itemSummary into the fields the rest of the app uses. */
export function normaliseSummary(it) {
  const buyingOptions = it.buyingOptions ?? [];
  const isAuction = buyingOptions.includes('AUCTION');
  const bid = num(it.currentBidPrice?.value);
  const bin = num(it.price?.value);
  const ship = it.shippingOptions?.[0]?.shippingCost;
  return {
    itemId: it.itemId,
    legacyItemId: it.legacyItemId ?? String(it.itemId ?? '').split('|')[1],
    title: it.title ?? '',
    url: (it.itemWebUrl ?? '').split('?')[0],
    imageUrl: it.image?.imageUrl ?? null,
    epid: it.epid ?? null,
    categoryId: it.leafCategoryIds?.[0] ?? it.categories?.[0]?.categoryId ?? null,
    condition: it.condition ?? null,
    conditionId: it.conditionId ?? null,
    buyingOptions,
    isAuction,
    bidCount: Number(it.bidCount ?? 0),
    // For an auction the relevant number is the current bid; for BIN the price.
    currentPrice: isAuction && bid !== null ? bid : bin,
    binPrice: bin,
    currency: it.currentBidPrice?.currency ?? it.price?.currency ?? 'USD',
    shippingCost: ship ? num(ship.value) : null,
    shippingType: it.shippingOptions?.[0]?.shippingCostType ?? null,
    endDate: it.itemEndDate ? new Date(it.itemEndDate) : null,
    seller: it.seller?.username ?? null,
    sellerFeedbackScore: it.seller?.feedbackScore ?? null,
    sellerFeedbackPct: it.seller?.feedbackPercentage ?? null,
    itemLocationCountry: it.itemLocation?.country ?? null,
  };
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
