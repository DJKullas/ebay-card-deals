# ebay-card-deals

Every 15 minutes, look at eBay auctions for sports and Pokémon cards that end **5–25 minutes from now** (so there is always time to look at the card), work out what each one is actually worth, and email you when one is going cheap.

What it hunts for (`targets` in the config):

* **PSA 10** — Pokémon and sports, graded condition only.
* **Autographed sports cards, any grade or raw** — pack-pulled autos only. Graded ones are priced at their grade (PSA 9, BGS 9.5, SGC 10 …), raw ones at the guide's ungraded value. Hand-signed / JSA / BAS / PSA-DNA, redemptions, dual/triple autos, cut signatures, booklets and damaged raw cards are skipped on purpose: the matcher would rather miss a card than mis-price one.

Adding other grades or categories is a config change (see [Expanding coverage](#expanding-coverage)).

## How it works

```
GitHub Actions: one ~5.7h job (`node src/index.js --loop`), relaunched every 3h, queued behind the running one
  └─ every 15 minutes:
       1. eBay search  ─ RapidAPI "Real-Time eBay Data" /ebay_search (wraps eBay Browse API)
          one search per target × category (pokemon "psa 10", sports "psa 10", sports "auto"),
          auctions, sorted ending-soonest, itemEndDate <= now + 25 min; first page always,
          more pages while a search overflowed and spare RapidAPI quota allows
       2. parse title  ─ grader/grade, autograph, card number, year, set words, parallel words
          keep listings that satisfy a target, ending 5-25 min from now, not already alerted
       3. price it     ─ PriceCharting (Pokémon) / SportsCardsPro (sports): search the guide,
          score every candidate 0-1 for "is this the SAME card", read the value for the
          listing's grade (PSA 10 / PSA 9 / BGS 9.5 / raw ...). Autographed listings may only
          match autographed guide products and vice versa — a hard rule.
       4. evaluate     ─ (bid + shipping) vs market: ≥30% below, ≥$15 saved, market ≥ $25,
          confidence ≥ 0.75  =>  deal   (autos: ≥35% below, market ≥ $40, confidence ≥ 0.85)
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
* an exact eBay ePID match (when the guide provides one) settles the *identity* part (number + name + set + year = 0.95) but **not the variant**: sellers routinely attach a parallel's catalogue entry to a base card, so the variant check above still applies in full and a conflicting card number costs −0.20 instead of disqualifying
* **autograph consistency is a hard rule**, checked before everything else including the ePID identity credit: a listing that says auto/autograph/signed can only match a guide product that is an autograph (`[Autograph …]`, `… Rookie Autographs`, `[Signature …]`), and a listing that doesn't can never match one. Pricing a base card against its auto version is the easiest way to invent a fake 90%-off deal.
* a title that mentions a grader but has no readable grade (truncated title, "PSA 20") is never priced as raw.

Anything under `deal.minMatchConfidence` (0.75; 0.85 for autos) is ignored. Listings with no card number in the title can't reach that bar, so they're skipped without spending an API call (unless you enable item-specifics fetching, which usually recovers the number and cert).

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
| `SPORTSCARDSPRO_TOKEN` | recommended | one PriceCharting token works on both pricecharting.com and sportscardspro.com; either variable falls back to the other |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `EMAIL_FROM` `EMAIL_TO` | yes (for email) | Gmail: `smtp.gmail.com`, `587`, your address, an [App Password](https://myaccount.google.com/apppasswords). `SMTP_SECURE` is optional (inferred from port). Same setup as `tesla-inventory-monitor` |
| `DISCORD_WEBHOOK_URL` | optional | instant phone pushes; can be used instead of or alongside email |
| `PSA_API_TOKEN` | optional | from psacard.com/publicapi |

The `Scan eBay card deals` workflow is launched by the cron and can also be triggered by hand (Actions → Run workflow) with a dry-run toggle and an optional `loop_minutes` (0 = single scan). The `Tests` workflow runs on every push.

## Configuration

Everything tunable lives in **`config/scan.config.js`** — no code changes needed:

| Setting | Default | Meaning |
| --- | --- | --- |
| `schedule.scanIntervalMinutes` | 15 | how often the loop scans |
| `schedule.loopMinutes` / `launchEveryHours` | 340 / 3 | how long one Actions job loops, and how often a replacement is launched (must match the cron in `.github/workflows/scan.yml`; a test enforces this) |
| `schedule.minMinutesLeft` | 5 | never alert on (or bother pricing) anything ending sooner than this |
| `schedule.lookaheadMinutes` | 25 | window end; must be ≥ `minMinutesLeft + scanIntervalMinutes` so runs don't leave gaps (the extra 5 min overlaps the next run and absorbs late cron ticks) |
| `ebay.buyingOptions` | `['AUCTION']` | add `'FIXED_PRICE'` to include timed BINs (GTC listings have no end date and are dropped) |
| `ebay.maxPagesPerSearch` / `extraPageBurst` | 4 / 4 | extra 200-result pages when a search overflows the window, paid for from spare quota (see below) |
| `ebay.detailFetch` | `'never'` | `'unmatched'` fetches item specifics (card #, set, cert) only when the title wasn't enough |
| `categories` | Pokémon, Sports | eBay category ids, price guide, filters |
| `targets` | PSA 10, Autograph | what to hunt: eBay query + condition + min bid + `require` (grade or autograph) + per-target exclusions and deal overrides |
| `gradePriceKeys` | PSA 10 → `manual-only-price` … raw → `loose-price` | which guide field holds the value for each grade |
| `deal.minDiscountPct` / `minSavingsUsd` / `minMarketValueUsd` | 30 / 15 / 25 | what counts as a deal (autos override to 35 / 15 / 40) |
| `deal.minMatchConfidence` | 0.75 | how sure we must be it's the right card (autos: 0.85) |
| `deal.includeShipping` / `assumedShippingUsd` | true / 5 | eBay often reports "calculated" shipping without a number |
| `pricing.providers` | `['pricecharting']` | add `'ebay_active'` for the asking-price fallback (costs RapidAPI requests; can't price raw cards or autos) |
| `notify.mode` | `'digest'` | or `'each'` for one email per deal |
| `notify.timezone` | `America/New_York` | for the "ends at" time in emails |

### Expanding coverage

* **More grades**: add a target, e.g. `{ key: 'psa9', label: 'PSA 9', categoryKeys: ['pokemon','sports'], searchQuery: 'psa 9', conditionIds: ['2750'], require: { grader: 'PSA', grade: 9 } }`. Each target×category pair is one more mandatory RapidAPI request per run — check the quota math. The parser recognises PSA/BGS/CGC/SGC and `gradePriceKeys` already maps 7–10.
* **More categories**: add an entry to `categories` with the eBay category id, `kind: 'tcg' | 'sports'`, which guide to use and a `productFilter` regex on the guide's set name (e.g. `/^one piece/i`), then list its key in the targets that should cover it.
* **Other marketplaces**: `ebay.marketplaceTld`.

## RapidAPI quota math (read this)

The Pro plan includes 10,000 requests/month and bills **$0.009 per request** after that. Per run the scanner makes:

```
target × category pairs          (3)           mandatory: first page of each search
+ extra pages                    (0–9)         only when a search had more in-window listings than one page
+ ebayActive.maxLookupsPerRun    (0, provider off by default)
+ maxDetailFetches               (0 when detailFetch = 'never')
```

At a 15-minute cadence that's 2,880 runs/month → **8,640** mandatory requests, leaving ~1,300 spare. (A 10-minute cadence with three searches would be 12,960 — over the plan — which is why it's 15.)

**Quota protection is on by default** (`ebay.protectQuota`). RapidAPI reports the remaining quota and reset time on every response. The scanner reserves the mandatory requests for every run left in the billing period (+ `quotaReserve`), spreads whatever is spare over those runs, and lets a single run spend up to `extraPageBurst`× that share on extra pages — so quiet weekday mornings (one page covers the whole window) bank pages for Sunday evenings (1,000+ autograph auctions ending in 25 minutes). Listings that don't fit are the latest-ending ones and are usually caught by the next run. The core searches always run; you never pay overage. If the log keeps saying `later-ending listings not fetched` during the hours you care about, the fix is the Ultra plan (60,000/mo) + a higher `rapidApiMonthlyLimit`/`maxPagesPerSearch`, or dropping a target.

PriceCharting's own limit (1 req/s, one call per new listing thanks to the search endpoint carrying prices) means ~500 listings can be priced per run; `pricing.maxListingsPerRun` and `maxRunSeconds` keep a run inside the cron window, soonest-ending listings first. Lookups are cached for 24h so repeat cards are free.

## How the schedule actually works (read this too)

GitHub's cron scheduler is best-effort and, for busy schedules, erratic: a `*/15` cron on this repo fired **6 times in 14 hours**. So the 15-minute loop lives inside the process instead:

* `node src/index.js --loop` scans every `schedule.scanIntervalMinutes` for `schedule.loopMinutes` (340 min), saving state after each scan, then exits so the job can save its cache. GitHub kills jobs at 6 hours.
* The workflow cron launches a new job every `schedule.launchEveryHours` (3h) — on purpose more often than a job lasts. The `concurrency` group keeps the newcomer **pending** until the running job exits, so the hand-off is seamless even when a cron tick is skipped or hours late. Only one job runs at a time.
* This runs ~43,000 Actions minutes/month, which is why the repo is **public** (unlimited minutes for public repos; secrets stay secret). On a private repo you'd burn the 2,000 free minutes in 1.5 days — run `npm run scan -- --loop` from an always-on machine instead.
* To start coverage right now (e.g. after a config change) trigger the workflow by hand with `loop_minutes` = 340; the next cron launch queues behind it.

## Caveats

* "X% below market" is the **current bid** at scan time. Auctions with 0–2 bids ending in 20 minutes routinely double in the last 30 seconds; `deal.minBidCount` lets you demand real bidding interest first. Alerts now arrive with 5–25 minutes left precisely so you can watch the finish.
* Raw autographs are priced at the guide's ungraded value, which assumes a clean card. Obvious damage words are excluded from the title, but check the photos.
* Scan timing inside a job is exact (setTimeout, not cron); the 5-minute window overlap covers scans that overrun their slot on very busy evenings.
* Only what a seller writes in the title is used unless `detailFetch` is enabled. Mis-titled listings ("PSA 10" on a PSA 9) will be caught only with `detailFetch` + PSA cert verification.
