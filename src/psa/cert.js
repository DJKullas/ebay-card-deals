/**
 * Optional: verify a PSA cert number via PSA's free public API.
 *   GET https://api.psacard.com/publicapi/cert/GetByCertNumber/{cert}
 *   Authorization: bearer <token>   (token from https://www.psacard.com/publicapi)
 *
 * Returns the card PSA graded (Subject, Brand, Variety, CardNumber, YearIssued,
 * CardGrade) which is the most authoritative identity we can get. Free tier is
 * ~100 calls/day so it is only used when a cert number is visible.
 */
import { fetchJson } from '../util/http.js';

export class PsaCertClient {
  constructor({ token, cache = null, maxLookupsPerRun = 50 }) {
    this.token = token;
    this.cache = cache;
    this.maxLookups = maxLookupsPerRun;
    this.lookups = 0;
  }

  get enabled() {
    return Boolean(this.token);
  }

  /** @returns {Promise<null | { cert:string, grade:number, subject:string, brand:string, variety:string, cardNumber:string, year:number|null, category:string }>} */
  async lookup(cert) {
    if (!this.enabled || !cert) return null;
    const key = `psa:cert:${cert}`;
    const cached = this.cache?.get(key);
    if (cached !== undefined) return cached;
    if (this.lookups >= this.maxLookups) return null;
    this.lookups += 1;

    let data;
    try {
      data = await fetchJson(`https://api.psacard.com/publicapi/cert/GetByCertNumber/${encodeURIComponent(cert)}`, {
        headers: { authorization: `bearer ${this.token}` },
        retries: 0,
      });
    } catch (err) {
      console.warn(`PSA cert lookup failed for ${cert}: ${err.message}`);
      return null;
    }
    const c = data?.PSACert;
    const result = c
      ? {
          cert: String(c.CertNumber),
          grade: Number.parseFloat(c.CardGrade),
          subject: c.Subject ?? '',
          brand: c.Brand ?? '',
          variety: c.Variety ?? '',
          cardNumber: c.CardNumber ?? '',
          year: c.YearIssued ? Number(c.YearIssued) : null,
          category: c.Category ?? '',
        }
      : null;
    this.cache?.set(key, result, 30 * 24 * 3600 * 1000);
    return result;
  }
}
