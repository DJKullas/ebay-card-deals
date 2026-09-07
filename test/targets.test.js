import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListing, resolveGrade, setVariantHints } from '../src/cards/parse.js';
import { matchProduct } from '../src/cards/match.js';
import { matchesTarget, mergeDealRules, searchPlan } from '../src/targets.js';
import * as config from '../config/scan.config.js';

setVariantHints(config.parallelKeywords);
const sports = config.categories.find((c) => c.key === 'sports');
const psa10 = config.targets.find((t) => t.key === 'psa10');
const auto = config.targets.find((t) => t.key === 'auto');
const ctx = (cat) => ({ epid: null, productFilter: cat.productFilter, parallelKeywords: config.parallelKeywords, optionalVariantTokens: config.optionalVariantTokens });
const P = (id, console, name, epid) => ({ id, 'console-name': console, 'product-name': name, epid });

test('autograph detection in titles', () => {
  assert.equal(parseListing('2020 Panini Prizm Justin Herbert Rookie Auto #325 PSA 10').isAutograph, true);
  assert.equal(parseListing('2023 Topps Chrome Autographs Gunnar Henderson #CA-GH').isAutograph, true);
  assert.equal(parseListing('2020 Panini Prizm Justin Herbert #325 PSA 10').isAutograph, false);
  // "Signature" alone is a product-line word, not proof of an autograph.
  assert.equal(parseListing('2019 Panini Signature Series Tom Brady #12').isAutograph, false);
  // "Autozone" must not trip it.
  assert.equal(parseListing('2022 Autozone promo Kyle Busch #5').isAutograph, false);
});

test('targets: PSA 10 vs autograph (any grade / raw)', () => {
  const psa10Base = parseListing('2020 Panini Prizm Justin Herbert #325 PSA 10');
  const psa9Auto = parseListing('2020 Panini Prizm Justin Herbert Auto #325 PSA 9');
  const rawAuto = parseListing('2020 Panini Prizm Justin Herbert Rookie Auto #325');
  const raw = parseListing('2020 Panini Prizm Justin Herbert #325');
  assert.equal(matchesTarget(psa10, psa10Base), true);
  assert.equal(matchesTarget(auto, psa10Base), false);
  assert.equal(matchesTarget(psa10, psa9Auto), false);
  assert.equal(matchesTarget(auto, psa9Auto), true);
  assert.equal(matchesTarget(auto, rawAuto), true);
  assert.equal(matchesTarget(psa10, raw), false);
  assert.equal(matchesTarget(auto, raw), false);
});

test('autograph target excludes hand-signed / authenticated / multi-player autos', () => {
  for (const t of [
    'Tom Brady signed 2000 Bowman #236 JSA COA',
    'Patrick Mahomes Autographed Card PSA/DNA',
    'Justin Herbert Auto In Person 2020 Prizm #325',
    'Joe Burrow Redemption Auto 2020 Prizm #307',
    'Burrow / Herbert Dual Auto 2020 Contenders #5',
    'Luka Doncic auto reprint #280',
  ]) {
    assert.ok(auto.titleExclude.test(t), `should exclude: ${t}`);
  }
  assert.ok(!auto.titleExclude.test('2020 Panini Prizm Justin Herbert Rookie Auto #325 PSA 10'));
  assert.ok(!auto.titleExclude.test('2023 Topps Chrome Sapphire Gunnar Henderson RPA Auto #CA-GH /99'));
});

test('resolveGrade maps grades to guide fields, raw to loose-price', () => {
  const t = config.gradePriceKeys;
  assert.deepEqual(resolveGrade({ grader: 'PSA', grade: 10 }, t), { grader: 'PSA', grade: 10, priceKey: 'manual-only-price', label: 'PSA 10' });
  assert.equal(resolveGrade({ grader: 'BGS', grade: 10 }, t).priceKey, 'bgs-10-price');
  assert.equal(resolveGrade({ grader: 'BGS', grade: 9.5 }, t).priceKey, 'box-only-price');
  assert.equal(resolveGrade({ grader: 'PSA', grade: 9 }, t).priceKey, 'graded-price');
  assert.equal(resolveGrade({ grader: 'SGC', grade: 8 }, t).priceKey, 'new-price');
  assert.deepEqual(resolveGrade({ grader: null, grade: null }, t), { grader: null, grade: null, priceKey: 'loose-price', label: 'Raw' });
  assert.equal(resolveGrade({ grader: 'PSA', grade: 5 }, t), null, 'grades with no guide field are not priced');
  // graded but the grade is unreadable (truncated title, nonsense grade) => never priced as raw
  assert.equal(resolveGrade(parseListing("2022 Panini Elite Sauce Gardner TC-28 Rookie Auto Black Gold 21/25 SGC …"), t), null);
  assert.equal(resolveGrade(parseListing('2025 Prizm Colston Loveland RC Auto #12 PSA 20, Pop 1'), t), null);
  assert.equal(resolveGrade(parseListing('2020 Prizm Justin Herbert Auto #325 slabbed'), t), null);
  assert.equal(resolveGrade(parseListing('2020 Prizm Justin Herbert Auto #325'), t).label, 'Raw');
});

test('stricter rules win when a listing satisfies several targets', () => {
  const rules = mergeDealRules(config.deal, [psa10, auto]);
  assert.equal(rules.minMatchConfidence, Math.max(config.deal.minMatchConfidence, auto.deal.minMatchConfidence));
  assert.equal(rules.minDiscountPct, Math.max(config.deal.minDiscountPct, auto.deal.minDiscountPct));
  assert.equal(rules.requireCardNumber, config.deal.requireCardNumber);
  assert.deepEqual(mergeDealRules(config.deal, [psa10]), config.deal);
  const loose = mergeDealRules(config.deal, [{ deal: { minSalesPerYear: 1, excludeNonEnglish: false } }]);
  assert.equal(loose.minSalesPerYear, config.deal.minSalesPerYear, 'a target cannot loosen the liquidity floor');
  assert.equal(loose.excludeNonEnglish, true, 'a target cannot re-enable non-English cards');
});

test('config: liquidity floor is well above one sale a year, non-English excluded', () => {
  assert.ok(config.deal.minSalesPerYear >= 6);
  assert.equal(config.deal.excludeNonEnglish, true);
});

test('searchPlan: one eBay search per category with its targets OR-ed together', () => {
  const plan = searchPlan(config.targets, config.categories);
  assert.equal(plan.length, config.categories.length);
  const pokemon = plan.find((p) => p.category.key === 'pokemon');
  assert.equal(pokemon.query, 'pokemon psa 10');
  assert.deepEqual(pokemon.targets.map((t) => t.key), ['psa10']);
  assert.deepEqual(pokemon.conditionIds, ['2750']);
  const sportsPlan = plan.find((p) => p.category.key === 'sports');
  assert.equal(sportsPlan.query, '(psa 10,auto,autograph)');
  assert.deepEqual(sportsPlan.targets.map((t) => t.key), ['psa10', 'auto']);
  assert.deepEqual(sportsPlan.conditionIds, [], 'targets disagree on condition → no filter');
  assert.equal(sportsPlan.minPrice, 20);
});

test('a non-auto listing is never priced as the autograph product', () => {
  const listing = parseListing('2020 Panini Prizm Justin Herbert #325 PSA 10 Rookie', { kind: 'sports' });
  const products = [
    P('1', 'Football Cards 2020 Panini Prizm', 'Justin Herbert [Autograph] #325'),
    P('2', 'Football Cards 2020 Panini Prizm', 'Justin Herbert [Autograph Red Wave] #325'),
  ];
  const m = matchProduct(listing, products, ctx(sports));
  assert.equal(m.product, null);
  assert.ok(m.reasons.some((r) => /autograph/.test(r)));
});

test('an auto listing is never priced as the base card, even via ePID', () => {
  const listing = parseListing('2020 Panini Prizm Justin Herbert Rookie Auto #325 PSA 10', { kind: 'sports' });
  const products = [P('1', 'Football Cards 2020 Panini Prizm', 'Justin Herbert #325', '123'), P('2', 'Football Cards 2020 Panini Prizm', 'Justin Herbert [Silver Prizm] #325')];
  const m = matchProduct(listing, products, { ...ctx(sports), epid: '123' });
  assert.equal(m.product, null);
});

test('an auto listing matches the auto product in an "Autographs" set', () => {
  const listing = parseListing('2020 Panini Mosaic Rookie Autographs Tua Tagovailoa #RA3 Auto RC', { kind: 'sports' });
  const products = [
    P('1', 'Football Cards 2020 Panini Mosaic', 'Tua Tagovailoa #RA3'),
    P('2', 'Football Cards 2020 Panini Mosaic Rookie Autographs', 'Tua Tagovailoa #RA3'),
    P('3', 'Football Cards 2020 Panini Mosaic Rookie Autographs', 'Tua Tagovailoa [Gold] #RA3'),
  ];
  const m = matchProduct(listing, products, ctx(sports));
  assert.equal(m.product.id, '2');
  assert.ok(m.confidence >= auto.deal.minMatchConfidence, `confidence ${m.confidence}`);
});

test('an auto parallel is not priced as the base auto', () => {
  const listing = parseListing('2020 Panini Mosaic Rookie Autographs Tua Tagovailoa #RA3 Gold Auto /10', { kind: 'sports' });
  const products = [P('2', 'Football Cards 2020 Panini Mosaic Rookie Autographs', 'Tua Tagovailoa #RA3')];
  const m = matchProduct(listing, products, ctx(sports));
  assert.ok(!m.product || m.confidence < auto.deal.minMatchConfidence, `confidence ${m.confidence}`);
});

test('raw auto with a card number reaches the autograph confidence bar', () => {
  const listing = parseListing('2020 Panini Prizm Draft Picks Justin Herbert Rookie Auto #102', { kind: 'sports' });
  const products = [
    P('1', 'Football Cards 2020 Panini Prizm Draft Picks', 'Justin Herbert [Autograph] #102'),
    P('2', 'Football Cards 2020 Panini Prizm Draft Picks', 'Justin Herbert [Autograph Red Prizm] #102'),
    P('3', 'Football Cards 2020 Panini Prizm Draft Picks', 'Justin Herbert #102'),
  ];
  const m = matchProduct(listing, products, ctx(sports));
  assert.equal(m.product.id, '1');
  assert.ok(m.confidence >= auto.deal.minMatchConfidence, `confidence ${m.confidence}`);
});
