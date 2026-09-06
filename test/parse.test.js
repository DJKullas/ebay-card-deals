import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListing, setVariantHints, normaliseCardNumber } from '../src/cards/parse.js';
import { parallelKeywords } from '../config/scan.config.js';

setVariantHints(parallelKeywords);

test('detects PSA 10 in common title shapes', () => {
  for (const t of [
    'POKEMON CARD PSA 10 SNORLAX VMAX 046/060 s1H SHIELD 2019 GEM MINT JAPANESE',
    '2024 Panini Select Concourse #27 DRAKE MAYE White Shock ROOKIE RC /199 PSA 10',
    'Charizard VMAX 020/189 Darkness Ablaze PSA GEM MT 10',
    'Tom Brady 2000 Contenders Rookie PSA-10',
    'Mickey Mantle 1952 Topps psa 10 gem mint',
  ]) {
    const p = parseListing(t, { kind: 'sports' });
    assert.equal(p.grader, 'PSA', t);
    assert.equal(p.grade, 10, t);
  }
});

test('does not treat an autograph grade as the card grade', () => {
  const p = parseListing('1994 Classic NFL Draft - Drew Bledsoe #99 Signed PSA Authentic Auto 10 Patriots', { kind: 'sports' });
  assert.equal(p.grade, null);
});

test('other grades / graders are recognised so they can be filtered out', () => {
  assert.deepEqual(pick(parseListing('1986 Fleer Johnny Moore #76 PSA 8', { kind: 'sports' })), { grader: 'PSA', grade: 8 });
  assert.deepEqual(pick(parseListing('Charizard BGS 9.5 Gem Mint', { kind: 'tcg' })), { grader: 'BGS', grade: 9.5 });
  assert.deepEqual(pick(parseListing('Pikachu CGC 10 Pristine', { kind: 'tcg' })), { grader: 'CGC', grade: 10 });
  assert.deepEqual(pick(parseListing('Graded Gem Mint 10 no grader named', { kind: 'tcg' })), { grader: null, grade: null });
});

test('TCG card numbers come from the x/y pattern', () => {
  const p = parseListing('POKEMON CARD PSA 10 SNORLAX VMAX 046/060 s1H SHIELD 2019 GEM MINT JAPANESE', { kind: 'tcg' });
  assert.equal(p.cardNumber, '46');
  assert.equal(p.isJapanese, true);
  assert.match(p.query, /snorlax/);
  assert.match(p.query, /#46/);
  assert.match(p.query, /japanese/);

  const q = parseListing('Misdreavus 233/217 Me: Ascended Heroes Illustration Rare PSA 10', { kind: 'tcg' });
  assert.equal(q.cardNumber, '233');
  assert.equal(q.isJapanese, false);
});

test('sports card numbers come from # or CODE-style tokens, never from serials', () => {
  assert.equal(parseListing('2024 Panini Select Concourse #27 DRAKE MAYE White Shock ROOKIE RC /199 PSA 10', { kind: 'sports' }).cardNumber, '27');
  assert.equal(parseListing('Topps 2025 Chrome Update Chromeography Luke Keaschall Auto RC CHRU-LK PSA 10', { kind: 'sports' }).cardNumber, 'CHRULK');
  assert.equal(parseListing('2024 UPPER DECK UD PORTRAITS #P37 MACKLIN CELEBRINI PSA 10', { kind: 'sports' }).cardNumber, 'P37');
  assert.equal(parseListing('2022 Bowman Sapphire PSA 10 1st Felix Valerio On Card Auto AQUA 24/99 #BSPA-FV', { kind: 'sports' }).cardNumber, 'BSPAFV');
  assert.equal(parseListing('2018 Panini Prizm Luka Doncic Silver PSA 10 /99', { kind: 'sports' }).cardNumber, null);
  // "#48/199" is a print run, not card #48; "#280 /199" is card 280 with a print run
  assert.equal(parseListing('2018-19 Select Trae Young Rookie Jersey Auto RC #48/199 Hawks BGS 9', { kind: 'sports' }).cardNumber, null);
  assert.equal(parseListing('2018 Panini Prizm Luka Doncic #280 /199 Silver PSA 10', { kind: 'sports' }).cardNumber, '280');
});

test('year detection', () => {
  assert.equal(parseListing('2018 Panini Prizm Luka Doncic #280 PSA 10', { kind: 'sports' }).year, 2018);
  assert.equal(parseListing('Luka Doncic 2018-19 Prizm #280 PSA 10', { kind: 'sports' }).year, 2018);
});

test('item specifics override title parsing', () => {
  const p = parseListing('Some vague title PSA 10', {
    kind: 'tcg',
    specifics: { 'Card Number': '046/060', 'Card Name': 'Snorlax VMAX', Set: 'S1h: Shield', Grade: '10', 'Professional Grader': 'Professional Sports Authenticator (PSA)', 'Certification Number': '156610507', Language: 'Japanese' },
  });
  assert.equal(p.cardNumber, '46');
  assert.equal(p.certNumber, '156610507');
  assert.equal(p.grader, 'PSA');
  assert.equal(p.isJapanese, true);
  assert.match(p.query, /^Snorlax VMAX/);
});

test('query drops serial-number fragments', () => {
  const p = parseListing('2019 Bowman Chrome GOLD REFRACTOR ~ FERNANDO TATIS RC Card /50 PSA 10 GEM MINT', { kind: 'sports' });
  assert.doesNotMatch(p.query, /\//);
  assert.equal(p.cardNumber, null);
});

test('normaliseCardNumber', () => {
  assert.equal(normaliseCardNumber('#046'), '46');
  assert.equal(normaliseCardNumber('P-37'), 'P37');
  assert.equal(normaliseCardNumber('chru-lk'), 'CHRULK');
  assert.equal(normaliseCardNumber('SV065'), 'SV65');
});

function pick(p) {
  return { grader: p.grader, grade: p.grade };
}
