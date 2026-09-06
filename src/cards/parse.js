/**
 * Turn a messy eBay title (plus optional item specifics) into structured facts
 * we can match against a price guide: grader, grade, card number, year,
 * language, variant hints and a clean token list.
 */

// Words that carry no identifying information about *which* card it is.
const NOISE = new Set([
  'psa', 'bgs', 'cgc', 'sgc', 'gem', 'mint', 'mt', 'graded', 'grade', 'gm', 'gem-mint',
  'card', 'cards', 'tcg', 'the', 'a', 'an', 'of', 'and', '&', 'w', 'with', 'for',
  'company', 'pokemon', 'pokémon', 'rc', 'rookie', 'ssp', 'sp', 'hot', 'rare', 'invest',
  'look', 'wow', 'nice', 'beautiful', 'pop', 'low', 'high', 'lot', 'nm', 'eng', 'english',
  'en', 'us', 'usa', 'ship', 'ships', 'free', 'shipping', 'fast', 'new', 'sealed',
  'trading', 'single', 'singles', 'collectible', 'game', 'games', 'authentic', 'cert',
  'certified', 'ungraded', 'raw', 'hof', 'mvp', 'star', 'legend', 'goat', 'rip', 'read',
  'description', 'see', 'pics', 'photos', 'pictures', 'in', 'on', 'from', 'to', 'by', 'no',
  'jp', 'japan', 'japanese', 'holo', 'holofoil', 'foil', 'full', 'art', 'ex', 'gx', 'v',
  'vmax', 'vstar', 'ir', 'sir', 'ar', 'sar', 'rrr', 'sr', 'ur', 'hr', 'chr', 'ssr', 'illustration',
  'special', 'ultra', 'secret', 'hyper', 'alt', 'alternate',
]);
// A few of the above are meaningful for matching (they appear in guide product
// names), so we keep them in the token list and only drop them from the query.
const KEEP_IN_TOKENS = new Set(['japanese', 'japan', 'jp', 'holo', 'ex', 'gx', 'v', 'vmax', 'vstar', 'full', 'art', 'reverse', '1st', 'edition', 'shadowless', 'gem', 'mint', 'illustration', 'special', 'ultra', 'secret', 'hyper', 'alt', 'alternate', 'rrr', 'sr', 'ur', 'hr', 'chr', 'ssr', 'ir', 'sir', 'ar', 'sar']);

/**
 * Grader detection. Each pattern must capture the numeric grade in group 1.
 * "PSA 10", "PSA-10", "PSA GEM MT 10", "PSA 10 GEM MINT" all match; "PSA
 * Authentic Auto 10" does not (the auto grade is not the card grade).
 */
const GRADER_PATTERNS = {
  PSA: /\bPSA(?:[\s\-–:]*(?:GEM|MINT|MT))*[\s\-–:]*(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4|3|2|1)(?![\d.])(?!\s*\/)/i,
  BGS: /\bBGS(?:[\s\-–:]*(?:GEM|MINT|MT|PRISTINE|BLACK\s*LABEL))*[\s\-–:]*(10|9\.5|9|8\.5|8|7\.5|7)(?![\d.])/i,
  CGC: /\bCGC(?:[\s\-–:]*(?:GEM|MINT|MT|PRISTINE|PERFECT))*[\s\-–:]*(10|9\.5|9|8\.5|8|7\.5|7)(?![\d.])/i,
  SGC: /\bSGC(?:[\s\-–:]*(?:GEM|MINT|MT|GM|PRISTINE))*[\s\-–:]*(10|9\.5|9|8\.5|8|7\.5|7)(?![\d.])/i,
};

const YEAR_RE = /\b(19[5-9]\d|20[0-4]\d)(?:-\d{2})?\b/;
// Pokemon style "046/060", "4/102", "SV065/SV122"
const TCG_NUMBER_RE = /\b([A-Z]{0,3}\d{1,3})\s*\/\s*([A-Z]{0,3}\d{1,3})\b/i;
// Sports style "#27", "# P-37", "No. 280", "#BSPA-FV"
const HASH_NUMBER_RE = /(?:#|\bno\.?\s*)\s*([A-Z]{0,6}-?\d{1,4}[A-Z]?|[A-Z]{1,6}-[A-Z0-9]{1,6})\b/i;
// Letters-hyphen-letters/numbers tokens like "CHRU-LK", "RR-26", "BCP-180" without a '#'
const CODE_NUMBER_RE = /\b([A-Z]{1,6}-[A-Z0-9]{1,6})\b/;
// Note: serial numbering like "/199" or "24/99" is NOT a card number in sports;
// only '#'-prefixed or CODE-style numbers are used there.
const CERT_RE = /\b(?:cert(?:ification)?(?:\s*(?:no|number|#))?[\s:#-]*)?(\d{8,9})\b/i;
// Words sellers (and the price guides) use for an autographed card. "RPA" =
// rookie patch auto. Deliberately does not include "signature" alone: it is a
// product-line word too (e.g. "Signature Series").
export const AUTOGRAPH_RE = /\b(auto|autos|autograph|autographs|autographed|signed|signatures|rpa|on[\s-]?card\s+auto)\b/i;
const GRADER_MENTION_RE = /\b(psa|bgs|cgc|sgc|beckett|hga|gma|slab|slabbed|graded|gem\s*(?:mint|mt)\s*\d)\b/i;

/**
 * @param {string} title
 * @param {{ kind: 'tcg'|'sports', specifics?: Record<string,string> }} opts
 */
export function parseListing(title, { kind = 'sports', specifics = {} } = {}) {
  const clean = normaliseText(title);
  const spec = normaliseSpecifics(specifics);

  const { grader, grade } = detectGrade(clean, spec);
  const year = detectYear(clean, spec);
  const cardNum = detectCardNumber(clean, kind, spec);
  const certNumber = detectCert(clean, spec);
  const isJapanese = /\b(japanese|japan|jp|jpn)\b/i.test(clean) || /japan/i.test(spec.language ?? '') || /japan/i.test(spec['country of origin'] ?? '');
  const isAutograph = AUTOGRAPH_RE.test(clean) || /^yes$/i.test(spec.autographed ?? '') || /\bauto/i.test(spec.features ?? '');
  // "Graded" without a readable grade (truncated title, "PSA 20", "SGC …"):
  // we must not price it as a raw card.
  const mentionsGrader = GRADER_MENTION_RE.test(clean) || Boolean(spec['professional grader']) || /graded/i.test(spec.condition ?? '');
  const tokens = tokenise(clean);
  const variantTokens = tokens.filter((t) => VARIANT_HINTS.has(t));

  return {
    title,
    clean,
    grader,
    grade,
    year,
    cardNumber: cardNum?.value ?? null, // normalised, e.g. "46", "P37", "CHRULK"
    cardNumberRaw: cardNum?.raw ?? null,
    certNumber,
    isJapanese,
    isAutograph,
    mentionsGrader,
    tokens,
    variantTokens,
    specifics: spec,
    // A compact search query for the price guide.
    query: buildQuery({ tokens, year, cardNumber: cardNum, kind, isJapanese, isAutograph, spec }),
  };
}

/**
 * Which price-guide field to read for a parsed listing's grade.
 * @param {{ grader: string|null, grade: number|null }} parsed
 * @param {Record<string,string>} table  config.gradePriceKeys
 * @returns {{ grader:string|null, grade:number|null, priceKey:string, label:string } | null}  null = no price for this grade
 */
export function resolveGrade(parsed, table) {
  if (!parsed.grader || parsed.grade === null || parsed.grade === undefined) {
    if (parsed.mentionsGrader) return null;
    return table.raw ? { grader: null, grade: null, priceKey: table.raw, label: 'Raw' } : null;
  }
  const key = table[`${parsed.grader} ${parsed.grade}`] ?? table[String(parsed.grade)];
  return key ? { grader: parsed.grader, grade: parsed.grade, priceKey: key, label: `${parsed.grader} ${parsed.grade}` } : null;
}

// Words in a title that signal a parallel / variant. Populated from config at
// import time via setVariantHints so the list is user-editable.
let VARIANT_HINTS = new Set();
export function setVariantHints(words) {
  VARIANT_HINTS = new Set(words.map((w) => w.toLowerCase()));
}

export function normaliseText(s) {
  return String(s ?? '')
    .replace(/pok[eé]mon|pokAcmon|pok\u00c3\u00a9mon/gi, 'pokemon')
    .replace(/[’'`]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseSpecifics(spec) {
  const out = {};
  for (const [k, v] of Object.entries(spec ?? {})) out[k.toLowerCase().trim()] = String(v).trim();
  return out;
}

export function detectGrade(clean, spec = {}) {
  // Item specifics are authoritative when present.
  const graderSpec = spec['professional grader'] ?? '';
  const gradeSpec = spec['grade'] ?? '';
  if (graderSpec && gradeSpec) {
    const grader = Object.keys(GRADER_PATTERNS).find((g) => new RegExp(`\\b${g}\\b|\\(${g}\\)`, 'i').test(graderSpec));
    const grade = Number.parseFloat(gradeSpec);
    if (grader && Number.isFinite(grade)) return { grader, grade };
  }
  for (const [grader, re] of Object.entries(GRADER_PATTERNS)) {
    const m = clean.match(re);
    if (m) return { grader, grade: Number.parseFloat(m[1]) };
  }
  return { grader: null, grade: null };
}

function detectYear(clean, spec) {
  const fromSpec = (spec['year manufactured'] ?? spec['season'] ?? spec['year'] ?? '').match(/\b(19[5-9]\d|20[0-4]\d)\b/);
  if (fromSpec) return Number(fromSpec[1]);
  const m = clean.match(YEAR_RE);
  return m ? Number(m[1]) : null;
}

function detectCardNumber(clean, kind, spec) {
  const fromSpec = spec['card number'];
  if (fromSpec) {
    const n = normaliseCardNumber(fromSpec.split(/\s*\/\s*/)[0]);
    if (n) return { value: n, raw: fromSpec };
  }
  if (kind === 'tcg') {
    const m = clean.match(TCG_NUMBER_RE);
    if (m) return { value: normaliseCardNumber(m[1]), raw: `${m[1]}/${m[2]}` };
    const h = clean.match(HASH_NUMBER_RE);
    if (h) return { value: normaliseCardNumber(h[1]), raw: h[1] };
    return null;
  }
  // sports
  const h = clean.match(HASH_NUMBER_RE);
  if (h) return { value: normaliseCardNumber(h[1]), raw: h[1] };
  const c = clean.match(CODE_NUMBER_RE);
  if (c && !/^\d/.test(c[1])) return { value: normaliseCardNumber(c[1]), raw: c[1] };
  return null;
}

/** "046" -> "46", "P-37" -> "P37", "#280" -> "280", "chru-lk" -> "CHRULK" */
export function normaliseCardNumber(raw) {
  if (!raw) return null;
  let s = String(raw).toUpperCase().replace(/^#/, '').replace(/[\s\-_.]/g, '');
  // strip leading zeros from the numeric run(s)
  s = s.replace(/(^|\D)0+(\d)/g, '$1$2');
  return s || null;
}

function detectCert(clean, spec) {
  const fromSpec = spec['certification number'] ?? spec['cert number'] ?? spec['certification #'];
  if (fromSpec && /^\d{7,10}$/.test(fromSpec.replace(/\D/g, ''))) return fromSpec.replace(/\D/g, '');
  const m = clean.match(CERT_RE);
  return m ? m[1] : null;
}

export function tokenise(clean) {
  return clean
    .toLowerCase()
    .replace(/[^a-z0-9#/'.\-\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.'\-]+|[.'\-]+$/g, ''))
    .map((t) => (/^\d/.test(t) ? t : t.replace(/\./g, ''))) // "j.j." -> "jj", keep "9.5"
    .filter((t) => t && !/^\d+\/\d+$/.test(t)); // drop "24/99" style serials from tokens
}

function buildQuery({ tokens, year, cardNumber, kind, isJapanese, isAutograph = false, spec }) {
  const words = [];
  const seen = new Set();
  const push = (w) => {
    const k = w.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      words.push(w);
    }
  };

  // Item specifics give us the cleanest signal when available.
  const cardName = spec['card name'] ?? spec['player/athlete'] ?? spec['player'] ?? spec['character'];
  const setName = spec['set'] ?? spec['series'];
  if (cardName) cardName.split(/\s+/).forEach(push);
  if (setName) setName.split(/\s+/).forEach(push);

  if (kind === 'sports' && year) push(String(year));
  for (const t of tokens) {
    if (words.length >= 9) break;
    if (NOISE.has(t) && !KEEP_IN_TOKENS.has(t)) continue;
    if (/^\d{4}$/.test(t) && kind !== 'sports') continue; // stray years in TCG titles
    if (/^\d+$/.test(t) && kind === 'sports') continue; // numbers handled via cardNumber
    if (/^#/.test(t) || /^\d/.test(t) || t.includes('/')) continue; // "/50", "rc/10", "24/99"
    if (VARIANT_HINTS.has(t) || KEEP_IN_TOKENS.has(t)) {
      // keep meaningful variant words for TCG (japanese, 1st edition...), but not
      // colour parallels for sports – the guide's search does better without them.
      if (kind === 'tcg' && (t === 'japanese' || t === '1st' || t === 'edition' || t === 'shadowless' || t === 'reverse')) push(t);
      continue;
    }
    push(t);
  }
  if (kind === 'tcg' && isJapanese) push('japanese');
  // The guide files autos under "... Autographs" sets or "[Autograph ...]"
  // variants, so the word helps its search rank the right product first.
  if (isAutograph) push('autograph');
  if (cardNumber) push(`#${cardNumber.value}`);
  return words.join(' ');
}
