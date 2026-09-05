import nodemailer from 'nodemailer';
import { renderEmailHtml, renderText } from './format.js';

export class EmailNotifier {
  constructor(env) {
    this.enabled = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.EMAIL_TO);
    if (!this.enabled) return;
    this.from = env.EMAIL_FROM || env.SMTP_USER;
    this.to = env.EMAIL_TO;
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 465),
      secure: String(env.SMTP_SECURE ?? 'true') !== 'false',
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
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
