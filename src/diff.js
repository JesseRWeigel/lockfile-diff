/**
 * Turn two parsed lockfiles into the five answers a reviewer actually wants.
 *
 * The unit of comparison is name@version, not the install path, because install paths churn
 * every time npm rehoists and a path-keyed diff drowns the real changes. Directness is
 * carried on the unit, so a package that is a direct dependency at 1.0.0 and also sits deep
 * in the tree at 2.0.0 produces two rows with different scopes rather than one confused row.
 */
import { classifyChange, parseSemver, versionSortKey } from './semver.js';

/**
 * Decide which removed version became which added version, for a package that exists at more
 * than one version at once. This is what makes the direct/transitive distinction survive:
 * when semver@7.6.0 (direct) and semver@6.3.0 (transitive, under eslint) both move, pairing
 * them naively would produce two adds and two removes with no scope attached to either.
 *
 * Pass 1 pairs versions that share a major, which is the real-world case of several major
 * lines of one package coexisting and each getting a routine bump.
 * Pass 2 pairs a single leftover on each side, which is the plain major bump case.
 * Anything still unpaired is a genuine add or remove.
 */
export function pairVersions(lost, gained) {
  const pairs = [];
  const lostLeft = [...lost];
  const gainedLeft = [...gained];
  const majorOf = (v) => parseSemver(v)?.major ?? null;
  for (let gi = gainedLeft.length - 1; gi >= 0; gi -= 1) {
    const g = gainedLeft[gi];
    const gMajor = majorOf(g);
    if (gMajor === null) continue;
    const li = lostLeft.findIndex((l) => majorOf(l) === gMajor);
    if (li === -1) continue;
    pairs.push([lostLeft[li], g]);
    lostLeft.splice(li, 1);
    gainedLeft.splice(gi, 1);
  }
  if (lostLeft.length === 1 && gainedLeft.length === 1) {
    pairs.push([lostLeft[0], gainedLeft[0]]);
    lostLeft.length = 0;
    gainedLeft.length = 0;
  }
  return { pairs, removed: lostLeft, added: gainedLeft };
}

const KIND_ORDER = ['unclassifiable', 'major', 'minor', 'patch', 'prerelease', 'build', 'none'];

function groupByName(units) {
  const byName = new Map();
  for (const unit of units.values()) {
    let list = byName.get(unit.name);
    if (!list) { list = []; byName.set(unit.name, list); }
    list.push(unit);
  }
  for (const list of byName.values()) {
    list.sort((a, b) => {
      const ka = versionSortKey(a.version ?? '');
      const kb = versionSortKey(b.version ?? '');
      return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0);
    });
  }
  return byName;
}

function scopeOf(unit) {
  return unit.direct ? 'direct' : 'transitive';
}

function summarise(lock) {
  let direct = 0;
  for (const unit of lock.units.values()) if (unit.direct) direct += 1;
  return {
    format: lock.format,
    lockfileVersion: lock.lockfileVersion,
    file: lock.file,
    packages: lock.units.size,
    direct,
    transitive: lock.units.size - direct,
    importers: lock.importers.length,
  };
}

/**
 * @param {object} base parsed lockfile
 * @param {object} head parsed lockfile
 * @returns {object} diff report, before registry enrichment
 */
export function diffLockfiles(base, head) {
  const baseByName = groupByName(base.units);
  const headByName = groupByName(head.units);
  const names = [...new Set([...baseByName.keys(), ...headByName.keys()])].sort();

  const changes = [];
  for (const name of names) {
    const before = baseByName.get(name) ?? [];
    const after = headByName.get(name) ?? [];
    const beforeVersions = new Map(before.map((u) => [u.version ?? '<no version>', u]));
    const afterVersions = new Map(after.map((u) => [u.version ?? '<no version>', u]));

    const gained = [...afterVersions.keys()].filter((v) => !beforeVersions.has(v));
    const lost = [...beforeVersions.keys()].filter((v) => !afterVersions.has(v));

    if (before.length === 0) {
      for (const v of gained) {
        const unit = afterVersions.get(v);
        changes.push({
          type: 'added', name, version: v, newPackage: true,
          scope: scopeOf(unit), dev: unit.dev, optional: unit.optional,
          hasInstallScript: unit.hasInstallScript, platformSpecific: unit.platformSpecific,
        });
      }
      continue;
    }
    if (after.length === 0) {
      for (const v of lost) {
        const unit = beforeVersions.get(v);
        changes.push({
          type: 'removed', name, version: v, gonePackage: true,
          scope: scopeOf(unit), dev: unit.dev, optional: unit.optional,
          platformSpecific: unit.platformSpecific,
        });
      }
      continue;
    }

    const paired = pairVersions(lost, gained);
    for (const [from, to] of paired.pairs) {
      const fromUnit = beforeVersions.get(from);
      const toUnit = afterVersions.get(to);
      const cls = classifyChange(fromUnit.version, toUnit.version);
      changes.push({
        type: 'bumped',
        name,
        from,
        to,
        kind: cls.kind,
        direction: cls.direction,
        reason: cls.reason,
        zeroMajor: cls.zeroMajor,
        scope: scopeOf(toUnit),
        scopeBefore: scopeOf(fromUnit),
        dev: toUnit.dev,
        optional: toUnit.optional,
        hasInstallScript: toUnit.hasInstallScript,
        platformSpecific: toUnit.platformSpecific || fromUnit.platformSpecific,
      });
    }
    for (const v of paired.added) {
      const unit = afterVersions.get(v);
      changes.push({
        type: 'added', name, version: v, newPackage: false,
        scope: scopeOf(unit), dev: unit.dev, optional: unit.optional,
        hasInstallScript: unit.hasInstallScript, platformSpecific: unit.platformSpecific,
      });
    }
    for (const v of paired.removed) {
      const unit = beforeVersions.get(v);
      changes.push({
        type: 'removed', name, version: v, gonePackage: false,
        scope: scopeOf(unit), dev: unit.dev, optional: unit.optional,
        platformSpecific: unit.platformSpecific,
      });
    }

    // Versions present on both sides: the version did not move, but something else may have.
    for (const [v, beforeUnit] of beforeVersions) {
      const afterUnit = afterVersions.get(v);
      if (!afterUnit) continue;
      if (beforeUnit.direct !== afterUnit.direct) {
        changes.push({
          type: 'scope-changed', name, version: v,
          scopeBefore: scopeOf(beforeUnit), scope: scopeOf(afterUnit),
          dev: afterUnit.dev, optional: afterUnit.optional,
        });
      }
      if (beforeUnit.resolved && afterUnit.resolved && beforeUnit.resolved !== afterUnit.resolved) {
        changes.push({
          type: 'resolution-changed', name, version: v,
          from: beforeUnit.resolved, to: afterUnit.resolved,
          scope: scopeOf(afterUnit), dev: afterUnit.dev, optional: afterUnit.optional,
        });
      }
    }
  }

  changes.sort((a, b) => {
    const rank = (c) => (c.type === 'bumped' ? KIND_ORDER.indexOf(c.kind) : c.type === 'added' ? 20 : c.type === 'removed' ? 21 : 22);
    return rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });

  const counts = {
    total: changes.length,
    newPackages: changes.filter((c) => c.type === 'added' && c.newPackage).length,
    addedVersions: changes.filter((c) => c.type === 'added' && !c.newPackage).length,
    removedPackages: changes.filter((c) => c.type === 'removed' && c.gonePackage).length,
    removedVersions: changes.filter((c) => c.type === 'removed' && !c.gonePackage).length,
    bumped: changes.filter((c) => c.type === 'bumped').length,
    major: changes.filter((c) => c.type === 'bumped' && c.kind === 'major').length,
    minor: changes.filter((c) => c.type === 'bumped' && c.kind === 'minor').length,
    patch: changes.filter((c) => c.type === 'bumped' && c.kind === 'patch').length,
    prerelease: changes.filter((c) => c.type === 'bumped' && c.kind === 'prerelease').length,
    unclassifiable: changes.filter((c) => c.type === 'bumped' && c.kind === 'unclassifiable').length,
    downgrades: changes.filter((c) => c.direction === 'down').length,
    scopeChanged: changes.filter((c) => c.type === 'scope-changed').length,
    resolutionChanged: changes.filter((c) => c.type === 'resolution-changed').length,
    direct: changes.filter((c) => c.scope === 'direct').length,
    transitive: changes.filter((c) => c.scope === 'transitive').length,
    newInstallScripts: changes.filter((c) => c.hasInstallScript && (c.type === 'added' || c.type === 'bumped')).length,
    platformSpecific: changes.filter((c) => c.platformSpecific).length,
  };

  return {
    base: summarise(base),
    head: summarise(head),
    changes,
    counts,
    warnings: [...base.warnings.map((w) => `base: ${w}`), ...head.warnings.map((w) => `head: ${w}`)],
  };
}
