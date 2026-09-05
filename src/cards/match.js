/**
 * Score price-guide candidates against a parsed eBay listing and return the
 * best one with a 0-1 confidence.
 *
 * Price guide products look like:
 *   console-name: "Football Cards 2024 Panini Select"   product-name: "Drake Maye [White Prizm Shock] #27"
 *   console-name: "Pokemon Japanese Shield"             product-name: "Snorlax VMAX #46"
 */
import { normaliseCardNumber, tokenise, normaliseText } from './parse.js';

const CATEGORY_PREFIX_RE = /^(pokemon|baseball cards|basketball cards|football cards|hockey cards|soccer cards|golf cards|wrestling cards|racing cards|boxing cards|mma cards|ufc cards|tennis cards|multi-sport cards|non-sport cards|magic|yugioh|one piece|lorcana|digimon|dragon ball|weiss schwarz|metazoo|flesh and blood|star wars|marvel|garbage pail kids)\b/i;

const WEIGHTS = {
  number: 0.35,
  name: 0.35,
  set: 0.2,
  year: 0.05,
  variant: 0.05,
};

// Seller shorthand -> price guide wording.
const SYNONYMS = {
  autograph: ['auto', 'au', 'autographed', 'signed'],
  refractor: ['ref', 'refractors'],
  prizm: ['prism', 'prizms'],
  '1st': ['first'],
  edition: ['ed'],
  'die-cut': ['diecut', 'die'],
  holo: ['holofoil', 'holographic'],
  reverse: ['rev'],
};

function hasToken(titleTokens, t) {
  if (titleTokens.has(t)) return true;
  return (SYNONYMS[t] ?? []).some((s) => titleTokens.has(s));
}

/** Exact / synonym / shared 5+ char prefix ("autograph" ~ "autographs", "signature" ~ "signatures"). */
function hasTokenLoose(titleTokens, t) {
  if (hasToken(titleTokens, t)) return true;
  if (t.length < 5) return false;
  for (const tt of titleTokens) {
    if (tt.length >= 5 && (tt.startsWith(t) || t.startsWith(tt))) return true;
  }
  return false;
}

/** Is title token `t` accounted for by one of `tokens` (exact, synonym or prefix, e.g. auto ~ autographs)? */
function explainedBy(tokens, t) {
  return tokens.some((tok) => tok === t || (SYNONYMS[tok] ?? []).includes(t) || (t.length >= 4 && tok.startsWith(t)));
}

/**
 * @param {import('./parse.js').parseListing extends (...a: any) => infer R ? R : never} listing
 * @param {Array<{id:string,'console-name':string,'product-name':string,epid?:string}>} products
 * @param {{ epid?: string|null, productFilter?: RegExp, parallelKeywords: string[], optionalVariantTokens: string[] }} ctx
 * @returns {{ product: object|null, confidence: number, reasons: string[], candidates: Array<{product:object, score:number, reasons:string[]}> }}
 */
export function matchProduct(listing, products, ctx) {
  const optional = new Set((ctx.optionalVariantTokens ?? []).map((s) => s.toLowerCase()));
  const parallels = new Set((ctx.parallelKeywords ?? []).map((s) => s.toLowerCase()));
  const titleTokens = new Set(listing.tokens);

  const scored = [];
  for (const product of products) {
    if (ctx.productFilter && !ctx.productFilter.test(product['console-name'] ?? '')) continue;

    // Exact eBay catalogue match beats everything.
    if (ctx.epid && product.epid && String(product.epid) === String(ctx.epid)) {
      return { product, confidence: 1, reasons: ['epid match'], candidates: [{ product, score: 1, reasons: ['epid match'] }] };
    }

    const { name, variant, number } = parseProductName(product['product-name']);
    const set = parseConsoleName(product['console-name']);
    const reasons = [];
    let score = 0;

    // Card number: strongest signal. A conflicting number is disqualifying.
    if (listing.cardNumber && number) {
      if (listing.cardNumber === number) {
        score += WEIGHTS.number;
        reasons.push('number');
      } else {
        continue;
      }
    }

    // Name (player / Pokemon) — every name token must be in the title.
    const nameTokens = tokenise(name).filter((t) => t.length > 1 || /^\d$/.test(t));
    const nameHits = nameTokens.filter((t) => titleTokens.has(t)).length;
    const nameRatio = nameTokens.length ? nameHits / nameTokens.length : 0;
    if (nameRatio < 0.5) continue;
    score += WEIGHTS.name * nameRatio;
    if (nameRatio === 1) reasons.push('name');
    else reasons.push(`name ${nameHits}/${nameTokens.length}`);

    // Set / series tokens from console-name (loose: "autograph" ~ "autographs").
    const setTokens = tokenise(set.name).filter((t) => !/^\d{4}$/.test(t));
    const setHits = setTokens.filter((t) => hasTokenLoose(titleTokens, t) || (t === 'japanese' && listing.isJapanese)).length;
    const setRatio = setTokens.length ? setHits / setTokens.length : 1;
    score += WEIGHTS.set * setRatio;
    if (setTokens.length) reasons.push(`set ${setHits}/${setTokens.length}`);

    // Year (sports guides embed it in console-name).
    if (set.year && listing.year) {
      const diff = Math.abs(set.year - listing.year);
      if (diff === 0) {
        score += WEIGHTS.year;
        reasons.push('year');
      } else {
        // Off-by-one is common (season vs release year) but still not something
        // we want to bet money on without other strong evidence.
        score -= diff === 1 ? 0.25 : 0.4;
        reasons.push(`year mismatch (${listing.year} vs ${set.year})`);
      }
    }

    // Language.
    if (set.japanese !== listing.isJapanese) {
      score -= 0.4;
      reasons.push(set.japanese ? 'guide is Japanese, listing is not' : 'listing is Japanese, guide is not');
    }

    // Variant / parallel.
    const allVariantTokens = tokenise(variant);
    const variantTokens = allVariantTokens.filter((t) => !optional.has(t));
    // Parallel words in the title that aren't part of the name or set.
    const titleParallels = [...titleTokens].filter((t) => parallels.has(t) && !optional.has(t) && !explainedBy(nameTokens, t) && !explainedBy(setTokens, t));
    if (variantTokens.length) {
      const hits = variantTokens.filter((t) => hasToken(titleTokens, t)).length;
      if (hits === variantTokens.length) {
        score += WEIGHTS.variant;
        reasons.push('variant');
        // "[Blue Prizm]" should lose to "[Black Blue Prizm]" when the title says "Black & Blue".
        const unexplained = titleParallels.filter((t) => !explainedBy(variantTokens, t));
        if (unexplained.length) {
          score -= Math.min(0.3, 0.15 * unexplained.length);
          reasons.push(`title also says ${unexplained.join(', ')}`);
        }
      } else {
        score -= 0.5;
        reasons.push(`variant "${variant}" not in title`);
      }
    } else if (allVariantTokens.length) {
      // Variant made only of "optional" words, e.g. "[Refractor]". Still a
      // different card from the base, so the title must mention it — and the
      // mention must not just be the set name ("Panini Mosaic" vs "[Mosaic]").
      if (allVariantTokens.some((t) => hasToken(titleTokens, t) && !explainedBy(setTokens, t))) {
        score += WEIGHTS.variant;
        reasons.push('variant');
      } else {
        score -= 0.3;
        reasons.push(`variant "${variant}" not in title`);
      }
    } else {
      // Base card in the guide, but the title advertises a parallel?
      if (titleParallels.length) {
        score -= 0.2;
        reasons.push(`title has parallel words (${titleParallels.join(', ')}) but guide product is base`);
      } else {
        score += WEIGHTS.variant;
        reasons.push('base');
      }
    }

    scored.push({ product, score, reasons });
  }

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return { product: null, confidence: 0, reasons: ['no candidates survived'], candidates: [] };

  const best = scored[0];
  let confidence = clamp(best.score, 0, 1);
  const reasons = [...best.reasons];
  if (scored[1] && best.score - scored[1].score < 0.1) {
    confidence -= 0.15;
    reasons.push(`ambiguous with "${scored[1].product['product-name']}"`);
  }
  if (!listing.cardNumber) reasons.push('no card number in listing');
  return { product: best.product, confidence: clamp(confidence, 0, 1), reasons, candidates: scored };
}

/** "Drake Maye [White Prizm Shock] #27" -> { name, variant, number } */
export function parseProductName(pn) {
  const s = normaliseText(pn);
  const variant = [...s.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]).join(' ');
  const numMatch = s.match(/#\s*([A-Za-z0-9\-/.]+)\s*$/) ?? s.match(/#\s*([A-Za-z0-9\-/.]+)/);
  const number = numMatch ? normaliseCardNumber(numMatch[1].split('/')[0]) : null;
  const name = s.replace(/\[[^\]]*\]/g, ' ').replace(/#\s*[A-Za-z0-9\-/.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { name, variant, number };
}

/** "Football Cards 2024 Panini Select" -> { name: "Panini Select", year: 2024, japanese: false } */
export function parseConsoleName(cn) {
  const s = normaliseText(cn);
  const yearMatch = s.match(/\b(19[5-9]\d|20[0-4]\d)(?:-\d{2})?\b/);
  const japanese = /\bjapanese\b/i.test(s);
  const name = s
    .replace(CATEGORY_PREFIX_RE, ' ')
    .replace(/\b(19[5-9]\d|20[0-4]\d)(?:-\d{2})?\b/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { name, year: yearMatch ? Number(yearMatch[1]) : null, japanese };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
