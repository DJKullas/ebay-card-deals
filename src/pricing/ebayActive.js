/**
 * Fallback pricing provider: what are *other* sellers currently asking for the
 * same card in the same grade on eBay right now?
 *
 * Uses the listing's ePID (eBay catalogue product id) to pull active
 * fixed-price listings for the identical product, keeps the ones whose title
 * claims the same grader+grade, and returns the min (or median) asking price.
 *
 * Asking prices are a ceiling, not a sold price, so this is deliberately the
 * second choice after PriceCharting. It also spends RapidAPI quota (1 call per
 * lookup) which is why it's capped per run in config.
 */
import { detectGrade } from '../cards/parse.js';

export class EbayActiveProvider {
  constructor({ ebayClient, maxLookupsPerRun = 10, statistic = 'p25', minComparables = 2, canSpend = () => true }) {
    this.ebay = ebayClient;
    this.maxLookups = maxLookupsPerRun;
    this.statistic = statistic;
    this.minComparables = minComparables;
    this.canSpend = canSpend;
    this.lookups = 0;
    this.blockedByQuota = 0;
  }

  get name() {
    return 'ebay_active';
  }

  /**
   * @returns {Promise<{ marketValue:number, confidence:number, source:string, matchedName:string, matchedUrl:string, reasons:string[] } | null>}
   */
  async price(listing, parsed, { grade }) {
    if (!listing.epid) return null;
    if (this.lookups >= this.maxLookups) return null;
    if (!this.canSpend()) {
      this.blockedByQuota += 1;
      return null;
    }
    this.lookups += 1;

    const { items } = await this.ebay.search({
      query: `${grade.grader} ${grade.grade}`,
      epid: listing.epid,
      buyingOptions: ['FIXED_PRICE'],
      sort: 'price',
      limit: 50,
    });

    const comps = items
      .filter((it) => it.itemId !== listing.itemId)
      .filter((it) => {
        const g = detectGrade(it.title);
        return g.grader === grade.grader && g.grade === grade.grade;
      })
      .map((it) => (it.binPrice ?? it.currentPrice) + (it.shippingCost ?? 0))
      .filter((p) => Number.isFinite(p) && p > 0)
      .sort((a, b) => a - b);

    if (comps.length < this.minComparables) return null;

    const value = pickStatistic(comps, this.statistic);
    // Same ePID + same grade in title is a solid identity match; the price
    // itself is an ask, so cap confidence a little below PriceCharting's ceiling.
    const confidence = Math.min(0.9, 0.7 + 0.05 * comps.length);
    return {
      marketValue: value,
      confidence,
      source: `eBay active BIN (${this.statistic} of ${comps.length})`,
      matchedName: `${comps.length} active ${grade.grader} ${grade.grade} listings for ePID ${listing.epid}`,
      matchedUrl: `https://www.ebay.com/p/${listing.epid}`,
      reasons: [`epid ${listing.epid}`, `${comps.length} comparables`, `asks: ${comps.slice(0, 5).map((c) => `$${c.toFixed(0)}`).join(', ')}`],
    };
  }
}

/** sorted ascending -> min | p25 | median. p25 ignores the odd mis-titled $10 "PSA 10". */
export function pickStatistic(sorted, statistic) {
  if (!sorted.length) return null;
  if (statistic === 'min') return sorted[0];
  if (statistic === 'median') return sorted[Math.floor(sorted.length / 2)];
  return sorted[Math.floor((sorted.length - 1) * 0.25)];
}
