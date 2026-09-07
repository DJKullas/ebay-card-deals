/**
 * Helpers for config.targets: which listings we hunt for and how strictly.
 */

/** Does a parsed listing satisfy a target's `require` block? */
export function matchesTarget(target, parsed) {
  const req = target.require ?? {};
  if (req.grader !== undefined && parsed.grader !== req.grader) return false;
  if (req.grade !== undefined && parsed.grade !== req.grade) return false;
  if (req.autograph !== undefined && Boolean(parsed.isAutograph) !== req.autograph) return false;
  return true;
}

// Rule fields where a larger number means "harder to qualify as a deal".
const STRICTER_IS_MAX = ['minDiscountPct', 'minMarketValueUsd', 'minSavingsUsd', 'minMatchConfidence', 'minBidCount', 'minSalesPerYear'];

/**
 * Combine the global deal rules with the overrides of every target a listing
 * satisfies. When targets disagree the stricter value wins, so a PSA 10 auto
 * is held to the autograph target's tighter confidence bar.
 */
export function mergeDealRules(base, targets) {
  const out = { ...base };
  for (const t of targets) {
    for (const [k, v] of Object.entries(t.deal ?? {})) {
      if (STRICTER_IS_MAX.includes(k) && typeof out[k] === 'number') out[k] = Math.max(out[k], v);
      else if (k === 'requireCardNumber' || k === 'excludeNonEnglish') out[k] = out[k] || v;
      else out[k] = v;
    }
  }
  return out;
}

/**
 * ONE eBay search per category, covering every target that applies to it, so
 * the RapidAPI cost per scan is the number of categories (the API rejects
 * multiple category ids in one call, so categories can't be merged further).
 * The targets' search terms are OR-ed with eBay's "(a,b,c)" syntax; the
 * condition filter is only kept if every target agrees on it; the price floor
 * is the lowest of the targets'. Which target(s) a listing actually satisfies
 * is decided later from the parsed title (`matchesTarget`).
 */
export function searchPlan(targets, categories) {
  const plan = [];
  for (const category of categories) {
    const applicable = targets.filter((t) => t.categoryKeys.includes(category.key));
    if (!applicable.length) continue;
    const terms = [...new Set(applicable.flatMap((t) => t.searchTerms))];
    const group = terms.length > 1 ? `(${terms.join(',')})` : terms[0];
    const query = [category.queryPrefix, group].filter(Boolean).join(' ');
    const conditionSets = applicable.map((t) => JSON.stringify([...(t.conditionIds ?? [])].sort()));
    const conditionIds = new Set(conditionSets).size === 1 ? [...(applicable[0].conditionIds ?? [])] : [];
    const minPrice = Math.min(...applicable.map((t) => t.minPrice ?? 0));
    plan.push({ category, targets: applicable, query, conditionIds, minPrice: minPrice || undefined });
  }
  for (const t of targets) {
    for (const key of t.categoryKeys) {
      if (!categories.some((c) => c.key === key)) throw new Error(`target "${t.key}" references unknown category "${key}"`);
    }
  }
  return plan;
}
