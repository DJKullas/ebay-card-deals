/** Small fetch helpers: JSON with timeout + retry, and a per-host rate limiter. */

export async function fetchJson(url, { headers = {}, timeoutMs = 25_000, retries = 2, retryOn = [429, 500, 502, 503, 504], onResponse = null } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (attempt > retries) throw new Error(`fetch failed for ${url}: ${err.message}`);
      await sleep(500 * attempt);
      continue;
    }
    onResponse?.(res);
    if (res.ok) {
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`non-JSON response from ${url}: ${text.slice(0, 200)}`);
      }
    }
    const body = await res.text().catch(() => '');
    if (retryOn.includes(res.status) && attempt <= retries) {
      await sleep(1000 * attempt);
      continue;
    }
    const err = new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Spaces call *starts* at least `minIntervalMs` apart (a "1 request/second"
 * limit is about starts). Calls may overlap in flight, so response latency
 * doesn't add to the gap — callers that want throughput run a few in parallel.
 */
export class RateLimiter {
  constructor(minIntervalMs) {
    this.minIntervalMs = minIntervalMs;
    this.last = 0;
    this.queue = Promise.resolve();
  }

  schedule(fn) {
    const started = this.queue.then(async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
    });
    this.queue = started.catch(() => {});
    return started.then(fn);
  }
}
