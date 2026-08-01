/**
 * package-lock.json reader, for lockfileVersion 1, 2 and 3.
 *
 * How the three versions differ, and what this reader does about it:
 *
 *   v1  Only a nested `dependencies` tree. Nesting encodes the install layout, so depth in
 *       the tree is the only signal for direct versus transitive, and the root manifest's
 *       dependency names are not in the lockfile at all.
 *   v2  Carries BOTH the flat `packages` map (keyed by install path) and the legacy nested
 *       `dependencies` tree, for tooling that had not caught up. The two describe the same
 *       install. This reader treats `packages` as authoritative and cross-checks the legacy
 *       tree, reporting a warning if they disagree, because a hand-edited lockfile that
 *       disagrees with itself is worth telling a reviewer about.
 *   v3  `packages` only. Same shape as v2's `packages`.
 *
 * `packages[""]` is the root manifest, which is what makes direct-versus-transitive
 * answerable at all: the names in its dependencies/devDependencies/optionalDependencies are
 * the direct ones, and everything else in the tree is transitive.
 */
import { LockfileError } from './errors.js';

const MANIFEST_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const GIT_RE = /^(git\+|git:)|^[^\s]+\.git(#|$)/;

/** Package name from an install path like `node_modules/a/node_modules/@scope/b`. */
export function nameFromPath(installPath) {
  const at = installPath.lastIndexOf('node_modules/');
  if (at === -1) return null;
  return installPath.slice(at + 'node_modules/'.length);
}

/** How deep in node_modules an entry sits. 1 = top level. */
export function depthOfPath(installPath) {
  return installPath.split('node_modules/').length - 1;
}

/**
 * The version string this tool compares on. Not always `entry.version`: a symlink or a git
 * dependency gets an identity that changes when the thing it points at changes, so a git sha
 * bump is visible instead of looking like "no change".
 */
function unitVersion(entry) {
  if (entry && entry.link === true) {
    return `link:${entry.resolved ?? '?'}`;
  }
  const resolved = typeof entry?.resolved === 'string' ? entry.resolved : null;
  if (resolved && GIT_RE.test(resolved)) return `git:${resolved}`;
  // A local tarball is identified by its path, not by the version inside it, because the file
  // can be swapped for different bytes while the version field stays put. Classifying that as
  // "no change" or as a patch would be a lie.
  if (resolved && resolved.startsWith('file:')) return resolved;
  if (typeof entry?.version === 'string' && entry.version !== '') return entry.version;
  if (resolved) return resolved;
  return null;
}

function directNamesOf(manifest) {
  const names = new Set();
  for (const field of MANIFEST_FIELDS) {
    const block = manifest?.[field];
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      for (const name of Object.keys(block)) names.add(name);
    }
  }
  return names;
}

/** Walk the legacy v1/v2 nested `dependencies` tree. Returns entries keyed by synthetic path. */
function walkLegacyTree(tree, prefix, out, dev) {
  if (!tree || typeof tree !== 'object') return;
  for (const [name, node] of Object.entries(tree)) {
    if (!node || typeof node !== 'object') continue;
    const path = `${prefix}node_modules/${name}`;
    out.push({
      path,
      name,
      version: unitVersion(node),
      resolved: typeof node.resolved === 'string' ? node.resolved : null,
      dev: Boolean(node.dev ?? dev),
      optional: Boolean(node.optional),
      hasInstallScript: Boolean(node.hasInstallScript),
    });
    walkLegacyTree(node.dependencies, `${path}/`, out, Boolean(node.dev ?? dev));
  }
}

/**
 * @param {string} text raw file contents
 * @param {string} file label used in error messages
 * @returns {import('./model.js').Lockfile}
 */
export function parseNpmLock(text, file = 'package-lock.json') {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new LockfileError(`not valid JSON: ${err.message}`, { file });
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new LockfileError('top level is not a JSON object', { file });
  }
  const version = doc.lockfileVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new LockfileError('missing or non-integer lockfileVersion', { file });
  }
  if (version < 1 || version > 3) {
    throw new LockfileError(
      `lockfileVersion ${version} is newer than this tool understands (supported: 1, 2, 3)`,
      { file },
    );
  }

  const warnings = [];
  const hasPackages = doc.packages && typeof doc.packages === 'object' && !Array.isArray(doc.packages);
  const hasLegacy = doc.dependencies && typeof doc.dependencies === 'object' && !Array.isArray(doc.dependencies);
  if (!hasPackages && !hasLegacy) {
    throw new LockfileError(
      `lockfileVersion ${version} has neither a "packages" map nor a "dependencies" tree, `
      + 'so it is empty or truncated',
      { file },
    );
  }
  if (version >= 2 && !hasPackages) {
    throw new LockfileError(`lockfileVersion ${version} has no "packages" map`, { file });
  }

  const importers = [];
  const installed = [];

  if (hasPackages) {
    for (const [key, entry] of Object.entries(doc.packages)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new LockfileError(`packages["${key}"] is not an object`, { file });
      }
      if (!key.includes('node_modules/')) {
        // "" is the root project. Anything else without node_modules/ is a workspace package.
        importers.push({ dir: key, directNames: directNamesOf(entry) });
        continue;
      }
      const name = nameFromPath(key);
      if (!name) throw new LockfileError(`cannot read a package name out of "${key}"`, { file });
      installed.push({
        path: key,
        name,
        version: unitVersion(entry),
        resolved: typeof entry.resolved === 'string' ? entry.resolved : null,
        dev: Boolean(entry.dev || entry.devOptional),
        optional: Boolean(entry.optional),
        hasInstallScript: Boolean(entry.hasInstallScript),
      });
    }
    if (importers.length === 0) {
      throw new LockfileError('no root entry (packages[""]), so the file is not a complete lockfile', { file });
    }
  } else {
    // v1: no manifest in the file at all, so directness comes from tree depth alone.
    walkLegacyTree(doc.dependencies, '', installed, false);
    importers.push({ dir: '', directNames: null });
    warnings.push(
      'lockfileVersion 1 has no manifest, so "direct" means "at the top of node_modules" '
      + 'rather than "named in package.json"',
    );
  }

  if (version === 2 && hasLegacy) {
    const legacy = [];
    walkLegacyTree(doc.dependencies, '', legacy, false);
    const fromPackages = new Set(installed.filter((e) => e.version).map((e) => `${e.name}@${e.version}`));
    const fromLegacy = new Set(legacy.filter((e) => e.version).map((e) => `${e.name}@${e.version}`));
    const onlyLegacy = [...fromLegacy].filter((k) => !fromPackages.has(k));
    const onlyPackages = [...fromPackages].filter((k) => !fromLegacy.has(k));
    if (onlyLegacy.length || onlyPackages.length) {
      warnings.push(
        `lockfileVersion 2 disagrees with itself: ${onlyPackages.length} package(s) only in `
        + `"packages", ${onlyLegacy.length} only in the legacy "dependencies" tree `
        + `(e.g. ${[...onlyPackages, ...onlyLegacy].slice(0, 3).join(', ')})`,
      );
    }
  }

  if (installed.length === 0) {
    throw new LockfileError('lockfile lists no installed packages', { file });
  }

  return buildLockfile({
    format: 'package-lock.json',
    lockfileVersion: String(version),
    importers,
    installed,
    warnings,
    file,
  });
}

/**
 * Attach directness and collapse install paths into name@version units.
 *
 * Directness rule, stated so it can be argued with:
 *   For importer directory D and each name N that D's manifest depends on, the entry that
 *   satisfies it is the one at `D/node_modules/N` if present, otherwise the hoisted one at
 *   `node_modules/N`. That entry, and only that entry, is direct. Another copy of N nested
 *   under some other package is transitive even though it shares a name, which is exactly the
 *   case reviewers get burned by.
 *   If neither path exists (npm can push a direct dependency deeper when versions conflict),
 *   the shallowest entry with that name is used and a warning is recorded, because silently
 *   reporting a direct dependency as transitive would be worse.
 */
export function buildLockfile({ format, lockfileVersion, importers, installed, warnings, file }) {
  const byPath = new Map(installed.map((e) => [e.path, e]));
  const direct = new Set();

  for (const importer of importers) {
    if (importer.directNames === null) {
      // v1 fallback: top-level entries are the closest thing to direct that the file records.
      for (const entry of installed) {
        if (depthOfPath(entry.path) === 1) direct.add(entry.path);
      }
      continue;
    }
    for (const name of importer.directNames) {
      const local = importer.dir === '' ? null : `${importer.dir}/node_modules/${name}`;
      const hoisted = `node_modules/${name}`;
      if (local && byPath.has(local)) { direct.add(local); continue; }
      if (byPath.has(hoisted)) { direct.add(hoisted); continue; }
      const candidates = installed
        .filter((e) => e.name === name)
        .sort((a, b) => depthOfPath(a.path) - depthOfPath(b.path));
      if (candidates.length > 0) {
        direct.add(candidates[0].path);
        warnings.push(
          `direct dependency "${name}" of ${importer.dir || 'the root project'} is not at the `
          + `top of node_modules; treating ${candidates[0].path} as the direct copy`,
        );
      }
      // A manifest name with no entry at all is a peerDependency that was not installed.
      // That is normal and not worth a warning.
    }
  }

  const units = new Map();
  for (const entry of installed) {
    const version = entry.version;
    const key = `${entry.name}@${version ?? '<no version>'}`;
    let unit = units.get(key);
    if (!unit) {
      unit = {
        key,
        name: entry.name,
        version,
        paths: [],
        direct: false,
        dev: true,
        optional: true,
        hasInstallScript: false,
        resolved: entry.resolved,
      };
      units.set(key, unit);
    }
    unit.paths.push(entry.path);
    if (direct.has(entry.path)) unit.direct = true;
    // dev/optional are per-instance; a package that is a production dependency anywhere is
    // a production dependency, so these fold with AND.
    unit.dev = unit.dev && entry.dev;
    unit.optional = unit.optional && entry.optional;
    unit.hasInstallScript = unit.hasInstallScript || entry.hasInstallScript;
    if (!unit.resolved && entry.resolved) unit.resolved = entry.resolved;
  }
  for (const unit of units.values()) unit.paths.sort();

  return {
    format,
    lockfileVersion,
    file,
    importers: importers.map((i) => ({ dir: i.dir, directNames: i.directNames ? [...i.directNames].sort() : null })),
    units,
    warnings,
  };
}
