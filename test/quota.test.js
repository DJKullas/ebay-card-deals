import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EbayClient, normaliseSummary } from '../src/ebay/client.js';
import { pickStatistic } from '../src/pricing/ebayActive.js';

test('canSpendOptional keeps enough quota for the mandatory searches', () => {
  const c = new EbayClient({ apiKey: 'x' });
  // 10 days left, 10-min interval => 1440 runs × 2 searches = 2880 needed (+100 reserve)
  c.quota = { limit: 10000, remaining: 3000, resetSeconds: 10 * 86400 };
  assert.equal(c.canSpendOptional({ intervalMinutes: 10, mandatoryPerRun: 2, reserve: 100 }), true);
  c.quota.remaining = 2900;
  assert.equal(c.canSpendOptional({ intervalMinutes: 10, mandatoryPerRun: 2, reserve: 100 }), false);
  // unknown quota never blocks
  c.quota = { limit: null, remaining: null, resetSeconds: null };
  assert.equal(c.canSpendOptional({ intervalMinutes: 10, mandatoryPerRun: 2 }), true);
});

test('extraRequestsAllowed spreads spare quota over remaining runs with a burst factor', () => {
  const c = new EbayClient({ apiKey: 'x' });
  // 10 days left, 15-min interval => 960 runs × 3 mandatory = 2880; remaining 4900 - 100 reserve => 1920 spare => 2/run × burst 4 = 8
  c.quota = { limit: 10000, remaining: 4900, resetSeconds: 10 * 86400 };
  assert.equal(c.extraRequestsAllowed({ intervalMinutes: 15, mandatoryPerRun: 3, reserve: 100, burst: 4 }), 8);
  // nothing spare => 0
  c.quota.remaining = 2980;
  assert.equal(c.extraRequestsAllowed({ intervalMinutes: 15, mandatoryPerRun: 3, reserve: 100, burst: 4 }), 0);
  // unknown quota => 0 (be conservative with paid requests)
  c.quota = { limit: null, remaining: null, resetSeconds: null };
  assert.equal(c.extraRequestsAllowed({ intervalMinutes: 15, mandatoryPerRun: 3 }), 0);
});

test('pickStatistic', () => {
  const s = [10, 40, 55, 56, 66, 68];
  assert.equal(pickStatistic(s, 'min'), 10);
  assert.equal(pickStatistic(s, 'p25'), 40);
  assert.equal(pickStatistic(s, 'median'), 56);
  assert.equal(pickStatistic([], 'p25'), null);
});

test('normaliseSummary picks the bid for auctions and the price for BINs', () => {
  const base = { itemId: 'v1|1|0', title: 't', itemWebUrl: 'https://www.ebay.com/itm/1?x=1', itemEndDate: '2026-09-05T20:00:00.000Z' };
  const auction = normaliseSummary({ ...base, buyingOptions: ['AUCTION'], currentBidPrice: { value: '12.50', currency: 'USD' }, shippingOptions: [{ shippingCostType: 'FIXED', shippingCost: { value: '4.99' } }] });
  assert.equal(auction.isAuction, true);
  assert.equal(auction.currentPrice, 12.5);
  assert.equal(auction.shippingCost, 4.99);
  assert.equal(auction.url, 'https://www.ebay.com/itm/1');
  assert.ok(auction.endDate instanceof Date);
  const bin = normaliseSummary({ ...base, buyingOptions: ['FIXED_PRICE'], price: { value: '99', currency: 'USD' }, shippingOptions: [{ shippingCostType: 'CALCULATED' }] });
  assert.equal(bin.isAuction, false);
  assert.equal(bin.currentPrice, 99);
  assert.equal(bin.shippingCost, null);
});
