import nodemailer from 'nodemailer';
import { renderEmailHtml, renderText } from './format.js';

export class EmailNotifier {
  constructor(env) {
    // Gmail app passwords are shown as "xxxx xxxx xxxx xxxx"; the spaces are cosmetic.
    const pass = (env.SMTP_PASS || env.SMTP_PASSWORD || '').replace(/\s+/g, '');
    const to = env.EMAIL_TO || env.SMTP_USER;
    this.enabled = Boolean(env.SMTP_HOST && env.SMTP_USER && pass && to);
    if (!this.enabled) return;
    this.from = env.EMAIL_FROM || env.SMTP_FROM || env.SMTP_USER;
    this.to = to;
    const port = Number(env.SMTP_PORT || 587);
    // 465 = implicit TLS, 587 = STARTTLS. SMTP_SECURE overrides if set.
    const secure = env.SMTP_SECURE ? String(env.SMTP_SECURE) !== 'false' : port === 465;
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port,
      secure,
      auth: { user: env.SMTP_USER, pass },
    });
  }

  get name() {
    return 'email';
  }

  async send(deals, { subjectPrefix, timezone }) {
    if (!this.enabled || !deals.length) return;
    const top = deals[0];
    const subject =
      deals.length === 1
        ? `${subjectPrefix} ${top.eval.discountPct.toFixed(0)}% below: ${top.listing.title.slice(0, 70)}`
        : `${subjectPrefix} ${deals.length} deals ending soon (best ${top.eval.discountPct.toFixed(0)}% below)`;
    await this.transport.sendMail({
      from: this.from,
      to: this.to,
      subject,
      text: renderText(deals, { timezone }),
      html: renderEmailHtml(deals, { timezone }),
    });
  }
}
