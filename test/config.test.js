import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from '../config/scan.config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('workflow cron matches schedule.scanIntervalMinutes', () => {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/scan.yml'), 'utf8');
  const m = yml.match(/cron:\s*'\*\/(\d+) \* \* \* \*'/);
  assert.ok(m, 'expected a "*/N * * * *" cron in scan.yml');
  assert.equal(Number(m[1]), config.schedule.scanIntervalMinutes, 'scan.yml cron and config.schedule.scanIntervalMinutes disagree');
});

test('config sanity', () => {
  const s = config.schedule;
  assert.ok(s.scanIntervalMinutes >= 5, 'GitHub Actions cron minimum is 5 minutes');
  assert.ok(60 % s.scanIntervalMinutes === 0, 'interval must divide an hour for a */N cron');
  assert.ok(s.minMinutesLeft >= 0);
  assert.ok(s.lookaheadMinutes >= s.minMinutesLeft + s.scanIntervalMinutes, 'consecutive runs would leave a gap in coverage');
  assert.ok(config.categories.length > 0);
  for (const c of config.categories) {
    assert.ok(['tcg', 'sports'].includes(c.kind), `${c.key}: kind`);
    assert.ok(['pricecharting', 'sportscardspro'].includes(c.priceGuide), `${c.key}: priceGuide`);
    assert.ok(c.ebayCategoryIds.length, `${c.key}: ebayCategoryIds`);
  }
  assert.ok(config.targets.length > 0);
  for (const t of config.targets) {
    assert.ok(t.key && t.label && t.searchQuery && Array.isArray(t.conditionIds), `${t.key}: incomplete`);
    assert.ok(t.categoryKeys.length, `${t.key}: categoryKeys`);
    for (const k of t.categoryKeys) assert.ok(config.categories.some((c) => c.key === k), `${t.key}: unknown category ${k}`);
    assert.ok(Object.keys(t.require ?? {}).length, `${t.key}: require`);
  }
  assert.equal(config.gradePriceKeys['PSA 10'], 'manual-only-price');
  assert.ok(config.deal.minMatchConfidence > 0 && config.deal.minMatchConfidence <= 1);
  assert.ok(config.pricing.maxRunSeconds < s.scanIntervalMinutes * 60, 'a run must finish before the next one starts');
});

test('RapidAPI mandatory usage (first page of every search) fits the plan', () => {
  const searches = config.targets.reduce((n, t) => n + t.categoryKeys.length, 0);
  const runsPerMonth = (31 * 24 * 60) / config.schedule.scanIntervalMinutes;
  assert.ok(searches * runsPerMonth <= config.ebay.rapidApiMonthlyLimit, `${searches} searches/run × ${runsPerMonth} runs exceeds ${config.ebay.rapidApiMonthlyLimit}`);
  assert.ok(config.ebay.maxPagesPerSearch >= 1 && config.ebay.extraPageBurst >= 1);
});
