/**
 * Primary pricing provider: PriceCharting (Pokemon/TCG) + SportsCardsPro (sports).
 * Searches the guide with a query built from the listing, scores the candidates
 * with cards/match.js, and reads the price for the requested grade.
 */
import { matchProduct } from '../cards/match.js';
import { PriceChartingClient, penniesToUsd } from './pricecharting.js';

export class PriceGuideProvider {
  /**
   * @param {{ client: PriceChartingClient, parallelKeywords: string[], optionalVariantTokens: string[] }} o
   */
  constructor({ client, parallelKeywords, optionalVariantTokens, requireCardNumber = true }) {
    this.client = client;
    this.parallelKeywords = parallelKeywords;
    this.optionalVariantTokens = optionalVariantTokens;
    this.requireCardNumber = requireCardNumber;
  }

  get name() {
    return 'pricecharting';
  }

  /**
   * @param {object} listing   normalised eBay listing
   * @param {object} parsed    parseListing() output
   * @param {{ category: object, grade: {grader:string, grade:number, priceKey:string} }} ctx
   */
  async price(listing, parsed, { category, grade }) {
    const site = category.priceGuide;
    if (!this.client.hasSite(site)) return null;
    if (!parsed.query) return null;
    // Without a card number the matcher can't reach the confidence bar, so
    // don't burn a rate-limited guide call.
    if (this.requireCardNumber && !parsed.cardNumber) return null;

    const candidates = await this.client.searchProducts(site, parsed.query);
    const match = matchProduct(parsed, candidates, {
      epid: listing.epid,
      productFilter: category.productFilter,
      parallelKeywords: this.parallelKeywords,
      optionalVariantTokens: this.optionalVariantTokens,
    });
    if (!match.product) {
      return { marketValue: null, confidence: 0, source: site, matchedName: null, matchedUrl: null, reasons: match.reasons, query: parsed.query };
    }

    // /api/products already carries every price field, so the per-product call
    // (which costs another second at the 1 req/s limit) is only a fallback.
    const product = grade.priceKey in match.product ? match.product : await this.client.getProduct(site, match.product.id);
    const marketValue = penniesToUsd(product[grade.priceKey]);
    const reasons = [...match.reasons];
    if (marketValue === null) reasons.push(`no ${grade.label ?? `${grade.grader} ${grade.grade}`} price in guide`);

    return {
      marketValue,
      confidence: match.confidence,
      source: site,
      matchedName: `${product['console-name']} — ${product['product-name']}`,
      matchedUrl: PriceChartingClient.productUrl({ ...product, site }),
      reasons,
      query: parsed.query,
      extra: {
        ungraded: penniesToUsd(product['loose-price']),
        grade9: penniesToUsd(product['graded-price']),
        salesVolume: product['sales-volume'] ?? null,
      },
    };
  }
}
