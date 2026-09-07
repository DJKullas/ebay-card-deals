import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from '../config/scan.config.js';
import { searchPlan } from '../src/targets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('workflow launches a looping job that outlives the launch interval', () => {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/scan.yml'), 'utf8');
  const s = config.schedule;
  const cron = yml.match(/cron:\s*'0 \*\/(\d+) \* \* \*'/);
  assert.ok(cron, 'expected a "0 */N * * *" cron in scan.yml');
  assert.equal(Number(cron[1]), s.launchEveryHours, 'scan.yml cron and config.schedule.launchEveryHours disagree');
  // The next launch must be queued (concurrency group) before the running job ends.
  assert.ok(s.loopMinutes > s.launchEveryHours * 60, 'loopMinutes must exceed the launch interval or coverage has gaps');
  // ...and the job must finish (last scan included) before GitHub's 6h kill.
  const timeout = yml.match(/timeout-minutes:\s*(\d+)/);
  assert.ok(timeout, 'expected timeout-minutes in scan.yml');
  assert.ok(s.loopMinutes + config.pricing.maxRunSeconds / 60 < Number(timeout[1]), 'loop + last scan must fit inside timeout-minutes');
  assert.ok(Number(timeout[1]) <= 360, 'GitHub kills jobs at 6 hours');
  assert.ok(/concurrency:\s*\n\s*group:/.test(yml) && /cancel-in-progress:\s*false/.test(yml), 'launches must queue behind the running job, not cancel it');
  assert.ok(/--loop/.test(yml), 'scheduled runs must use --loop');
});

test('config sanity', () => {
  const s = config.schedule;
  assert.ok(s.scanIntervalMinutes >= 1);
  assert.ok(s.minMinutesLeft >= 0);
  const windowStartMin = s.minMinutesLeft + config.notify.sendAfterSeconds / 60;
  assert.ok(s.lookaheadMinutes >= windowStartMin + s.scanIntervalMinutes, 'consecutive scans would leave a gap in coverage');
  assert.ok(config.notify.sendAfterSeconds < config.pricing.maxRunSeconds, 'the email must go out before the scan ends');
  assert.ok(config.notify.maxDealsPerEmail >= 1);
  assert.ok(config.categories.length > 0);
  for (const c of config.categories) {
    assert.ok(['tcg', 'sports'].includes(c.kind), `${c.key}: kind`);
    assert.ok(['pricecharting', 'sportscardspro'].includes(c.priceGuide), `${c.key}: priceGuide`);
    assert.ok(c.ebayCategoryIds.length, `${c.key}: ebayCategoryIds`);
  }
  assert.ok(config.targets.length > 0);
  for (const t of config.targets) {
    assert.ok(t.key && t.label && Array.isArray(t.searchTerms) && t.searchTerms.length && Array.isArray(t.conditionIds), `${t.key}: incomplete`);
    assert.ok(t.categoryKeys.length, `${t.key}: categoryKeys`);
    for (const k of t.categoryKeys) assert.ok(config.categories.some((c) => c.key === k), `${t.key}: unknown category ${k}`);
    assert.ok(Object.keys(t.require ?? {}).length, `${t.key}: require`);
  }
  assert.equal(config.gradePriceKeys['PSA 10'], 'manual-only-price');
  assert.ok(config.deal.minMatchConfidence > 0 && config.deal.minMatchConfidence <= 1);
  assert.ok(config.pricing.maxRunSeconds < s.scanIntervalMinutes * 60, 'a run must finish before the next one starts');
});

test('RapidAPI mandatory usage (first page of every search) fits the plan', () => {
  const searches = searchPlan(config.targets, config.categories).length;
  const runsPerMonth = (31 * 24 * 60) / config.schedule.scanIntervalMinutes;
  assert.ok(searches * runsPerMonth <= config.ebay.rapidApiMonthlyLimit, `${searches} searches/run × ${runsPerMonth} runs exceeds ${config.ebay.rapidApiMonthlyLimit}`);
  assert.ok(config.ebay.maxPagesPerSearch >= 1 && config.ebay.extraPageBurst >= 1);
});
