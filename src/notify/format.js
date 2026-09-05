/** Shared formatting for email / Discord / console. */

export function fmtMoney(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtTime(date, timezone) {
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date);
}

export function minutesUntil(date, now = new Date()) {
  if (!date) return null;
  return Math.max(0, Math.round((date.getTime() - now.getTime()) / 60000));
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * @param {Array<import('../index.js').Deal>} deals
 * @param {{ timezone:string }} opts
 */
export function renderEmailHtml(deals, { timezone }) {
  const rows = deals
    .map((d) => {
      const l = d.listing;
      const mins = minutesUntil(l.endDate);
      const priceLabel = l.isAuction ? `Bid ${fmtMoney(l.currentPrice)} (${l.bidCount} bids)` : `BIN ${fmtMoney(l.currentPrice)}`;
      const ship = l.shippingCost === null ? `+ ~${fmtMoney(d.eval.totalCost - (l.currentPrice ?? 0))} ship (est.)` : `+ ${fmtMoney(l.shippingCost)} ship`;
      return `
      <tr>
        <td style="padding:8px;vertical-align:top;">${l.imageUrl ? `<img src="${escapeHtml(l.imageUrl)}" width="72" alt="" style="border-radius:4px;">` : ''}</td>
        <td style="padding:8px;vertical-align:top;">
          <a href="${escapeHtml(l.url)}" style="font-weight:600;font-size:15px;">${escapeHtml(l.title)}</a><br>
          <span style="color:#555;">${escapeHtml(d.category.label)} · ${escapeHtml(d.grade.grader)} ${d.grade.grade} · ends in <b>${mins} min</b> (${fmtTime(l.endDate, timezone)})</span><br>
          <span>${priceLabel} ${ship} = <b>${fmtMoney(d.eval.totalCost)}</b></span><br>
          <span>Market ${escapeHtml(d.grade.grader)} ${d.grade.grade}: <b>${fmtMoney(d.eval.marketValue)}</b>
            → <b style="color:#0a7d2c;">${d.eval.discountPct.toFixed(0)}% below</b> (save ${fmtMoney(d.eval.savings)})</span><br>
          <span style="color:#555;font-size:12px;">Matched: ${d.priced.matchedUrl ? `<a href="${escapeHtml(d.priced.matchedUrl)}">${escapeHtml(d.priced.matchedName)}</a>` : escapeHtml(d.priced.matchedName ?? '')}
            · confidence ${(d.priced.confidence * 100).toFixed(0)}% · ${escapeHtml(d.priced.source)}</span><br>
          <span style="color:#777;font-size:12px;">Seller ${escapeHtml(l.seller ?? '?')} (${l.sellerFeedbackScore ?? '?'}, ${l.sellerFeedbackPct ?? '?'}%) · ships from ${escapeHtml(l.itemLocationCountry ?? '?')}</span>
        </td>
      </tr>`;
    })
    .join('\n');

  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#222;">
  <h2 style="margin:0 0 12px;">${deals.length} card deal${deals.length === 1 ? '' : 's'} ending soon</h2>
  <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;max-width:720px;">${rows}</table>
  <p style="color:#888;font-size:12px;margin-top:16px;">Auction prices can rise in the final minutes; "below market" is based on the current bid at scan time.</p>
  </body></html>`;
}

export function renderText(deals, { timezone }) {
  return deals
    .map((d) => {
      const l = d.listing;
      return [
        `${l.title}`,
        `  ${d.category.label} · ${d.grade.grader} ${d.grade.grade} · ends in ${minutesUntil(l.endDate)} min (${fmtTime(l.endDate, timezone)})`,
        `  ${l.isAuction ? `bid ${fmtMoney(l.currentPrice)} (${l.bidCount} bids)` : `BIN ${fmtMoney(l.currentPrice)}`} → total ${fmtMoney(d.eval.totalCost)} vs market ${fmtMoney(d.eval.marketValue)} (${d.eval.discountPct.toFixed(0)}% below)`,
        `  match: ${d.priced.matchedName} [${(d.priced.confidence * 100).toFixed(0)}%]`,
        `  ${l.url}`,
      ].join('\n');
    })
    .join('\n\n');
}
