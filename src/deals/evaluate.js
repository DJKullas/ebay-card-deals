/**
 * Decide whether a priced listing is a deal worth alerting on.
 */

/**
 * @param {object} listing   normalised eBay listing
 * @param {{ marketValue:number|null, confidence:number }} priced
 * @param {typeof import('../../config/scan.config.js').deal} rules
 * @returns {{ isDeal:boolean, reason:string, totalCost:number, marketValue:number|null, discountPct:number|null, savings:number|null }}
 */
export function evaluateDeal(listing, priced, rules) {
  const shipping = rules.includeShipping ? (listing.shippingCost ?? rules.assumedShippingUsd) : 0;
  const price = listing.currentPrice ?? listing.binPrice;
  const totalCost = (price ?? 0) + shipping;
  const market = priced?.marketValue ?? null;

  const base = { totalCost, marketValue: market, discountPct: null, savings: null };
  if (price === null || price === undefined) return { ...base, isDeal: false, reason: 'no price on listing' };
  if (market === null) return { ...base, isDeal: false, reason: 'no market value' };
  if ((priced.confidence ?? 0) < rules.minMatchConfidence) {
    return { ...base, isDeal: false, reason: `match confidence ${priced.confidence.toFixed(2)} < ${rules.minMatchConfidence}` };
  }

  const savings = market - totalCost;
  const discountPct = (savings / market) * 100;
  const out = { ...base, discountPct, savings };

  if (market < rules.minMarketValueUsd) return { ...out, isDeal: false, reason: `market $${market.toFixed(0)} < min $${rules.minMarketValueUsd}` };
  if (listing.isAuction && listing.bidCount < rules.minBidCount) return { ...out, isDeal: false, reason: `${listing.bidCount} bids < min ${rules.minBidCount}` };
  if (discountPct < rules.minDiscountPct) return { ...out, isDeal: false, reason: `${discountPct.toFixed(0)}% below market < ${rules.minDiscountPct}%` };
  if (savings < rules.minSavingsUsd) return { ...out, isDeal: false, reason: `$${savings.toFixed(0)} savings < $${rules.minSavingsUsd}` };

  return { ...out, isDeal: true, reason: `${discountPct.toFixed(0)}% below market` };
}
