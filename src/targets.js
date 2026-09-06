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
const STRICTER_IS_MAX = ['minDiscountPct', 'minMarketValueUsd', 'minSavingsUsd', 'minMatchConfidence', 'minBidCount'];

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
      else if (k === 'requireCardNumber') out[k] = out[k] || v;
      else out[k] = v;
    }
  }
  return out;
}

/** One eBay search per (target, category) pair the target applies to. */
export function searchPlan(targets, categories) {
  const plan = [];
  for (const target of targets) {
    for (const key of target.categoryKeys) {
      const category = categories.find((c) => c.key === key);
      if (!category) throw new Error(`target "${target.key}" references unknown category "${key}"`);
      plan.push({ target, category, query: [category.queryPrefix, target.searchQuery].filter(Boolean).join(' ') });
    }
  }
  return plan;
}
