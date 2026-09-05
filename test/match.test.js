import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListing, setVariantHints } from '../src/cards/parse.js';
import { matchProduct, parseProductName, parseConsoleName } from '../src/cards/match.js';
import { parallelKeywords, optionalVariantTokens, categories, deal } from '../config/scan.config.js';

setVariantHints(parallelKeywords);
const pokemon = categories.find((c) => c.key === 'pokemon');
const sports = categories.find((c) => c.key === 'sports');
const ctx = (cat, epid = null) => ({ epid, productFilter: cat.productFilter, parallelKeywords, optionalVariantTokens });
const P = (id, console, name, epid) => ({ id, 'console-name': console, 'product-name': name, epid });

test('parseProductName / parseConsoleName', () => {
  assert.deepEqual(parseProductName('Drake Maye [White Prizm Shock] #27'), { name: 'Drake Maye', variant: 'White Prizm Shock', number: '27' });
  assert.deepEqual(parseProductName('Snorlax VMAX #46'), { name: 'Snorlax VMAX', variant: '', number: '46' });
  assert.deepEqual(parseProductName('Macklin Celebrini [Red] #P-37'), { name: 'Macklin Celebrini', variant: 'Red', number: 'P37' });
  assert.deepEqual(parseConsoleName('Football Cards 2024 Panini Select'), { name: 'Panini Select', year: 2024, japanese: false });
  assert.deepEqual(parseConsoleName('Pokemon Japanese Shield'), { name: 'Japanese Shield', year: null, japanese: true });
});

test('picks the base card over parallels when the title has no parallel words', () => {
  const listing = parseListing('2008 Topps Rookie Progression - Tom Brady # 3 PSA 10', { kind: 'sports' });
  const products = [
    P('1', 'Football Cards 2008 Topps Rookie Progression', 'Tom Brady #3'),
    P('2', 'Football Cards 2008 Topps Rookie Progression', 'Tom Brady [Platinum] #3'),
    P('3', 'Football Cards 2008 Topps Rookie Progression', 'Tom Brady [Gold] #3'),
  ];
  const m = matchProduct(listing, products, ctx(sports));
  assert.equal(m.product.id, '1');
  assert.ok(m.confidence >= deal.minMatchConfidence, `confidence ${m.confidence}`);
});

test('picks the parallel when the title names it, tolerating optional words like "Prizm"', () => {
  const listing = parseListing('2024 Panini Select Concourse #27 DRAKE MAYE White Shock ROOKIE RC /199 PSA 10', { kind: 'sports' });
  const products = [
    P('1', 'Football Cards 2024 Panini Select', 'Drake Maye #27'),
    P('2', 'Football Cards 2024 Panini Select', 'Drake Maye [White Prizm Shock] #27'),
    P('3', 'Football Cards 2024 Panini Select', 'Drake Maye [Silver Prizm] #27'),
  ];
  const m = matchProduct(listing, products, ctx(sports));
  assert.equal(m.product.id, '2');
  assert.ok(m.confidence >= deal.minMatchConfidence, `confidence ${m.confidence}`);
});

test('a conflicting card number disqualifies a candidate', () => {
  const listing = parseListing('TUA TAGOVAILOA 2022 SELECT DRAGON SCALE PRIZM #161 PSA 10', { kind: 'sports' });
  const products = [
    P('1', 'Football Cards 2022 Panini Select', 'Tua Tagovailoa [Dragon Scale] #94'),
    P('2', 'Football Cards 2022 Panini Select', 'Tua Tagovailoa [Dragon Scale] #161'),
    P('3', 'Football Cards 2022 Panini Select', 'Tua Tagovailoa [Dragon Scale] #238'),
  ];
  const m = matchProduct(listing, products, ctx(sports));
  assert.equal(m.product.id, '2');
  assert.ok(m.confidence >= deal.minMatchConfidence, `confidence ${m.confidence}`);
});

test('ambiguous numbering (no card number in title) lowers confidence below the threshold', () => {
  const listing = parseListing('TUA TAGOVAILOA 2022 SELECT DRAGON SCALE PRIZM PSA 10', { kind: 'sports' });
  const products = [
    P('1', 'Football Cards 2022 Panini Select', 'Tua Tagovailoa [Dragon Scale] #94'),
    P('2', 'Football Cards 2022 Panini Select', 'Tua Tagovailoa [Dragon Scale] #161'),
  ];
  const m = matchProduct(listing, products, ctx(sports));
  assert.ok(m.confidence < deal.minMatchConfidence, `confidence ${m.confidence}`);
});

test('Japanese vs English sets are not confused', () => {
  const listing = parseListing('POKEMON CARD PSA 10 SNORLAX VMAX 046/060 s1H SHIELD 2019 GEM MINT JAPANESE', { kind: 'tcg' });
  const products = [P('1', 'Pokemon Japanese Shield', 'Snorlax VMAX #46'), P('2', 'Pokemon Sword & Shield', 'Snorlax VMAX #46')];
  const m = matchProduct(listing, products, ctx(pokemon));
  assert.equal(m.product.id, '1');
  assert.ok(m.confidence >= deal.minMatchConfidence, `confidence ${m.confidence}`);
});

test('productFilter drops other games', () => {
  const listing = parseListing('One Piece TCG Nami (Full Art) C ST29-008 Premium Card Collection PSA 10', { kind: 'tcg' });
  const products = [P('1', 'One Piece Premium Card Collection', 'Nami #ST29-008')];
  const m = matchProduct(listing, products, ctx(pokemon));
  assert.equal(m.product, null);
});

test('year mismatch is penalised', () => {
  const listing = parseListing('2023 Topps Chrome Victor Wembanyama #1 PSA 10', { kind: 'sports' });
  const products = [P('1', 'Basketball Cards 2024 Topps Chrome', 'Victor Wembanyama #1'), P('2', 'Basketball Cards 2023 Topps Chrome', 'Victor Wembanyama #1')];
  const m = matchProduct(listing, products, ctx(sports));
  assert.equal(m.product.id, '2');
});

test('"[Refractor]" is not treated as a base card', () => {
  const listing = parseListing('Jackson Holliday 2023 Bowman Chrome Prospects #BCP20 PSA 10 GEM MINT', { kind: 'sports' });
  const products = [
    P('1', 'Baseball Cards 2023 Bowman Chrome Prospects', 'Jackson Holliday [Refractor] #BCP-20'),
    P('2', 'Baseball Cards 2023 Bowman Chrome Prospects', 'Jackson Holliday #BCP-20'),
  ];
  const m = matchProduct(listing, products, ctx(sports));
  assert.equal(m.product.id, '2');
  assert.ok(m.confidence >= deal.minMatchConfidence, `confidence ${m.confidence}`);
});

test('multi-colour parallels beat single-colour ones when the title names both', () => {
  const listing = parseListing('RILEY HERBST 2024 PANINI SELECT NASCAR BLACK & BLUE PRIZM #103 19/49 PSA 10', { kind: 'sports' });
  const products = [
    P('1', 'Racing Cards 2024 Panini Select NASCAR', 'Riley Herbst [Blue Prizm] #103'),
    P('2', 'Racing Cards 2024 Panini Select NASCAR', 'Riley Herbst [Black Blue Prizm] #103'),
  ];
  const m = matchProduct(listing, products, ctx(sports));
  assert.equal(m.product.id, '2');
  assert.ok(m.confidence >= deal.minMatchConfidence, `confidence ${m.confidence}`);
});

test('"Auto" in the title satisfies an [Autograph] variant', () => {
  const listing = parseListing('2000 Playoff Contenders Tom Brady Rookie Auto #144 PSA 10', { kind: 'sports' });
  const products = [P('1', 'Football Cards 2000 Playoff Contenders', 'Tom Brady [Autograph] #144'), P('2', 'Football Cards 2000 Playoff Contenders', 'Tom Brady [Championship Ticket Autograph] #144')];
  const m = matchProduct(listing, products, ctx(sports));
  assert.equal(m.product.id, '1');
  assert.ok(m.confidence >= deal.minMatchConfidence, `confidence ${m.confidence}`);
});

test('a set-name word does not count as the parallel of the same name', () => {
  const listing = parseListing('Panini 2019-20 Mosaic MVPs #297 Giannis Antetokounmpo Bucks PSA 10', { kind: 'sports' });
  const products = [P('1', 'Basketball Cards 2019 Panini Mosaic', 'Giannis Antetokounmpo [Mosaic] #297'), P('2', 'Basketball Cards 2019 Panini Mosaic', 'Giannis Antetokounmpo #297')];
  const m = matchProduct(listing, products, ctx(sports));
  assert.equal(m.product.id, '2');
  assert.ok(m.confidence >= deal.minMatchConfidence, `confidence ${m.confidence}`);
});

test('initials with dots match ("J.J." vs "JJ")', () => {
  const listing = parseListing('2024 PANINI MOSAIC NOTORIETY #21 JJ MCCARTHY ROOKIE RC PSA 10', { kind: 'sports' });
  const products = [P('1', 'Football Cards 2024 Panini Mosaic Notoriety', 'J.J. McCarthy #21'), P('2', 'Football Cards 2024 Panini Mosaic Notoriety', 'J.J. McCarthy [Mosaic] #21')];
  const m = matchProduct(listing, products, ctx(sports));
  assert.equal(m.product.id, '1');
  assert.ok(m.confidence >= deal.minMatchConfidence, `confidence ${m.confidence}`);
});

test('off-by-one year is not enough to be confident', () => {
  const listing = parseListing('Topps 2019 Five Star Autographs Pete Alonso Mets RC Auto #FSA-PA PSA 10', { kind: 'sports' });
  const products = [P('1', 'Baseball Cards 2020 Topps Five Star Autograph', 'Pete Alonso #FSA-PA'), P('2', 'Baseball Cards 2022 Topps Five Star Autographs', 'Pete Alonso #FSA-PA')];
  const m = matchProduct(listing, products, ctx(sports));
  assert.equal(m.product.id, '1');
  assert.ok(m.confidence < deal.minMatchConfidence, `confidence ${m.confidence}`);
});

test('epid match is a certainty', () => {
  const listing = parseListing('weird title PSA 10', { kind: 'tcg' });
  const products = [P('1', 'Pokemon Base Set', 'Charizard #4', '9073635929')];
  const m = matchProduct(listing, products, ctx(pokemon, '9073635929'));
  assert.equal(m.confidence, 1);
});
