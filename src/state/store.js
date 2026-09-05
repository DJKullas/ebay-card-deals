/**
 * Tiny JSON-file key/value store with per-entry TTL. Used for:
 *   - remembering which listings we've already alerted on (dedupe)
 *   - caching price guide lookups (they only change daily)
 * In GitHub Actions the `state/` directory is persisted between runs with
 * actions/cache.
 */
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(file, { defaultTtlMs = 24 * 3600 * 1000 } = {}) {
    this.file = file;
    this.defaultTtlMs = defaultTtlMs;
    this.data = {};
    this.dirty = false;
    try {
      if (fs.existsSync(file)) this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = {};
    }
    this.prune();
  }

  get(key) {
    const e = this.data[key];
    if (!e) return undefined;
    if (e.exp && e.exp < Date.now()) {
      delete this.data[key];
      this.dirty = true;
      return undefined;
    }
    return e.v;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    this.data[key] = { v: value, exp: ttlMs ? Date.now() + ttlMs : 0 };
    this.dirty = true;
  }

  prune() {
    const now = Date.now();
    for (const [k, e] of Object.entries(this.data)) {
      if (e?.exp && e.exp < now) {
        delete this.data[k];
        this.dirty = true;
      }
    }
  }

  save() {
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data));
    this.dirty = false;
  }

  get size() {
    return Object.keys(this.data).length;
  }
}
