// ---------------------------------------------------------------------------
// Editable scan settings. Everything a human is likely to want to tweak lives
// here. Secrets (API keys, SMTP creds) live in environment variables instead —
// see .env.example.
// ---------------------------------------------------------------------------

/** Timing */
export const schedule = {
  // How often the job runs. This MUST match the cron in
  // .github/workflows/scan.yml (a unit test checks that they agree).
  scanIntervalMinutes: 10,

  // Extra look-ahead added to the interval. With 10 + 5 the scanner looks for
  // listings ending in the next 15 minutes, so a late cron tick doesn't miss
  // anything.
  windowBufferMinutes: 5,
};

/** eBay search behaviour (RapidAPI "Real-Time eBay Data", /ebay_search) */
export const ebay = {
  marketplaceTld: 'com',

  // Free-text query sent to eBay for every category. eBay's search is fuzzy,
  // so the grade filter below is what actually enforces "PSA 10".
  searchQuery: 'psa 10',

  // AUCTION, FIXED_PRICE, BEST_OFFER. Auctions are the point of an
  // "ending soon" scan; most fixed-price listings are Good-'Til-Cancelled and
  // have no end date at all (eBay still returns them, we drop them).
  buyingOptions: ['AUCTION'],

  // eBay condition id 2750 = "Graded" for trading cards. Leave empty to
  // disable the condition filter.
  conditionIds: ['2750'],

  // Max results per API call (eBay caps this at 200) and how many pages to
  // fetch per category per run. Results are sorted by ending soonest, so
  // listings that fall off the end of the last page are simply picked up on
  // the next run when they are closer to ending. ~100 PSA-10 auctions end per
  // 15 minutes across both categories, so one page is normally enough.
  pageSize: 200,
  maxPages: 1,

  // Your RapidAPI plan's monthly request allowance (Pro = 10,000), used for the
  // usage estimate printed at startup. Overage is billed per request.
  rapidApiMonthlyLimit: 10000,
  // When true, optional RapidAPI spending (the eBay active-listing price
  // fallback, item-specifics fetches) is suspended as soon as the remaining
  // quota reported by RapidAPI is only enough to cover the mandatory search
  // calls for the rest of the billing period (+ a small reserve). The core
  // scan keeps running; you just never pay overage for the extras.
  protectQuota: true,
  quotaReserve: 100,

  // Fetch full item specifics (Card Number, Set, Certification Number ...)
  // for listings via the scraper endpoint. Costs one extra API call and ~5-8s
  // per listing, so it is off by default.
  //   'never'     - only use the search result title
  //   'unmatched' - only when the title alone did not produce a confident match
  //   'always'    - every listing (expensive)
  detailFetch: 'never',
  maxDetailFetches: 10,
};

/**
 * Card categories to scan. Add an entry to expand coverage.
 *   kind             'tcg' or 'sports' – controls how titles are parsed
 *   ebayCategoryIds  183454 = CCG Individual Cards, 261328 = Sports Trading Card Singles
 *   searchQuery      optional per-category override of ebay.searchQuery
 *   titleExclude     optional regex; listings whose title matches are ignored
 *                    (the CCG category mixes every card game together)
 *   priceGuide       which price guide site to query ('pricecharting' | 'sportscardspro')
 *   productFilter    regex applied to the price guide's "console-name" (set name) so a
 *                    Pokemon scan doesn't match One Piece / MTG products, etc.
 */
export const categories = [
  {
    key: 'pokemon',
    label: 'Pokémon',
    kind: 'tcg',
    ebayCategoryIds: ['183454'],
    searchQuery: 'pokemon psa 10',
    titleExclude: /\b(one\s*piece|optcg|op\d{2}-\d{3}|st\d{2}-\d{3}|magic|mtg|yu-?gi-?oh|lorcana|weiss|schwarz|digimon|dragon\s*ball|union\s*arena|star\s*wars|riftbound|flesh\s*and\s*blood|metazoo|gundam|naruto)\b/i,
    priceGuide: 'pricecharting',
    productFilter: /^pokemon\b/i,
  },
  {
    key: 'sports',
    label: 'Sports cards',
    kind: 'sports',
    ebayCategoryIds: ['261328'],
    priceGuide: 'sportscardspro',
    productFilter: /\bcards\b/i,
  },
];

/**
 * Grades we care about. A listing must match one of these (parsed from the
 * title / item specifics) or it is ignored. `priceKey` is the PriceCharting
 * field that holds the value for that grade:
 *   manual-only-price  PSA 10          graded-price   grade 9
 *   bgs-10-price       BGS 10          box-only-price grade 9.5
 *   condition-17-price CGC 10          new-price      grade 8 / 8.5
 *   condition-18-price SGC 10          loose-price    ungraded
 * To also watch PSA 9s, add { grader: 'PSA', grade: 9, priceKey: 'graded-price' }.
 */
export const grades = [
  { grader: 'PSA', grade: 10, priceKey: 'manual-only-price' },
];

/** What counts as a deal */
export const deal = {
  // Alert when (current price + shipping) is at least this % below market.
  minDiscountPct: 30,
  // Ignore cards whose market value is below this (not worth the email).
  minMarketValueUsd: 25,
  // ...and require at least this many dollars of headroom.
  minSavingsUsd: 15,
  // Include shipping in the "what you'd pay" number. When eBay doesn't return a
  // shipping cost (calculated shipping) this assumed amount is used.
  includeShipping: true,
  assumedShippingUsd: 5,
  // Minimum confidence (0-1) that we matched the listing to the right price
  // guide product. Below this we don't trust the market value and stay quiet.
  minMatchConfidence: 0.75,
  // Without a card number we can never be confident which card it is, so
  // listings with no number in the title (or item specifics, if fetched) are
  // skipped without spending a price-guide call.
  requireCardNumber: true,
  // Auctions with fewer bids than this are skipped (0 = don't care). Useful if
  // you only want cards that already have real bidding interest.
  minBidCount: 0,
};

/** Pricing providers, tried in order until one returns a confident price */
export const pricing = {
  providers: ['pricecharting', 'ebay_active'],
  // Hard caps so a run finishes inside the cron window.
  maxListingsPerRun: 150,
  maxRunSeconds: 420,
  // PriceCharting values update daily; cache lookups this long.
  cacheTtlHours: 24,
  pricecharting: {
    // PriceCharting allows 1 request/second.
    minMsBetweenRequests: 1100,
  },
  // Fallback: what other sellers are currently asking for the same eBay
  // catalogue product (ePID) in the same grade. Costs ONE RapidAPI request per
  // lookup (≈ $0.009 each beyond the plan allowance), so it is capped per run.
  // Lookups go to the soonest-ending listings first.
  ebayActive: {
    maxLookupsPerRun: 3,
    // 'min' = cheapest active BIN, 'p25' = 25th percentile (ignores the odd
    // mis-titled junk listing), 'median'
    statistic: 'p25',
    // Need at least this many comparable active listings to trust the number.
    minComparables: 2,
  },
};

/** Notifications */
export const notify = {
  // 'digest' = one email per run listing every deal, 'each' = one email per deal
  mode: 'digest',
  timezone: 'America/New_York',
  subjectPrefix: '[Card Deals]',
  // Don't re-alert the same eBay item within this many hours.
  dedupeHours: 24,
};

/**
 * Words that indicate a parallel / variant. Used when matching a listing
 * against price guide products so a base-card listing is not priced as a
 * rare parallel (or vice versa).
 */
export const parallelKeywords = [
  // sports parallels / colours
  'silver', 'gold', 'red', 'blue', 'green', 'orange', 'purple', 'pink', 'black',
  'white', 'bronze', 'platinum', 'aqua', 'teal', 'neon', 'mojo', 'ice', 'wave',
  'shimmer', 'disco', 'shock', 'scale', 'dragon', 'tie-dye', 'tiedye', 'camo',
  'cracked', 'hyper', 'lazer', 'laser', 'fast', 'break', 'velocity', 'zebra',
  'snakeskin', 'sparkle', 'sepia', 'x-fractor', 'xfractor', 'atomic', 'sapphire',
  'superfractor', 'printing', 'plate', 'auto', 'autograph', 'refractor',
  // TCG variants
  '1st', 'first', 'edition', 'shadowless', 'reverse', 'holo', 'unlimited',
  'staff', 'promo', 'error', 'misprint', 'sequential',
];

/**
 * Variant words that are optional when comparing against a price guide product.
 * e.g. the guide says "[White Prizm Shock]" but sellers write "White Shock".
 */
export const optionalVariantTokens = ['prizm', 'refractor', 'optic', 'holo', 'parallel', 'mosaic'];
