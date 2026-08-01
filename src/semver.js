/**
 * Just enough semver to classify a version change, with an explicit "I cannot tell" result.
 *
 * The requirement that drove the shape of this module: a version string that is not semver
 * (`file:../x`, `link:../x`, `workspace:*`, a git URL, a tarball URL) must never be silently
 * classified as a patch. Every classify() result carries a `kind`, and the kinds that mean
 * "not comparable" are distinct values rather than a fallback to the smallest bump.
 */

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/** @returns {{major:number,minor:number,patch:number,pre:string[]|null,build:string|null}|null} */
export function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const m = SEMVER_RE.exec(version.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] === undefined ? null : m[4].split('.'),
    build: m[5] === undefined ? null : m[5],
  };
}

export function isSemver(version) {
  return parseSemver(version) !== null;
}

function comparePrerelease(a, b) {
  // No prerelease outranks a prerelease (1.0.0 > 1.0.0-rc.1).
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Standard semver ordering. Build metadata is ignored, as the spec requires. */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) throw new TypeError('compareSemver needs two semver strings');
  for (const field of ['major', 'minor', 'patch']) {
    if (pa[field] !== pb[field]) return pa[field] < pb[field] ? -1 : 1;
  }
  return comparePrerelease(pa.pre, pb.pre);
}

/**
 * Describe why a non-semver version string is not comparable, in the reviewer's language.
 * Returning a reason rather than null keeps "could not classify" distinguishable from
 * "classified as no change", which is the silent-failure trap this whole tool exists to fight.
 */
export function describeNonSemver(version) {
  if (version === null || version === undefined || version === '') return 'missing';
  const v = String(version);
  if (v.startsWith('file:')) return 'a file: dependency';
  if (v.startsWith('link:')) return 'a link: dependency';
  if (v.startsWith('workspace:')) return 'a workspace: dependency';
  if (/^(git\+|git:)/.test(v) || /^[^\s]+\.git(#|$)/.test(v)) return 'a git dependency';
  if (/^(https?|ssh):\/\//.test(v)) return 'a URL dependency';
  if (/^npm:/.test(v)) return 'an npm: alias';
  return 'not a semver version';
}

/**
 * Classify a version change.
 *
 * kind is one of:
 *   'none'            identical strings
 *   'major' 'minor' 'patch'   a semver change in that component
 *   'prerelease'      same major.minor.patch, prerelease identifiers differ
 *   'build'           same version, only build metadata differs
 *   'unclassifiable'  one or both sides are not semver; `reason` says why
 *
 * `direction` is 'up', 'down' or null. `zeroMajor` marks 0.x changes, where a minor bump is
 * a breaking change by npm's caret rules and reviewers should treat it like a major.
 */
export function classifyChange(from, to) {
  if (from === to) return { kind: 'none', direction: null, reason: null, zeroMajor: false };
  const a = parseSemver(from);
  const b = parseSemver(to);
  if (a === null || b === null) {
    const reason = a === null && b === null
      ? `base is ${describeNonSemver(from)}, head is ${describeNonSemver(to)}`
      : a === null
        ? `base is ${describeNonSemver(from)}`
        : `head is ${describeNonSemver(to)}`;
    return { kind: 'unclassifiable', direction: null, reason, zeroMajor: false };
  }
  const cmp = compareSemver(from, to);
  const direction = cmp === 0 ? null : cmp < 0 ? 'up' : 'down';
  const zeroMajor = a.major === 0 || b.major === 0;
  let kind;
  if (a.major !== b.major) kind = 'major';
  else if (a.minor !== b.minor) kind = 'minor';
  else if (a.patch !== b.patch) kind = 'patch';
  else if (comparePrerelease(a.pre, b.pre) !== 0) kind = 'prerelease';
  else kind = 'build';
  return { kind, direction, reason: null, zeroMajor };
}

/** Sort helper that puts non-semver strings last but keeps a total order. */
export function versionSortKey(v) {
  const p = parseSemver(v);
  if (p === null) return [1, String(v)];
  return [0, `${String(p.major).padStart(9, '0')}.${String(p.minor).padStart(9, '0')}.${String(p.patch).padStart(9, '0')}.${p.pre ? p.pre.join('.') : '~'}`];
}
