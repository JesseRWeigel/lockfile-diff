/**
 * npm registry lookups for the two questions the lockfile cannot answer: who published this
 * version, and how big is it.
 *
 * Approach borrowed from the sibling project npm-handoff-watch (../npm-handoff-watch), which
 * detects package handoffs from the same fields. Reimplemented here rather than imported,
 * because that project is a separate Python repo and reaching across project boundaries would
 * couple two things that should stay independently runnable. The shared idea is the one worth
 * attributing: a package's `maintainers` list and the `_npmUser` who published a given version
 * are the highest-signal supply-chain fields the public registry exposes, and a change in
 * either between two versions is worth a reviewer's attention even when the diff looks routine.
 *
 * Two rules this module exists to enforce:
 *
 *   1. A lookup that fails is UNKNOWN, never "no change". `catch(() => null)` would collapse
 *      "could not check" and "checked, found nothing" into one value, and no caller could tell
 *      them apart afterwards. Every result carries a status.
 *   2. Everything is cached on disk, so the test suite runs offline against fixtures and a
 *      failing network cannot turn a red check green.
 *
 * The per-version endpoint (`/{name}/{version}`) is used rather than the full packument
 * because it is a few kilobytes instead of a few megabytes and carries exactly the three
 * fields needed.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** Filesystem-safe name for a cache entry. Scoped names contain a slash. */
export function cacheKey(name, version) {
  return `${name.replace(/[^A-Za-z0-9._-]/g, '_')}@${String(version).replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

function humanId(value) {
  if (typeof value === 'string') {
    const at = value.indexOf(' <');
    return (at === -1 ? value : value.slice(0, at)).trim() || null;
  }
  if (value && typeof value === 'object') {
    if (typeof value.name === 'string' && value.name.trim() !== '') return value.name.trim();
    if (typeof value.email === 'string' && value.email.trim() !== '') return value.email.trim();
  }
  return null;
}

/** Reduce a version manifest to the three fields this tool uses. */
export function slimManifest(doc) {
  const maintainers = Array.isArray(doc?.maintainers)
    ? [...new Set(doc.maintainers.map(humanId).filter(Boolean))].sort()
    : null;
  const publisher = humanId(doc?._npmUser);
  const dist = doc?.dist && typeof doc.dist === 'object' ? doc.dist : {};
  return {
    maintainers,
    publisher,
    unpackedSize: Number.isFinite(dist.unpackedSize) ? dist.unpackedSize : null,
    fileCount: Number.isFinite(dist.fileCount) ? dist.fileCount : null,
    deprecated: typeof doc?.deprecated === 'string' ? doc.deprecated : null,
  };
}

export class Registry {
  /**
   * @param {object} options
   * @param {string|null} options.cacheDir directory of cached slim manifests, null disables caching
   * @param {boolean} options.offline never touch the network; a cache miss becomes UNKNOWN
   * @param {string} options.registryUrl
   * @param {number} options.timeoutMs
   * @param {number} options.concurrency
   * @param {Function} options.fetchImpl injected for tests
   */
  constructor({
    cacheDir = null,
    offline = false,
    registryUrl = DEFAULT_REGISTRY,
    timeoutMs = 15000,
    concurrency = 8,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.cacheDir = cacheDir;
    this.offline = offline;
    this.registryUrl = registryUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.concurrency = Math.max(1, concurrency);
    this.fetchImpl = fetchImpl;
    this.memo = new Map();
    this.stats = { hits: 0, fetched: 0, unknown: 0 };
  }

  cachePath(name, version) {
    return this.cacheDir === null ? null : path.join(this.cacheDir, cacheKey(name, version));
  }

  readCache(name, version) {
    const file = this.cachePath(name, version);
    if (file === null || !fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.status) return parsed;
      return null;
    } catch {
      // A corrupt cache entry is a cache miss, not a crash. Never a silent "no change":
      // the caller still gets a real lookup or an explicit unknown.
      return null;
    }
  }

  writeCache(name, version, record) {
    const file = this.cachePath(name, version);
    if (file === null) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  }

  /**
   * @returns {Promise<{status:'ok', manifest:object}|{status:'unknown', reason:string}>}
   */
  async manifest(name, version) {
    const memoKey = `${name}@${version}`;
    if (this.memo.has(memoKey)) return this.memo.get(memoKey);
    const promise = this.#lookup(name, version);
    this.memo.set(memoKey, promise);
    return promise;
  }

  async #lookup(name, version) {
    const cached = this.readCache(name, version);
    if (cached) {
      this.stats.hits += 1;
      if (cached.status === 'unknown') this.stats.unknown += 1;
      return cached;
    }
    if (this.offline) {
      this.stats.unknown += 1;
      return { status: 'unknown', reason: 'offline and not in the cache' };
    }
    let record;
    try {
      const url = `${this.registryUrl}/${name.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(version)}`;
      const response = await this.fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'lockfile-diff' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 404) {
        record = { status: 'unknown', reason: 'the public registry has no manifest for this version' };
      } else if (!response.ok) {
        record = { status: 'unknown', reason: `registry returned HTTP ${response.status}` };
      } else {
        record = { status: 'ok', manifest: slimManifest(await response.json()) };
      }
    } catch (err) {
      record = { status: 'unknown', reason: `registry lookup failed: ${err.message}` };
    }
    if (record.status === 'ok') this.stats.fetched += 1; else this.stats.unknown += 1;
    // Negative results are cached too, so a CI run does not re-ask for a package that will
    // never resolve. They are cheap to delete and expensive to re-fetch a hundred times.
    this.writeCache(name, version, record);
    return record;
  }

  /** Resolve many name@version pairs with a bounded number of in-flight requests. */
  async manifests(pairs) {
    const out = new Map();
    const queue = [...pairs];
    const workers = Array.from({ length: Math.min(this.concurrency, Math.max(1, queue.length)) }, async () => {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        out.set(`${job.name}@${job.version}`, await this.manifest(job.name, job.version));
      }
    });
    await Promise.all(workers);
    return out;
  }
}
