import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDeal } from '../src/deals/evaluate.js';

const rules = { minDiscountPct: 30, minMarketValueUsd: 25, minSavingsUsd: 15, includeShipping: true, assumedShippingUsd: 5, minMatchConfidence: 0.75, minBidCount: 0 };
const listing = (over = {}) => ({ currentPrice: 50, binPrice: null, shippingCost: 4.99, isAuction: true, bidCount: 3, ...over });

test('flags a clear deal', () => {
  const r = evaluateDeal(listing(), { marketValue: 120, confidence: 0.9 }, rules);
  assert.equal(r.isDeal, true);
  assert.equal(r.totalCost, 54.99);
  assert.ok(r.discountPct > 50);
});

test('uses assumed shipping when eBay gives none', () => {
  const r = evaluateDeal(listing({ shippingCost: null }), { marketValue: 120, confidence: 0.9 }, rules);
  assert.equal(r.totalCost, 55);
});

test('rejects low confidence, low value, small discount, small savings', () => {
  assert.equal(evaluateDeal(listing(), { marketValue: 120, confidence: 0.5 }, rules).isDeal, false);
  assert.equal(evaluateDeal(listing({ currentPrice: 5 }), { marketValue: 20, confidence: 0.9 }, rules).isDeal, false);
  assert.equal(evaluateDeal(listing({ currentPrice: 90 }), { marketValue: 120, confidence: 0.9 }, rules).isDeal, false);
  assert.equal(evaluateDeal(listing({ currentPrice: 20 }), { marketValue: 30, confidence: 0.9 }, rules).isDeal, false);
});

test('liquidity: needs the guide to report enough sales in the last year', () => {
  const liquid = { ...rules, minSalesPerYear: 12 };
  const priced = (salesVolume) => ({ marketValue: 200, confidence: 0.9, extra: { salesVolume } });
  assert.equal(evaluateDeal(listing(), priced('40'), liquid).isDeal, true);
  assert.equal(evaluateDeal(listing(), priced(12), liquid).isDeal, true);
  const thin = evaluateDeal(listing(), priced('1'), liquid);
  assert.equal(thin.isDeal, false);
  assert.match(thin.reason, /illiquid/);
  assert.equal(evaluateDeal(listing(), priced(undefined), liquid).isDeal, false);
  assert.equal(evaluateDeal(listing(), { marketValue: 200, confidence: 0.9 }, liquid).reason, 'sales volume unknown');
  // rule off -> volume ignored
  assert.equal(evaluateDeal(listing(), priced('1'), rules).isDeal, true);
});

test('respects minBidCount for auctions only', () => {
  const strict = { ...rules, minBidCount: 5 };
  assert.equal(evaluateDeal(listing({ bidCount: 1 }), { marketValue: 200, confidence: 0.9 }, strict).isDeal, false);
  assert.equal(evaluateDeal(listing({ bidCount: 1, isAuction: false }), { marketValue: 200, confidence: 0.9 }, strict).isDeal, true);
});
