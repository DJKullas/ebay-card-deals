# ebay-card-deals

Every 10 minutes, look at eBay auctions for graded sports and Pokémon cards that end in the next 15 minutes, work out what each card is actually worth, and email you when one is going cheap.

Currently limited to **PSA 10**; adding other grades/graders or other card categories is a one-line config change (see [Expanding coverage](#expanding-coverage)).

## How it works

```
GitHub Actions cron (*/10)
  └─ src/index.js
       1. eBay search  ─ RapidAPI "Real-Time eBay Data" /ebay_search (wraps eBay Browse API)
          auctions in category 183454 (CCG singles) + 261328 (sports singles),
          sorted ending-soonest, itemEndDate <= now + 15 min
       2. parse title  ─ grader/grade, card number, year, set words, parallel words
          keep only PSA 10, drop anything already alerted
       3. price it     ─ providers, in order, until one is confident:
            a. PriceCharting (Pokémon) / SportsCardsPro (sports)  -> PSA 10 value
            b. eBay active listings for the same ePID + grade      -> 25th-pct ask
          each answer carries a 0–1 confidence that we matched the RIGHT card
       4. evaluate     ─ (bid + shipping) vs market: ≥30% below, ≥$15 saved, market ≥ $25,
          confidence ≥ 0.75  =>  deal
       5. notify       ─ one digest email (and/or Discord) with links to the listings
```

State (which items were already alerted + a 24h cache of price lookups) is kept in `state/state.json` and persisted between Actions runs with `actions/cache`.

## APIs used and why

| Purpose | API | Cost | Notes |
| --- | --- | --- | --- |
| eBay listings ending soon | [Real-Time eBay Data (RapidAPI)](https://rapidapi.com/mahmudulhasandev/api/real-time-ebay-data) – `/ebay_search` | Pro plan: $10/mo for 10,000 req, then **$0.009/req** | This endpoint wraps eBay's official Browse API, so you get structured `itemEndDate`, `currentBidPrice`, `epid`, seller stats, etc. Its `sold_items` mode is useless (eBay's login wall → 503), which is why pricing comes from elsewhere. |
| **Card values – recommended** | [PriceCharting API](https://www.pricecharting.com/api-documentation) (Pokémon/TCG) and [SportsCardsPro API](https://www.sportscardspro.com/api-documentation) (sports) | "Legendary" subscription, $49/mo **per site** | Same company, same API shape. Every card has a per-grade value derived from eBay sold comps; `manual-only-price` = PSA 10. Product names are clean (`2024 Panini Select — Drake Maye [White Prizm Shock] #27`) which is what makes confident matching possible. Search works without a subscription; prices need one. Limit 1 req/s. |
| Card values – fallback | Same RapidAPI, `/ebay_search?epid=…&buyingOptions=FIXED_PRICE` | 1 RapidAPI request per lookup | "What are other sellers asking for the identical eBay catalogue product in the same grade right now." Asking prices run high, so we take the 25th percentile and cap confidence at 0.9. Capped at 3 lookups/run by default. |
| Cert verification (optional) | [PSA Public API](https://www.psacard.com/publicapi) | Free (100 req/day) | Given a cert number, returns exactly what PSA graded (subject, set, number, grade). Only useful when the cert number is visible, which mostly means enabling item-specifics fetching. |

Alternatives considered: PokemonPriceTracker / PokeTrace / TCG Price Lookup (Pokémon-only, cheaper, PSA 10 eBay comps — a reasonable swap for the Pokémon half if $49/mo is too much); 130point / Card Ladder / Market Movers (no public API); eBay Marketplace Insights API (sold data, but restricted access).

### What "confident it's the right card" means here

`src/cards/match.js` scores every price-guide candidate against the parsed title:

* card number match **+0.35** (a *conflicting* number disqualifies the candidate)
* player / Pokémon name tokens all present **+0.35**
* set/series words present **+0.20**
* year match **+0.05** (off by one −0.25, more −0.40)
* variant: guide says `[Silver Prizm]` and title says "Silver Prizm" **+0.05**; guide variant missing from title **−0.50**; guide is base but title names a parallel **−0.20**; Japanese vs English mismatch **−0.40**
* if the runner-up is within 0.10 the result is *ambiguous* → **−0.15**
* an exact eBay ePID match (when the guide provides one) = **1.0**

Anything under `deal.minMatchConfidence` (0.75) is ignored. Listings with no card number in the title can't reach that bar, so they're skipped without spending an API call (unless you enable item-specifics fetching, which usually recovers the number and cert).

## Setup

### 1. Local

```bash
npm install
cp .env.example .env     # fill in RAPIDAPI_KEY at minimum
npm run scan:dry -- --verbose   # no emails, prints everything it evaluates
npm test
```

### 2. GitHub Actions

Add these repository secrets (Settings → Secrets and variables → Actions):

| Secret | Required | Notes |
| --- | --- | --- |
| `RAPIDAPI_KEY` | yes | RapidAPI key subscribed to Real-Time eBay Data |
| `PRICECHARTING_TOKEN` | recommended | 40-char token from pricecharting.com → Subscription → API/Download |
| `SPORTSCARDSPRO_TOKEN` | recommended | same, from sportscardspro.com (separate subscription). Falls back to `PRICECHARTING_TOKEN` if blank |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASS` `EMAIL_FROM` `EMAIL_TO` | yes (for email) | Gmail: `smtp.gmail.com`, `465`, `true`, your address, an [App Password](https://myaccount.google.com/apppasswords) |
| `DISCORD_WEBHOOK_URL` | optional | instant phone pushes; can be used instead of or alongside email |
| `PSA_API_TOKEN` | optional | from psacard.com/publicapi |

The `Scan eBay card deals` workflow runs on the cron and can also be triggered by hand (Actions → Run workflow) with a dry-run toggle. The `Tests` workflow runs on every push.

## Configuration

Everything tunable lives in **`config/scan.config.js`** — no code changes needed:

| Setting | Default | Meaning |
| --- | --- | --- |
| `schedule.scanIntervalMinutes` | 10 | how often the cron runs (must match `.github/workflows/scan.yml`; a test enforces this) |
| `schedule.windowBufferMinutes` | 5 | look-ahead beyond the interval → scans items ending in the next 15 min |
| `ebay.buyingOptions` | `['AUCTION']` | add `'FIXED_PRICE'` to include timed BINs (GTC listings have no end date and are dropped) |
| `ebay.maxPages` | 1 | 200 results per page per category, ending-soonest first |
| `ebay.detailFetch` | `'never'` | `'unmatched'` fetches item specifics (card #, set, cert) only when the title wasn't enough |
| `categories` | Pokémon, Sports | eBay category ids, price guide, filters |
| `grades` | PSA 10 | grader + grade + which PriceCharting field holds its value |
| `deal.minDiscountPct` / `minSavingsUsd` / `minMarketValueUsd` | 30 / 15 / 25 | what counts as a deal |
| `deal.minMatchConfidence` | 0.75 | how sure we must be it's the right card |
| `deal.includeShipping` / `assumedShippingUsd` | true / 5 | eBay often reports "calculated" shipping without a number |
| `pricing.providers` | `['pricecharting','ebay_active']` | order matters |
| `pricing.ebayActive.maxLookupsPerRun` | 3 | each costs a RapidAPI request |
| `notify.mode` | `'digest'` | or `'each'` for one email per deal |
| `notify.timezone` | `America/New_York` | for the "ends at" time in emails |

### Expanding coverage

* **More grades**: add to `grades`, e.g. `{ grader: 'PSA', grade: 9, priceKey: 'graded-price' }` or `{ grader: 'BGS', grade: 10, priceKey: 'bgs-10-price' }`. The parser already recognises PSA/BGS/CGC/SGC.
* **More categories**: add an entry to `categories` with the eBay category id, `kind: 'tcg' | 'sports'`, which guide to use and a `productFilter` regex on the guide's set name (e.g. `/^one piece/i`).
* **Other marketplaces**: `ebay.marketplaceTld`.

## RapidAPI quota math (read this)

The Pro plan includes 10,000 requests/month and bills **$0.009 per request** after that. Per run the scanner makes:

```
categories × maxPages            (2 × 1 = 2)   search calls
+ ebayActive.maxLookupsPerRun    (3)           fallback price lookups, only when needed
+ maxDetailFetches               (0 when detailFetch = 'never')
```

At a 10-minute cadence that's 4,320 runs/month → **8,640** search requests plus up to **12,960** fallback lookups. The startup log prints this estimate and the end-of-run log prints your remaining quota.

**Quota protection is on by default** (`ebay.protectQuota`): RapidAPI reports the remaining quota and reset time on every response, and the scanner stops spending on *optional* requests (fallback price lookups, item-specifics fetches) as soon as what's left is only enough for the mandatory searches through the end of the billing period. In practice with the defaults the fallback pricing works for the first ~1,300 lookups of the month and then goes quiet until the reset; the eBay searches themselves always keep running and you never pay overage. To get more pricing coverage:

* configure PriceCharting/SportsCardsPro tokens (their calls don't touch the RapidAPI quota), or
* run every 15–20 minutes so more of the quota is free for lookups, or
* move to the Ultra plan (60,000/mo) and raise `rapidApiMonthlyLimit` / `ebayActive.maxLookupsPerRun`.

PriceCharting's own limit (1 req/s) means ~150 listings can be priced per run; `pricing.maxListingsPerRun` and `maxRunSeconds` keep a run inside the cron window, soonest-ending listings first. Lookups are cached for 24h so repeat cards are free.

## Caveats

* "X% below market" is the **current bid** at scan time. Auctions with 0–2 bids ending in 10 minutes routinely double in the last 30 seconds; `deal.minBidCount` lets you demand real bidding interest first.
* GitHub's scheduler is best-effort; ticks are frequently 3–10 minutes late (hence the buffer). For tighter timing run the same script from any always-on box with `cron`.
* Only what a seller writes in the title is used unless `detailFetch` is enabled. Mis-titled listings ("PSA 10" on a PSA 9) will be caught only with `detailFetch` + PSA cert verification.
