/**
 * pnpm-lock.yaml reader, for lockfileVersion 6.0 and 9.0.
 *
 * The two differ enough that a single naive reader gets one of them wrong:
 *
 *   v6  Dependency paths are `/name@1.2.3` (and pnpm 5.x wrote `/name/1.2.3`, still accepted
 *       here). The `packages` map holds BOTH the metadata and the dependency graph, and each
 *       entry records `dev: true|false` directly. A single-package project puts its direct
 *       dependencies in top-level `dependencies:` / `devDependencies:` blocks; a workspace
 *       uses `importers:`.
 *   v9  Dependency paths lose the leading slash and become `name@1.2.3`. The graph moves out
 *       of `packages` into a separate `snapshots` map keyed by the full dep path including
 *       peer suffixes such as `react-dom@19.2.4(react@19.2.4)`. There is no `dev` field at
 *       all, so dev-only status has to be derived by walking the graph from the production
 *       roots. Direct dependencies always live under `importers:`, with `.` for the root.
 *
 * Peer suffixes are stripped when forming the identity of a package, so the four peer
 * variants of one version collapse to one row in the diff rather than four.
 */
import { LockfileError } from './errors.js';
import { parseYamlSubset } from './yaml.js';
import { buildLockfile, isPlatformSpecific } from './npm-lock.js';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const PROD_FIELDS = ['dependencies', 'optionalDependencies'];

/** Remove trailing balanced `(...)` peer suffixes from a dep path or version. */
export function stripPeerSuffix(value) {
  let out = String(value);
  while (out.endsWith(')')) {
    let depth = 0;
    let i = out.length - 1;
    for (; i >= 0; i -= 1) {
      if (out[i] === ')') depth += 1;
      else if (out[i] === '(') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (i <= 0) return out;
    out = out.slice(0, i);
  }
  return out;
}

/**
 * Split a dep path into [name, version].
 *
 * A package name may contain `@` only as the leading scope marker, so the version separator
 * is the first `@` after the scope's `/`. Doing it by lastIndexOf breaks on git dep paths
 * like `foo@git+ssh://git@github.com/u/r.git#sha`, where the last `@` is inside the URL.
 */
export function splitDepPath(depPath, file) {
  let key = depPath;
  if (key.startsWith('/')) key = key.slice(1);
  let at;
  if (key.startsWith('@')) {
    const slash = key.indexOf('/');
    if (slash === -1) throw new LockfileError(`scoped dep path with no "/": "${depPath}"`, { file });
    at = key.indexOf('@', slash);
  } else {
    at = key.indexOf('@');
  }
  if (at > 0) return [key.slice(0, at), key.slice(at + 1)];
  // pnpm 5.x style `/name/1.2.3`, kept because such lockfiles are still in the wild.
  const lastSlash = key.lastIndexOf('/');
  if (lastSlash > 0 && /^\d/.test(key.slice(lastSlash + 1))) {
    return [key.slice(0, lastSlash), key.slice(lastSlash + 1)];
  }
  throw new LockfileError(`cannot split a name and version out of "${depPath}"`, { file });
}

/** Read one importer's direct dependency names and their resolved versions. */
function readImporter(block, file, dir) {
  const names = new Set();
  const pinned = [];
  for (const field of DEP_FIELDS) {
    const deps = block?.[field];
    if (deps === null || deps === undefined) continue;
    if (typeof deps !== 'object' || Array.isArray(deps)) {
      throw new LockfileError(`importer "${dir}" has a non-object ${field}`, { file });
    }
    for (const [name, spec] of Object.entries(deps)) {
      names.add(name);
      let version = null;
      if (typeof spec === 'string') version = spec;
      else if (spec && typeof spec === 'object' && typeof spec.version === 'string') version = spec.version;
      if (version !== null) {
        pinned.push({ name, version: stripPeerSuffix(version), prod: PROD_FIELDS.includes(field) });
      }
    }
  }
  return { names, pinned };
}

/** BFS the v9 snapshot graph from the production roots to work out what is dev-only. */
function productionSet(snapshots, roots) {
  const prod = new Set();
  const queue = [...roots];
  while (queue.length) {
    const depPath = queue.pop();
    if (prod.has(depPath)) continue;
    prod.add(depPath);
    const snap = snapshots[depPath];
    if (!snap || typeof snap !== 'object') continue;
    for (const field of PROD_FIELDS) {
      const deps = snap[field];
      if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
      for (const [name, version] of Object.entries(deps)) {
        if (typeof version !== 'string') continue;
        queue.push(`${name}@${version}`);
      }
    }
  }
  return prod;
}

/**
 * @param {string} text raw file contents
 * @param {string} file label used in error messages
 */
export function parsePnpmLock(text, file = 'pnpm-lock.yaml') {
  const doc = parseYamlSubset(text, file);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new LockfileError('top level is not a mapping', { file });
  }
  const rawVersion = doc.lockfileVersion;
  if (rawVersion === undefined || rawVersion === null) {
    throw new LockfileError('missing lockfileVersion', { file });
  }
  const lockfileVersion = String(rawVersion);
  const major = Number.parseInt(lockfileVersion, 10);
  if (!Number.isFinite(major)) {
    throw new LockfileError(`unreadable lockfileVersion "${lockfileVersion}"`, { file });
  }
  if (major < 5 || major > 9) {
    throw new LockfileError(
      `pnpm lockfileVersion ${lockfileVersion} is outside the range this tool understands `
      + '(5.x, 6.0 and 9.0)',
      { file },
    );
  }

  const packages = doc.packages;
  if (packages === null || packages === undefined) {
    throw new LockfileError('no "packages" section, so the file is empty or truncated', { file });
  }
  if (typeof packages !== 'object' || Array.isArray(packages)) {
    throw new LockfileError('"packages" is not a mapping', { file });
  }
  const packageKeys = Object.keys(packages);
  if (packageKeys.length === 0) {
    throw new LockfileError('"packages" is empty, so the lockfile records no installs', { file });
  }

  const warnings = [];
  const snapshots = major >= 9 && doc.snapshots && typeof doc.snapshots === 'object' && !Array.isArray(doc.snapshots)
    ? doc.snapshots
    : null;
  if (major >= 9 && snapshots === null) {
    throw new LockfileError(
      'lockfileVersion 9 has no "snapshots" section, so the dependency graph is missing '
      + '(a truncated file looks exactly like this)',
      { file },
    );
  }

  // Importers. v9 always uses the importers block; v6 uses it only for workspaces.
  const importers = [];
  const pinnedDirect = [];
  if (doc.importers && typeof doc.importers === 'object' && !Array.isArray(doc.importers)) {
    for (const [dir, block] of Object.entries(doc.importers)) {
      const { names, pinned } = readImporter(block, file, dir);
      importers.push({ dir, directNames: names });
      pinnedDirect.push(...pinned);
    }
  } else {
    const { names, pinned } = readImporter(doc, file, '.');
    importers.push({ dir: '.', directNames: names });
    pinnedDirect.push(...pinned);
  }
  if (importers.length === 0) {
    throw new LockfileError('no importers and no top-level dependencies block', { file });
  }

  // Production reachability, v9 only. v6 records `dev:` on each package entry.
  let prodPaths = null;
  if (snapshots) {
    const roots = [];
    for (const [dir, block] of Object.entries(doc.importers)) {
      for (const field of PROD_FIELDS) {
        const deps = block?.[field];
        if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
        for (const [name, spec] of Object.entries(deps)) {
          const version = typeof spec === 'string' ? spec : spec?.version;
          if (typeof version === 'string' && !version.startsWith('link:')) {
            roots.push(`${name}@${version}`);
          }
        }
      }
      void dir;
    }
    prodPaths = productionSet(snapshots, roots);
  }
  // Peer variants share one identity, so a package is production if any variant is reachable.
  const prodStripped = prodPaths ? new Set([...prodPaths].map(stripPeerSuffix)) : null;

  const installed = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new LockfileError(`packages["${key}"] is not a mapping`, { file });
    }
    if (entry.resolution === undefined) {
      throw new LockfileError(
        `packages["${key}"] has no "resolution", so this entry is incomplete or the file is truncated`,
        { file },
      );
    }
    const bare = stripPeerSuffix(key);
    const [name, version] = splitDepPath(bare, file);
    const dev = prodStripped
      ? !prodStripped.has(bare.startsWith('/') ? bare.slice(1) : bare)
      : entry.dev === true;
    installed.push({
      path: `node_modules/.pnpm/${key.replace(/^\//, '')}/node_modules/${name}`,
      depPath: key,
      name,
      version,
      resolved: entry.resolution && typeof entry.resolution === 'object'
        ? (entry.resolution.tarball ?? entry.resolution.integrity ?? entry.resolution.commit ?? null)
        : null,
      dev,
      optional: entry.optional === true,
      hasInstallScript: entry.requiresBuild === true,
      platformSpecific: isPlatformSpecific(entry),
      direct: false,
    });
  }

  // pnpm links (workspace: and link: dependencies) never appear in `packages`, so they are
  // added from the importer blocks. Leaving them out would make a switch from a published
  // package to a local link look like a plain removal.
  const seen = new Set(installed.map((e) => `${e.name}@${e.version}`));
  for (const pin of pinnedDirect) {
    if (pin.version.startsWith('link:') && !seen.has(`${pin.name}@${pin.version}`)) {
      seen.add(`${pin.name}@${pin.version}`);
      installed.push({
        path: `node_modules/${pin.name}`,
        depPath: `${pin.name}@${pin.version}`,
        name: pin.name,
        version: pin.version,
        resolved: pin.version.slice('link:'.length),
        dev: !pin.prod,
        optional: false,
        hasInstallScript: false,
        platformSpecific: false,
        direct: true,
      });
    }
  }

  const lock = buildLockfile({
    format: 'pnpm-lock.yaml',
    lockfileVersion,
    // Directness for pnpm is decided below from the exact pinned versions, so buildLockfile's
    // path heuristic is bypassed by handing it importers with no names.
    importers: importers.map((i) => ({ dir: i.dir, directNames: new Set() })),
    installed,
    warnings,
    file,
  });
  lock.importers = importers.map((i) => ({ dir: i.dir, directNames: [...i.directNames].sort() }));

  // pnpm records the exact resolved version of every direct dependency, which makes the
  // direct-versus-transitive question exact instead of a heuristic: foo@1.0.0 pinned by the
  // importer is direct, and foo@2.0.0 sitting deeper in the graph is not, even though both
  // are called foo.
  let unmatched = 0;
  for (const pin of pinnedDirect) {
    const unit = lock.units.get(`${pin.name}@${pin.version}`);
    if (unit) unit.direct = true;
    else unmatched += 1;
  }
  if (unmatched > 0) {
    warnings.push(`${unmatched} direct dependenc(ies) named by an importer have no entry in "packages"`);
  }

  return lock;
}
