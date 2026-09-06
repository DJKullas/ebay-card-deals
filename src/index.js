#!/usr/bin/env node
/**
 * Entry point. One run = one scan:
 *   1. pull eBay listings ending within (interval + buffer) minutes per category
 *   2. keep the ones that are in a grade we care about (PSA 10 by default)
 *   3. price each one against the price guide(s) with a confidence score
 *   4. alert on anything confidently priced and sufficiently below market
 *
 * Flags: --dry-run (no notifications, no dedupe writes)  --limit N  --verbose
 */
import path from 'node:path';
import * as config from '../config/scan.config.js';
import { EbayClient } from './ebay/client.js';
import { parseListing, setVariantHints } from './cards/parse.js';
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

main().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});

async function main() {
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

  // Optional RapidAPI spending is gated so the mandatory searches always fit
  // inside the plan for the rest of the billing period.
  const mandatoryPerRun = config.categories.length * config.ebay.maxPages;
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
  const perRun = config.categories.length * config.ebay.maxPages + (providers.some((p) => p.name === 'ebay_active') ? config.pricing.ebayActive.maxLookupsPerRun : 0) + (config.ebay.detailFetch === 'never' ? 0 : config.ebay.maxDetailFetches);
  const estMonthly = runsPerMonth * perRun;
  console.log(`RapidAPI usage estimate: up to ${perRun} requests/run × ${runsPerMonth} runs/month ≈ ${estMonthly.toLocaleString()} (plan limit ${config.ebay.rapidApiMonthlyLimit.toLocaleString()})`);
  if (estMonthly > config.ebay.rapidApiMonthlyLimit) {
    console.warn(`  WARNING: estimate exceeds the plan limit by ~${(estMonthly - config.ebay.rapidApiMonthlyLimit).toLocaleString()} requests/month — lower ebayActive.maxLookupsPerRun, maxPages or scan less often.`);
  }

  // --- 1. fetch listings ending soon --------------------------------------
  const now = new Date();
  const windowMinutes = config.schedule.scanIntervalMinutes + config.schedule.windowBufferMinutes;
  const windowEnd = new Date(now.getTime() + windowMinutes * 60_000);
  console.log(`Scanning listings ending between ${now.toISOString()} and ${windowEnd.toISOString()} (${windowMinutes} min)${DRY_RUN ? ' [dry run]' : ''}`);

  const found = [];
  for (const category of config.categories) {
    const { total, items } = await ebay.searchAll(
      {
        query: category.searchQuery ?? config.ebay.searchQuery,
        categoryIds: category.ebayCategoryIds,
        buyingOptions: config.ebay.buyingOptions,
        conditionIds: config.ebay.conditionIds,
        endBefore: windowEnd,
        sort: 'endingSoonest',
      },
      { maxPages: config.ebay.maxPages, pageSize: config.ebay.pageSize },
    );
    console.log(`  ${category.label}: ${items.length} of ${total} listings fetched`);
    for (const listing of items) found.push({ listing, category });
  }

  // --- 2. filter to graded cards we care about ----------------------------
  const candidates = [];
  const skipped = { wrongGrade: 0, alreadyAlerted: 0, outsideWindow: 0, excluded: 0 };
  for (const { listing, category } of found) {
    if (!listing.endDate || listing.endDate < now || listing.endDate > windowEnd) {
      skipped.outsideWindow += 1;
      continue;
    }
    if (category.titleExclude?.test(listing.title)) {
      skipped.excluded += 1;
      continue;
    }
    const parsed = parseListing(listing.title, { kind: category.kind });
    const grade = config.grades.find((g) => g.grader === parsed.grader && g.grade === parsed.grade);
    if (!grade) {
      skipped.wrongGrade += 1;
      if (VERBOSE) console.log(`  skip (grade ${parsed.grader ?? '?'} ${parsed.grade ?? '?'}): ${listing.title}`);
      continue;
    }
    if (store.has(`alerted:${listing.itemId}`)) {
      skipped.alreadyAlerted += 1;
      continue;
    }
    candidates.push({ listing, parsed, category, grade });
  }
  candidates.sort((a, b) => (a.listing.endDate?.getTime() ?? 0) - (b.listing.endDate?.getTime() ?? 0));
  console.log(
    `  ${candidates.length} candidates after grade filter (skipped: ${skipped.wrongGrade} other grade, ${skipped.alreadyAlerted} already alerted, ` +
      `${skipped.excluded} excluded by title, ${skipped.outsideWindow} outside window)`,
  );

  // --- 3. price + evaluate -------------------------------------------------
  const deals = [];
  const stats = { priced: 0, confident: 0, unpriced: 0, lowConfidence: 0, noValue: 0, noCardNumber: 0, detailFetches: 0, errors: 0, truncated: 0 };
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
    processed += 1;

    try {
      // No card number in the title? We can't be confident, so either pull the
      // item specifics (if allowed) or skip without spending a price-guide call.
      if (config.deal.requireCardNumber && !cand.parsed.cardNumber && !cand.listing.epid) {
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
      const needsHelp = !priced || priced.marketValue === null || priced.confidence < config.deal.minMatchConfidence;
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
      else if (priced.confidence < config.deal.minMatchConfidence) stats.lowConfidence += 1;
      else stats.confident += 1;

      const result = evaluateDeal(cand.listing, priced, config.deal);
      if (VERBOSE || result.isDeal) {
        console.log(
          `  ${result.isDeal ? 'DEAL ' : '     '}${fmtMoney(result.totalCost)} vs ${fmtMoney(result.marketValue)} ` +
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
      `unpriced=${stats.unpriced} noCardNumber=${stats.noCardNumber} detailFetches=${stats.detailFetches} errors=${stats.errors} truncated=${stats.truncated} | ` +
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
    if (r.marketValue !== null && r.confidence >= config.deal.minMatchConfidence) return r;
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
  if (parsed.grader && parsed.grade && (parsed.grader !== cand.grade.grader || parsed.grade !== cand.grade.grade)) {
    return { parsed, gradeMismatch: `${parsed.grader} ${parsed.grade}` };
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
