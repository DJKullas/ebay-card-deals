// ---------------------------------------------------------------------------
// Editable scan settings. Everything a human is likely to want to tweak lives
// here. Secrets (API keys, SMTP creds) live in environment variables instead —
// see .env.example.
// ---------------------------------------------------------------------------

/** Timing */
export const schedule = {
  // How often to scan. This is THE cost/tightness knob: each scan costs one
  // RapidAPI request per category (2), so requests/month ≈ 2 × 43,200 / interval.
  //   10 min → 8,640  (fits the 10,000/month Pro plan)   alerts arrive 5-16 min out
  //    5 min → 17,280 (needs the Ultra plan, or ~$65/mo overage)  alerts 5-11 min out
  // Auction bids arrive in the last minutes, so the closer to the end we look
  // the less "below market" is an illusion — but every halving of the interval
  // doubles the eBay bill. Change lookaheadMinutes together with this.
  scanIntervalMinutes: 10,

  // An alert is only useful if there is time to look at the card before the
  // auction ends. Listings ending sooner than this are ignored, and a deal is
  // dropped rather than sent if pricing pushed it under this.
  minMinutesLeft: 5,

  // How far ahead to look. Each scan covers [minMinutesLeft, lookaheadMinutes]
  // = 5-16 min. Must be >= minMinutesLeft + scanIntervalMinutes so consecutive
  // scans leave no gap; the extra minute covers a scan starting a little late.
  lookaheadMinutes: 16,

  // GitHub's cron scheduler is far too erratic for this (it fired a "*/15"
  // schedule 6 times in 14 hours), so the workflow instead runs ONE long job
  // that loops internally (`node src/index.js --loop`), scanning every
  // scanIntervalMinutes for loopMinutes and then exiting so the state cache
  // can be saved. GitHub kills jobs at 6 hours; leave room for the last scan
  // (pricing.maxRunSeconds) to finish.
  loopMinutes: 340,
  // The workflow cron launches a fresh looping job this often. It is shorter
  // than loopMinutes on purpose: the concurrency group holds the newcomer in
  // "pending" until the running job exits, so coverage is seamless even when a
  // cron tick is skipped or hours late. Must match the cron in scan.yml (tested).
  launchEveryHours: 3,
};

/** eBay search behaviour (RapidAPI "Real-Time eBay Data", /ebay_search) */
export const ebay = {
  marketplaceTld: 'com',

  // AUCTION, FIXED_PRICE, BEST_OFFER. Auctions are the point of an
  // "ending soon" scan; most fixed-price listings are Good-'Til-Cancelled and
  // have no end date at all (eBay still returns them, we drop them).
  buyingOptions: ['AUCTION'],

  // Max results per API call (eBay caps this at 200). Results are sorted by
  // ending soonest. The first page of every search is always fetched; when a
  // search has more in-window results than one page (Sunday evenings can have
  // 1,000+ autograph auctions ending in 25 minutes) extra pages are fetched
  // up to maxPagesPerSearch — but only as far as the RapidAPI quota allows:
  // the spare quota (whatever is left after reserving the mandatory first
  // pages for every remaining run in the billing period) is spread over the
  // remaining runs, × extraPageBurst so quiet hours bank pages for busy ones.
  // Listings we can't afford to fetch are the latest-ending ones and are
  // often picked up by the next run.
  pageSize: 200,
  maxPagesPerSearch: 4,
  extraPageBurst: 4,

  // Your RapidAPI plan's monthly request allowance (Pro = 10,000), used for the
  // usage estimate printed at startup. Overage is billed per request.
  rapidApiMonthlyLimit: 10000,
  // When true, optional RapidAPI spending (extra search pages, the eBay
  // active-listing price fallback, item-specifics fetches) is limited to what
  // the remaining quota reported by RapidAPI can cover after the mandatory
  // first-page searches for the rest of the billing period (+ a small
  // reserve). The core scan keeps running; you just never pay overage.
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
 *   queryPrefix      optional words prepended to every target's eBay search query
 *                    (the CCG category mixes every card game together)
 *   titleExclude     optional regex; listings whose title matches are ignored
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
    queryPrefix: 'pokemon',
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
 * What we are hunting for. All targets that apply to a category share ONE
 * eBay search (their search terms are OR-ed: sports = "(psa 10,auto,autograph)"),
 * so the mandatory RapidAPI cost per scan = number of categories (plus extra
 * pages when quota allows, see `ebay`). A listing is kept when it satisfies at
 * least one target's `require` (parsed from the title); if it satisfies
 * several, the strictest deal rules among them apply.
 *
 *   searchTerms   eBay keywords (fuzzy; `require` is what really enforces it).
 *                 "auto" alone misses titles that only say "Autograph".
 *   conditionIds  eBay condition filter. 2750 = Graded, 4000 = Ungraded for
 *                 trading cards; [] = any. Only applied to the shared search if
 *                 every target of the category agrees.
 *   minPrice      skip auctions whose current bid is below this (USD). The
 *                 lowest across a category's targets is used. Cuts the
 *                 $0.99-start noise that eats search pages; with bids arriving
 *                 in the last minutes a sub-$20 bid on a card worth $25+ is not
 *                 a deal signal anyway. At $20, Sunday-evening peak is ~100
 *                 sports + ~60 Pokémon listings per 5 min, i.e. one page each.
 *   require       { grader, grade } = that exact grade
 *                 { autograph: true } = title says auto/autograph/signed;
 *                 any grade, or raw (priced against the guide's ungraded value)
 *   titleExclude  listings of this kind we refuse to price at all (the whole
 *                 listing is dropped, even if another target also matches it)
 *   deal          overrides for `deal` below (stricter for harder-to-match cards)
 *
 * To also watch PSA 9s, add { key:'psa9', searchTerms:['psa 9'], require:{grader:'PSA', grade:9}, ... }.
 */
export const targets = [
  {
    key: 'psa10',
    label: 'PSA 10',
    categoryKeys: ['pokemon', 'sports'],
    searchTerms: ['psa 10'],
    conditionIds: ['2750'],
    minPrice: 20,
    require: { grader: 'PSA', grade: 10 },
  },
  {
    key: 'auto',
    label: 'Autograph',
    // Pokemon has no pack-pulled autographs (and the guide has no auto products).
    categoryKeys: ['sports'],
    searchTerms: ['auto', 'autograph'],
    conditionIds: [],
    minPrice: 20,
    require: { autograph: true },
    // Only pack-pulled, manufacturer-certified autos can be priced against the
    // guide. Anything hand-signed / third-party authenticated (JSA, BAS,
    // PSA/DNA, COA), redemptions, multi-player autos, reprints and damaged raw
    // cards are skipped — we would rather miss a card than mis-price one.
    titleExclude:
      /\b(in[\s-]?person|ip\s*auto|hand[\s-]?signed|signed\s+(?:in|at|by)\b|jsa|bas\b|beckett\s*(?:auth|coa|witness)|psa\s*\/\s*dna|dna|dsa|coa|witnessed|redemption|facsimile|reprint|rp\b|custom|novelty|cut\s*(?:auto|signature)|buyback|dual|triple|quad|booklet|mystery|damaged|crease|creased|bent|torn|poor|played)\b/i,
    deal: {
      // Autos have many look-alike products (parallels, sticker vs on-card,
      // different insert sets), so demand a tighter match and a bigger gap.
      minMatchConfidence: 0.85,
      minDiscountPct: 35,
      minMarketValueUsd: 40,
    },
  },
];

/**
 * Which PriceCharting field holds the value for a given grade. Keys are
 * "GRADER grade" for grader-specific fields, a bare grade for grader-agnostic
 * ones, and "raw" for ungraded cards. Grades with no entry are not priced.
 */
export const gradePriceKeys = {
  'PSA 10': 'manual-only-price',
  'BGS 10': 'bgs-10-price',
  'CGC 10': 'condition-17-price',
  'SGC 10': 'condition-18-price',
  9.5: 'box-only-price',
  9: 'graded-price',
  8.5: 'new-price',
  8: 'new-price',
  7.5: 'cib-price',
  7: 'cib-price',
  raw: 'loose-price',
};

/** What counts as a deal (per-target overrides live in `targets[].deal`) */
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
  // 'ebay_active' (asking prices of other sellers for the same ePID) is
  // available as a fallback but off by default: it costs RapidAPI requests we
  // no longer have spare with three searches per run, it can't price raw
  // cards, and asks are a weaker signal than the guide.
  providers: ['pricecharting'],
  // Hard caps so a scan finishes before the next one starts. At ~1.1s per new
  // listing the time budget is what stops a busy scan (~400 listings); the
  // soonest-ending are priced first and the rest roll over to the next scan.
  maxListingsPerRun: 500,
  maxRunSeconds: 480,
  // PriceCharting values update daily; cache lookups this long.
  cacheTtlHours: 24,
  // Listings priced in parallel. The guide allows 1 request/second (the
  // RateLimiter enforces that on request starts) and a call takes 1-4s, so
  // ~5 in flight keeps the limiter busy; more buys nothing.
  concurrency: 5,
  pricecharting: {
    // PriceCharting allows 1 request/second (request starts, see RateLimiter).
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
  // 'each'   = every deal is emailed the moment it is found (minutes matter
  //            when the auction ends in 5-16 of them)
  // 'digest' = one email per scan listing every deal, sent when the scan ends
  mode: 'each',
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
