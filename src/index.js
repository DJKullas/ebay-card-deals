#!/usr/bin/env node
/**
 * Entry point. One run = one scan:
 *   1. pull eBay listings ending in [minMinutesLeft, lookaheadMinutes] for every
 *      target × category (PSA 10 Pokemon, PSA 10 sports, autographed sports)
 *   2. keep the ones that satisfy a target (grade / autograph, parsed from the title)
 *   3. price each one against the price guide(s) with a confidence score
 *   4. alert on anything confidently priced and sufficiently below market
 *
 * Flags: --dry-run (no notifications, no dedupe writes)  --limit N  --verbose
 */
import path from 'node:path';
import * as config from '../config/scan.config.js';
import { EbayClient } from './ebay/client.js';
import { parseListing, setVariantHints, resolveGrade } from './cards/parse.js';
import { matchesTarget, mergeDealRules, searchPlan } from './targets.js';
import { PriceChartingClient } from './pricing/pricecharting.js';
import { PriceGuideProvider } from './pricing/priceGuideProvider.js';
import { EbayActiveProvider } from './pricing/ebayActive.js';
import { PsaCertClient } from './psa/cert.js';
import { evaluateDeal } from './deals/evaluate.js';
import { Store } from './state/store.js';
import { EmailNotifier } from './notify/email.js';
import { DiscordNotifier } from './notify/discord.js';
import { renderText, fmtMoney } from './notify/format.js';

/** @typedef {{ listing:object, parsed:object, category:object, grade:object, priced:object, eval:object }} Deal */

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const DRY_RUN = flag('--dry-run');
const VERBOSE = flag('--verbose') || process.env.DEBUG === '1';
const LIMIT = Number(opt('--limit', config.pricing.maxListingsPerRun));
// --loop [minutes]: keep scanning every scanIntervalMinutes for this long
// (default config.schedule.loopMinutes), then exit. GitHub's cron scheduler
// is too erratic for a 15-minute cadence, so the workflow runs one long job.
const loopArg = opt('--loop', null);
const LOOP_MINUTES = flag('--loop') ? Number(loopArg && !loopArg.startsWith('--') ? loopArg : config.schedule.loopMinutes) : 0;

main().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});

async function main() {
  if (!LOOP_MINUTES) return scanOnce();

  const intervalMs = config.schedule.scanIntervalMinutes * 60_000;
  const endAt = Date.now() + LOOP_MINUTES * 60_000;
  console.log(`Loop mode: scanning every ${config.schedule.scanIntervalMinutes} min for ${LOOP_MINUTES} min (until ${new Date(endAt).toISOString()})`);
  for (let n = 1; ; n += 1) {
    const tick = Date.now();
    console.log(`\n===== scan ${n} · ${new Date(tick).toISOString()} =====`);
    try {
      await scanOnce();
    } catch (err) {
      console.error('scan failed:', err);
      process.exitCode = 1;
    }
    const next = tick + intervalMs;
    if (next >= endAt) break;
    const wait = Math.max(0, next - Date.now());
    if (wait === 0) console.warn(`  scan overran the ${config.schedule.scanIntervalMinutes}-minute interval by ${((Date.now() - next) / 1000).toFixed(0)}s`);
    await new Promise((r) => setTimeout(r, wait));
  }
  console.log(`Loop finished after ${((Date.now() - (endAt - LOOP_MINUTES * 60_000)) / 60_000).toFixed(0)} min.`);
}

async function scanOnce() {
  const startedAt = Date.now();
  const env = process.env;
  const stateFile = path.resolve(process.cwd(), 'state', 'state.json');
  const store = new Store(stateFile, { defaultTtlMs: config.pricing.cacheTtlHours * 3600 * 1000 });
  setVariantHints(config.parallelKeywords);

  // --- clients -------------------------------------------------------------
  const ebay = new EbayClient({ apiKey: env.RAPIDAPI_KEY, tld: config.ebay.marketplaceTld });
  const pcTokens = {
    // One PriceCharting token works on both pricecharting.com and sportscardspro.com.
    pricecharting: env.PRICECHARTING_TOKEN || env.SPORTSCARDSPRO_TOKEN || '',
    sportscardspro: env.SPORTSCARDSPRO_TOKEN || env.PRICECHARTING_TOKEN || '',
  };
  const pcClient = new PriceChartingClient({ tokens: pcTokens, minMsBetweenRequests: config.pricing.pricecharting.minMsBetweenRequests, cache: store });
  const psa = new PsaCertClient({ token: env.PSA_API_TOKEN, cache: store });

  // One eBay search per (target, category) pair.
  const searches = searchPlan(config.targets, config.categories);

  // Optional RapidAPI spending is gated so the mandatory searches (first page
  // of each) always fit inside the plan for the rest of the billing period.
  const mandatoryPerRun = searches.length;
  const canSpendOptional = () =>
    !config.ebay.protectQuota ||
    ebay.canSpendOptional({ intervalMinutes: config.schedule.scanIntervalMinutes, mandatoryPerRun, reserve: config.ebay.quotaReserve });

  const providerImpls = {
    pricecharting: new PriceGuideProvider({
      client: pcClient,
      parallelKeywords: config.parallelKeywords,
      optionalVariantTokens: config.optionalVariantTokens,
      requireCardNumber: config.deal.requireCardNumber,
    }),
    ebay_active: new EbayActiveProvider({ ebayClient: ebay, ...config.pricing.ebayActive, canSpend: canSpendOptional }),
  };
  const providers = config.pricing.providers.map((p) => {
    if (!providerImpls[p]) throw new Error(`unknown pricing provider "${p}"`);
    return providerImpls[p];
  });
  if (!pcTokens.pricecharting && !pcTokens.sportscardspro) {
    console.warn('PRICECHARTING_TOKEN not set — PriceCharting provider will be skipped; only the eBay active-listing fallback is available.');
  }

  const notifiers = [new EmailNotifier(env), new DiscordNotifier(env)].filter((n) => n.enabled);
  if (!notifiers.length && !DRY_RUN) console.warn('No notifier configured (SMTP_* / DISCORD_WEBHOOK_URL). Deals will only be printed.');

  // Rough monthly RapidAPI usage so nobody gets surprised by overage billing.
  const runsPerMonth = Math.round((30 * 24 * 60) / config.schedule.scanIntervalMinutes);
  const optionalPerRun = (providers.some((p) => p.name === 'ebay_active') ? config.pricing.ebayActive.maxLookupsPerRun : 0) + (config.ebay.detailFetch === 'never' ? 0 : config.ebay.maxDetailFetches);
  const estMonthly = runsPerMonth * mandatoryPerRun;
  console.log(
    `RapidAPI usage: ${mandatoryPerRun} mandatory requests/run × ${runsPerMonth} runs/month ≈ ${estMonthly.toLocaleString()} of ${config.ebay.rapidApiMonthlyLimit.toLocaleString()}; ` +
      `spare quota goes to extra search pages${optionalPerRun ? ` and up to ${optionalPerRun} optional lookups/run` : ''}${config.ebay.protectQuota ? '' : ' (protectQuota OFF — overage possible)'}`,
  );
  if (estMonthly > config.ebay.rapidApiMonthlyLimit) {
    console.warn(`  WARNING: mandatory searches alone exceed the plan by ~${(estMonthly - config.ebay.rapidApiMonthlyLimit).toLocaleString()} requests/month — remove a target/category or scan less often.`);
  }

  // --- 1. fetch listings ending soon --------------------------------------
  const now = new Date();
  const minLeftMs = config.schedule.minMinutesLeft * 60_000;
  const windowStart = new Date(now.getTime() + minLeftMs);
  const windowEnd = new Date(now.getTime() + config.schedule.lookaheadMinutes * 60_000);
  console.log(
    `Scanning listings ending between ${windowStart.toISOString()} and ${windowEnd.toISOString()} ` +
      `(${config.schedule.minMinutesLeft}-${config.schedule.lookaheadMinutes} min from now)${DRY_RUN ? ' [dry run]' : ''}`,
  );

  // The same listing can come back from several searches (a PSA 10 auto is
  // found by both the "psa 10" and the "auto" search); keep one copy.
  const found = new Map();
  const { pageSize } = config.ebay;
  const progress = searches.map((s) => ({ ...s, pages: 0, fetched: 0, total: Infinity, lastPageFull: true }));
  const fetchPage = async (s) => {
    const { total, items } = await ebay.search({
      query: s.query,
      categoryIds: s.category.ebayCategoryIds,
      buyingOptions: config.ebay.buyingOptions,
      conditionIds: s.target.conditionIds,
      minPrice: s.target.minPrice,
      endBefore: windowEnd,
      sort: 'endingSoonest',
      limit: pageSize,
      offset: s.pages * pageSize,
    });
    s.pages += 1;
    s.total = total;
    s.fetched += items.length;
    s.lastPageFull = items.length >= pageSize;
    for (const listing of items) if (!found.has(listing.itemId)) found.set(listing.itemId, { listing, category: s.category });
  };
  // Page 1 of every search is mandatory...
  for (const s of progress) await fetchPage(s);
  // ...extra pages only where a search overflowed, and only as far as spare
  // quota allows. Whichever search covered the smallest share of its results
  // goes first.
  const needsMore = (s) => s.lastPageFull && s.fetched < s.total && s.pages < config.ebay.maxPagesPerSearch;
  let extraPages = config.ebay.protectQuota
    ? ebay.extraRequestsAllowed({ intervalMinutes: config.schedule.scanIntervalMinutes, mandatoryPerRun, reserve: config.ebay.quotaReserve, burst: config.ebay.extraPageBurst })
    : Infinity;
  const extraAllowed = extraPages;
  let extraUsed = 0;
  while (extraPages > 0) {
    const pending = progress.filter(needsMore).sort((a, b) => a.fetched / a.total - b.fetched / b.total);
    if (!pending.length) break;
    await fetchPage(pending[0]);
    extraPages -= 1;
    extraUsed += 1;
  }
  for (const s of progress) {
    const short = s.fetched < s.total ? ` (${s.total - s.fetched} later-ending listings not fetched)` : '';
    console.log(`  ${s.category.label} / ${s.target.label} ("${s.query}"): ${s.fetched} of ${s.total} listings in ${s.pages} page(s)${short}`);
  }
  if (extraUsed || progress.some((s) => s.fetched < s.total)) {
    console.log(`  extra pages: ${extraUsed} used of ${Number.isFinite(extraAllowed) ? extraAllowed : '∞'} allowed by quota this run`);
  }

  // --- 2. filter to the cards we care about -------------------------------
  const candidates = [];
  const skipped = { noTarget: 0, noGradePrice: 0, alreadyAlerted: 0, outsideWindow: 0, excluded: 0 };
  for (const { listing, category } of found.values()) {
    if (!listing.endDate || listing.endDate < windowStart || listing.endDate > windowEnd) {
      skipped.outsideWindow += 1;
      continue;
    }
    if (category.titleExclude?.test(listing.title)) {
      skipped.excluded += 1;
      continue;
    }
    const parsed = parseListing(listing.title, { kind: category.kind });
    // Every target that covers this category and whose requirement the title satisfies.
    const matchedTargets = config.targets.filter((t) => t.categoryKeys.includes(category.key) && matchesTarget(t, parsed));
    if (!matchedTargets.length) {
      skipped.noTarget += 1;
      if (VERBOSE) console.log(`  skip (${parsed.grader ?? 'raw'} ${parsed.grade ?? ''}${parsed.isAutograph ? ' auto' : ''}, no target): ${listing.title}`);
      continue;
    }
    // A target's titleExclude describes listings of that kind we refuse to
    // price (e.g. dual autos); that stands even if the card is also a PSA 10.
    const excludedBy = matchedTargets.find((t) => t.titleExclude?.test(listing.title));
    if (excludedBy) {
      skipped.excluded += 1;
      if (VERBOSE) console.log(`  skip (${excludedBy.label} exclusion): ${listing.title}`);
      continue;
    }
    const grade = resolveGrade(parsed, config.gradePriceKeys);
    if (!grade) {
      skipped.noGradePrice += 1;
      if (VERBOSE) console.log(`  skip (${parsed.mentionsGrader && !parsed.grader ? 'graded, grade unreadable' : `no guide price field for ${parsed.grader} ${parsed.grade}`}): ${listing.title}`);
      continue;
    }
    if (store.has(`alerted:${listing.itemId}`)) {
      skipped.alreadyAlerted += 1;
      continue;
    }
    candidates.push({ listing, parsed, category, grade, targets: matchedTargets, rules: mergeDealRules(config.deal, matchedTargets) });
  }
  candidates.sort((a, b) => (a.listing.endDate?.getTime() ?? 0) - (b.listing.endDate?.getTime() ?? 0));
  const byTarget = config.targets.map((t) => `${candidates.filter((c) => c.targets.includes(t)).length} ${t.label}`).join(', ');
  console.log(
    `  ${candidates.length} candidates (${byTarget}) (skipped: ${skipped.noTarget} no target, ${skipped.noGradePrice} unpriceable grade, ` +
      `${skipped.alreadyAlerted} already alerted, ${skipped.excluded} excluded by title, ${skipped.outsideWindow} outside window)`,
  );

  // --- 3. price + evaluate -------------------------------------------------
  const deals = [];
  const stats = { priced: 0, confident: 0, unpriced: 0, lowConfidence: 0, noValue: 0, noCardNumber: 0, tooLate: 0, detailFetches: 0, errors: 0, truncated: 0 };
  let processed = 0;

  for (const cand of candidates) {
    if (processed >= LIMIT) {
      stats.truncated = candidates.length - processed;
      break;
    }
    if ((Date.now() - startedAt) / 1000 > config.pricing.maxRunSeconds) {
      stats.truncated = candidates.length - processed;
      console.warn(`  time budget (${config.pricing.maxRunSeconds}s) reached; ${stats.truncated} listings left unpriced`);
      break;
    }
    // Pricing takes a while; by now this one may no longer leave enough time to look at it.
    if (cand.listing.endDate.getTime() - Date.now() < minLeftMs) {
      stats.tooLate += 1;
      continue;
    }
    processed += 1;

    try {
      // No card number in the title? We can't be confident, so either pull the
      // item specifics (if allowed) or skip without spending a price-guide call.
      if (cand.rules.requireCardNumber && !cand.parsed.cardNumber && !cand.listing.epid) {
        if (shouldFetchDetails(config.ebay.detailFetch, stats.detailFetches, canSpendOptional)) {
          stats.detailFetches += 1;
          const enriched = await enrichWithDetails(cand, ebay, psa);
          if (enriched?.gradeMismatch) {
            if (VERBOSE) console.log(`  skip (specifics say ${enriched.gradeMismatch}): ${cand.listing.title}`);
            continue;
          }
          if (enriched) cand.parsed = enriched.parsed;
        }
        if (!cand.parsed.cardNumber) {
          stats.noCardNumber += 1;
          if (VERBOSE) console.log(`  skip (no card number): ${cand.listing.title}`);
          continue;
        }
      }

      let priced = await priceListing(cand, providers);

      // Not confident from the title alone? Optionally pull item specifics and retry.
      const needsHelp = !priced || priced.marketValue === null || priced.confidence < cand.rules.minMatchConfidence;
      if (needsHelp && !cand.parsed.detailsFetched && shouldFetchDetails(config.ebay.detailFetch, stats.detailFetches, canSpendOptional)) {
        stats.detailFetches += 1;
        const enriched = await enrichWithDetails(cand, ebay, psa);
        if (enriched) {
          cand.parsed = enriched.parsed;
          if (enriched.gradeMismatch) {
            if (VERBOSE) console.log(`  skip (specifics say ${enriched.gradeMismatch}): ${cand.listing.title}`);
            continue;
          }
          priced = await priceListing(cand, providers);
        }
      }

      if (!priced) {
        stats.unpriced += 1;
        if (VERBOSE) console.log(`  no price: ${cand.listing.title}`);
        continue;
      }
      stats.priced += 1;
      if (priced.marketValue === null) stats.noValue += 1;
      else if (priced.confidence < cand.rules.minMatchConfidence) stats.lowConfidence += 1;
      else stats.confident += 1;

      const result = evaluateDeal(cand.listing, priced, cand.rules);
      if (VERBOSE || result.isDeal) {
        console.log(
          `  ${result.isDeal ? 'DEAL ' : '     '}${fmtMoney(result.totalCost)} vs ${fmtMoney(result.marketValue)} (${cand.grade.label}) ` +
            `[${(priced.confidence * 100).toFixed(0)}% ${priced.source}] ${result.reason} :: ${cand.listing.title}` +
            (VERBOSE ? `\n         q="${priced.query ?? ''}" -> ${priced.matchedName ?? '-'} (${(priced.reasons ?? []).join('; ')})` : ''),
        );
      }
      if (result.isDeal) deals.push({ ...cand, priced, eval: result });
    } catch (err) {
      stats.errors += 1;
      console.warn(`  error pricing "${cand.listing.title}": ${err.message}`);
    }
  }

  // --- 4. notify -------------------------------------------------------------
  deals.sort((a, b) => b.eval.discountPct - a.eval.discountPct);
  if (deals.length) {
    console.log(`\n${deals.length} deal(s):\n${renderText(deals, { timezone: config.notify.timezone })}\n`);
    if (!DRY_RUN) {
      const batches = config.notify.mode === 'each' ? deals.map((d) => [d]) : [deals];
      for (const n of notifiers) {
        for (const batch of batches) {
          try {
            await n.send(batch, { subjectPrefix: config.notify.subjectPrefix, timezone: config.notify.timezone });
            console.log(`  sent ${batch.length} deal(s) via ${n.name}`);
          } catch (err) {
            console.error(`  ${n.name} failed: ${err.message}`);
            process.exitCode = 1;
          }
        }
      }
      for (const d of deals) store.set(`alerted:${d.listing.itemId}`, { at: Date.now(), total: d.eval.totalCost }, config.notify.dedupeHours * 3600 * 1000);
    }
  } else {
    console.log('No deals this run.');
  }

  store.save();
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `Done in ${secs}s. priced=${stats.priced} confident=${stats.confident} lowConfidence=${stats.lowConfidence} noValue=${stats.noValue} ` +
      `unpriced=${stats.unpriced} noCardNumber=${stats.noCardNumber} tooLate=${stats.tooLate} detailFetches=${stats.detailFetches} errors=${stats.errors} truncated=${stats.truncated} | ` +
      `API calls: rapidapi=${ebay.requestCount} pricecharting=${pcClient.requestCount} psa=${psa.lookups} | state entries=${store.size}`,
  );
  if (ebay.quota.remaining !== null) {
    const days = ebay.quota.resetSeconds ? (ebay.quota.resetSeconds / 86400).toFixed(1) : '?';
    console.log(`RapidAPI quota: ${ebay.quota.remaining.toLocaleString()} of ${ebay.quota.limit?.toLocaleString()} requests left, resets in ${days} days`);
    const blocked = providerImpls.ebay_active.blockedByQuota;
    if (blocked) console.warn(`  quota protection skipped ${blocked} optional eBay price lookup(s) this run (ebay.protectQuota)`);
  }
}

/** Try providers in order; return the first confident price, else the best attempt. */
async function priceListing(cand, providers) {
  let best = null;
  for (const provider of providers) {
    const r = await provider.price(cand.listing, cand.parsed, { category: cand.category, grade: cand.grade });
    if (!r) continue;
    if (!best || (r.marketValue !== null && r.confidence > (best.marketValue === null ? -1 : best.confidence))) best = r;
    if (r.marketValue !== null && r.confidence >= cand.rules.minMatchConfidence) return r;
  }
  return best;
}

function shouldFetchDetails(mode, done, canSpend = () => true) {
  if (done >= config.ebay.maxDetailFetches) return false;
  if (mode !== 'always' && mode !== 'unmatched') return false;
  return canSpend();
}

/**
 * Pull item specifics from the listing page and (if a cert number is visible
 * and PSA_API_TOKEN is set) PSA's own record of the card, then re-parse.
 */
async function enrichWithDetails(cand, ebay, psa) {
  let details = null;
  try {
    details = await ebay.itemDetails(cand.listing.url);
  } catch (err) {
    console.warn(`  detail fetch failed: ${err.message}`);
  }
  const specifics = { ...(details?.specifics ?? {}) };

  let parsed = parseListing(cand.listing.title, { kind: cand.category.kind, specifics });
  parsed.detailsFetched = true;
  // The specifics disagree with the title about the grade (or say it is graded
  // when we assumed raw)? Don't guess.
  if (parsed.grader && parsed.grade && (parsed.grader !== cand.grade.grader || parsed.grade !== cand.grade.grade)) {
    return { parsed, gradeMismatch: `${parsed.grader} ${parsed.grade}` };
  }
  if (parsed.isAutograph !== cand.parsed.isAutograph) {
    return { parsed, gradeMismatch: parsed.isAutograph ? 'autographed' : 'not autographed' };
  }

  if (psa.enabled && parsed.certNumber && cand.grade.grader === 'PSA') {
    const cert = await psa.lookup(parsed.certNumber);
    if (cert) {
      if (cert.grade !== cand.grade.grade) return { parsed, gradeMismatch: `PSA cert ${cert.cert} is grade ${cert.grade}` };
      // PSA's description is authoritative — feed it in as specifics.
      if (cert.subject) specifics['Card Name'] = cert.subject;
      if (cert.brand || cert.variety) specifics['Set'] = [cert.brand, cert.variety].filter(Boolean).join(' ');
      if (cert.cardNumber) specifics['Card Number'] = cert.cardNumber;
      if (cert.year) specifics['Year Manufactured'] = String(cert.year);
      parsed = parseListing(cand.listing.title, { kind: cand.category.kind, specifics });
      parsed.detailsFetched = true;
      parsed.psaCert = cert;
    }
  }
  return { parsed, gradeMismatch: null };
}
