/**
 * Attach the two answers that need the registry: did this package change hands, and how much
 * bigger did the install get.
 *
 * Honesty rules, both of which exist because the alternative is a number that reads as
 * authoritative and is not:
 *
 *   - A maintainer comparison needs a successful lookup on BOTH sides. One missing side is
 *     UNKNOWN. It is never reported as "no maintainer change", because "we could not check"
 *     and "we checked and it is fine" are different facts and the reviewer is entitled to
 *     the difference.
 *   - The size total is the sum of `dist.unpackedSize`, which is the size of the unpacked
 *     tarball as the registry measured it at publish time. It is not the size of node_modules
 *     on disk: no dedup, no peer resolution, no platform-specific optional packages, no
 *     install-script output. Any version with no `unpackedSize` field makes the total a lower
 *     bound, and the count of those versions is reported alongside it rather than treated as
 *     zero bytes.
 */
import { isSemver } from './semver.js';

/** Versions that will never resolve on the public registry. */
export function isRegistryVersion(version) {
  return typeof version === 'string' && isSemver(version);
}

function pairsFor(changes) {
  const pairs = new Map();
  const want = (name, version) => {
    if (!isRegistryVersion(version)) return;
    pairs.set(`${name}@${version}`, { name, version });
  };
  for (const change of changes) {
    if (change.type === 'bumped') { want(change.name, change.from); want(change.name, change.to); }
    else if (change.type === 'added') want(change.name, change.version);
    else if (change.type === 'removed') want(change.name, change.version);
  }
  return [...pairs.values()];
}

function compareMaintainers(before, after) {
  if (before.status !== 'ok' || after.status !== 'ok') {
    const reason = before.status !== 'ok' ? `base: ${before.reason}` : `head: ${after.reason}`;
    return { status: 'unknown', reason, added: [], removed: [], publisherBefore: null, publisherAfter: null };
  }
  const a = before.manifest.maintainers;
  const b = after.manifest.maintainers;
  const publisherBefore = before.manifest.publisher;
  const publisherAfter = after.manifest.publisher;
  if (a === null || b === null) {
    // The registry omits `maintainers` on some very old manifests. Publisher alone is still
    // a usable signal, so fall back to it rather than reporting nothing.
    if (publisherBefore && publisherAfter) {
      return {
        status: publisherBefore === publisherAfter ? 'same' : 'changed',
        reason: 'no maintainers list on one side; compared the publishing user instead',
        added: publisherBefore === publisherAfter ? [] : [publisherAfter],
        removed: publisherBefore === publisherAfter ? [] : [publisherBefore],
        publisherBefore,
        publisherAfter,
      };
    }
    return {
      status: 'unknown',
      reason: 'the registry manifest has no maintainers list and no publishing user',
      added: [], removed: [], publisherBefore, publisherAfter,
    };
  }
  const added = b.filter((m) => !a.includes(m));
  const removed = a.filter((m) => !b.includes(m));
  const publisherChanged = Boolean(publisherBefore && publisherAfter && publisherBefore !== publisherAfter);
  const status = added.length || removed.length ? 'changed' : publisherChanged ? 'publisher-changed' : 'same';
  return { status, reason: null, added, removed, publisherBefore, publisherAfter };
}

function sizeOf(result) {
  if (result?.status !== 'ok') return { bytes: null, why: result?.reason ?? 'not looked up' };
  const bytes = result.manifest.unpackedSize;
  if (bytes === null) return { bytes: null, why: 'the registry manifest has no dist.unpackedSize' };
  return { bytes, why: null };
}

/**
 * Mutates `report.changes`, adding `maintainer` and `size` to each, and adds `report.size`.
 * @param {object} report from diffLockfiles
 * @param {import('./registry.js').Registry} registry
 */
export async function enrich(report, registry) {
  const lookups = await registry.manifests(pairsFor(report.changes));
  const get = (name, version) => {
    if (!isRegistryVersion(version)) {
      return { status: 'unknown', reason: 'not a registry version (local, linked or git dependency)' };
    }
    return lookups.get(`${name}@${version}`) ?? { status: 'unknown', reason: 'not looked up' };
  };

  let bytesAdded = 0;
  let bytesRemoved = 0;
  let unknownSizes = 0;
  // Platform-specific prebuilt binaries are counted separately. A lockfile lists one per
  // platform and installs at most one, so folding all sixteen into one total produces a number
  // no machine will ever see. Real example from this repo's docs page: a +55 MB delta of which
  // +53 MB is sixteen builds of the same bundler binary.
  let platformBytes = 0;
  let platformPackages = 0;

  for (const change of report.changes) {
    if (change.type === 'bumped') {
      const before = get(change.name, change.from);
      const after = get(change.name, change.to);
      change.maintainer = compareMaintainers(before, after);
      const sBefore = sizeOf(before);
      const sAfter = sizeOf(after);
      if (sBefore.bytes === null || sAfter.bytes === null) {
        unknownSizes += 1;
        change.size = { delta: null, from: sBefore.bytes, to: sAfter.bytes, why: sBefore.why ?? sAfter.why };
      } else {
        bytesAdded += sAfter.bytes;
        bytesRemoved += sBefore.bytes;
        change.size = { delta: sAfter.bytes - sBefore.bytes, from: sBefore.bytes, to: sAfter.bytes, why: null };
        if (change.platformSpecific) { platformBytes += change.size.delta; platformPackages += 1; }
      }
    } else if (change.type === 'added') {
      const after = get(change.name, change.version);
      change.maintainer = after.status === 'ok'
        ? { status: 'new', reason: null, added: after.manifest.maintainers ?? [], removed: [], publisherBefore: null, publisherAfter: after.manifest.publisher }
        : { status: 'unknown', reason: after.reason, added: [], removed: [], publisherBefore: null, publisherAfter: null };
      const s = sizeOf(after);
      if (s.bytes === null) { unknownSizes += 1; change.size = { delta: null, from: null, to: null, why: s.why }; }
      else {
        bytesAdded += s.bytes;
        change.size = { delta: s.bytes, from: null, to: s.bytes, why: null };
        if (change.platformSpecific) { platformBytes += s.bytes; platformPackages += 1; }
      }
      change.deprecated = after.status === 'ok' ? after.manifest.deprecated : null;
    } else if (change.type === 'removed') {
      const before = get(change.name, change.version);
      change.maintainer = { status: 'n/a', reason: 'package removed', added: [], removed: [], publisherBefore: null, publisherAfter: null };
      const s = sizeOf(before);
      if (s.bytes === null) { unknownSizes += 1; change.size = { delta: null, from: null, to: null, why: s.why }; }
      else {
        bytesRemoved += s.bytes;
        change.size = { delta: -s.bytes, from: s.bytes, to: null, why: null };
        if (change.platformSpecific) { platformBytes -= s.bytes; platformPackages += 1; }
      }
    } else {
      change.maintainer = { status: 'n/a', reason: 'version unchanged', added: [], removed: [], publisherBefore: null, publisherAfter: null };
      change.size = { delta: 0, from: null, to: null, why: null };
    }
  }

  report.size = {
    bytesAdded,
    bytesRemoved,
    net: bytesAdded - bytesRemoved,
    unknownVersions: unknownSizes,
    lowerBound: unknownSizes > 0,
    platformBytes,
    platformPackages,
    netExcludingPlatform: bytesAdded - bytesRemoved - platformBytes,
    basis: 'sum of dist.unpackedSize from the npm registry, which is unpacked tarball size and '
      + 'not node_modules on disk',
  };
  report.registry = {
    cacheHits: registry.stats.hits,
    fetched: registry.stats.fetched,
    unknown: registry.stats.unknown,
    offline: registry.offline,
  };
  report.counts.maintainerChanged = report.changes.filter(
    (c) => c.maintainer && (c.maintainer.status === 'changed' || c.maintainer.status === 'publisher-changed'),
  ).length;
  report.counts.maintainerUnknown = report.changes.filter(
    (c) => c.maintainer && c.maintainer.status === 'unknown',
  ).length;
  return report;
}

/** Attach the same fields without any lookups at all, for `--no-registry`. */
export function enrichOffline(report) {
  for (const change of report.changes) {
    change.maintainer = { status: 'unknown', reason: 'registry lookups disabled (--no-registry)', added: [], removed: [], publisherBefore: null, publisherAfter: null };
    change.size = { delta: null, from: null, to: null, why: 'registry lookups disabled (--no-registry)' };
  }
  report.size = {
    bytesAdded: 0, bytesRemoved: 0, net: 0,
    platformBytes: 0, platformPackages: 0, netExcludingPlatform: 0,
    unknownVersions: report.changes.length,
    lowerBound: true,
    basis: 'registry lookups disabled, so no size information was gathered',
  };
  report.registry = { cacheHits: 0, fetched: 0, unknown: 0, offline: true, disabled: true };
  report.counts.maintainerChanged = 0;
  report.counts.maintainerUnknown = report.changes.length;
  return report;
}
