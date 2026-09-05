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
  assert.ok(config.schedule.scanIntervalMinutes >= 5, 'GitHub Actions cron minimum is 5 minutes');
  assert.ok(config.schedule.windowBufferMinutes >= 0);
  assert.ok(config.categories.length > 0);
  for (const c of config.categories) {
    assert.ok(['tcg', 'sports'].includes(c.kind), `${c.key}: kind`);
    assert.ok(['pricecharting', 'sportscardspro'].includes(c.priceGuide), `${c.key}: priceGuide`);
    assert.ok(c.ebayCategoryIds.length, `${c.key}: ebayCategoryIds`);
  }
  for (const g of config.grades) assert.ok(g.grader && g.grade && g.priceKey, 'grade entry incomplete');
  assert.ok(config.deal.minMatchConfidence > 0 && config.deal.minMatchConfidence <= 1);
  assert.ok(config.pricing.maxRunSeconds < config.schedule.scanIntervalMinutes * 60, 'a run must finish before the next one starts');
});
