import { fmtMoney, minutesUntil, fmtTime } from './format.js';

/** Optional Discord webhook notifier — handy for instant phone pushes. */
export class DiscordNotifier {
  constructor(env) {
    this.url = env.DISCORD_WEBHOOK_URL;
    this.enabled = Boolean(this.url);
  }

  get name() {
    return 'discord';
  }

  async send(deals, { timezone }) {
    if (!this.enabled || !deals.length) return;
    // Discord allows 10 embeds per message.
    for (let i = 0; i < deals.length; i += 10) {
      const chunk = deals.slice(i, i + 10);
      const body = {
        content: `**${deals.length} card deal${deals.length === 1 ? '' : 's'} ending soon**`,
        embeds: chunk.map((d) => {
          const l = d.listing;
          return {
            title: l.title.slice(0, 250),
            url: l.url,
            color: 0x0a7d2c,
            thumbnail: l.imageUrl ? { url: l.imageUrl } : undefined,
            fields: [
              { name: 'Ends', value: `in ${minutesUntil(l.endDate)} min (${fmtTime(l.endDate, timezone)})`, inline: true },
              { name: l.isAuction ? `Bid (${l.bidCount})` : 'BIN', value: `${fmtMoney(l.currentPrice)} → ${fmtMoney(d.eval.totalCost)} w/ ship`, inline: true },
              { name: `Market ${d.grade.grader} ${d.grade.grade}`, value: `${fmtMoney(d.eval.marketValue)} (**${d.eval.discountPct.toFixed(0)}% below**)`, inline: true },
              { name: 'Match', value: `${d.priced.matchedUrl ? `[${d.priced.matchedName}](${d.priced.matchedUrl})` : d.priced.matchedName} · ${(d.priced.confidence * 100).toFixed(0)}%`.slice(0, 1000) },
            ],
          };
        }),
      };
      const res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}: ${await res.text()}`);
    }
  }
}
