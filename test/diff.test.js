import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diffLockfiles, pairVersions } from '../src/diff.js';
import { parseLockfile } from '../src/parse.js';
import { diffFixtures, fixture, findChange, parseFixture, FIXTURES } from './helpers.js';

/** One change rendered as a comparable tuple, so assertions are exact and not counts. */
function tuple(c) {
  return [
    c.type,
    c.name,
    c.from ?? c.version ?? '-',
    c.to ?? '-',
    c.kind ?? '-',
    c.scope,
  ].join(' | ');
}

function tuples(report) {
  return report.changes.map(tuple).sort();
}

// The complete, hand-checked answer for test/fixtures/npm-v3. Every row was chosen to exercise
// one classification, and the list is exhaustive: an extra change or a missing one fails.
const NPM_V3_EXPECTED = [
  'added | picocolors | 1.0.1 | - | - | transitive',
  'bumped | @polka/url | 1.0.0-next.25 | 1.0.0-next.29 | prerelease | direct',
  'bumped | abbrev | 1.1.1 | 2.0.0 | major | transitive',
  'bumped | gitdep | git:git+ssh://git@github.com/example/gitdep.git#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | git:git+ssh://git@github.com/example/gitdep.git#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb | unclassifiable | direct',
  'bumped | local-ui | link:packages/ui | link:packages/ui-next | unclassifiable | direct',
  'bumped | ms | 2.1.2 | 2.1.3 | patch | transitive',
  'bumped | nover | 1.0.0 | <no version> | unclassifiable | transitive',
  'bumped | rimraf | 2.7.1 | 5.0.5 | major | direct',
  'bumped | semver | 6.3.0 | 6.3.1 | patch | transitive',
  'bumped | semver | 7.5.4 | 7.6.0 | minor | direct',
  'bumped | three | 0.183.2 | 0.184.0 | minor | direct',
  'bumped | uuid | 3.4.0 | 9.0.1 | major | direct',
  'bumped | vendored | file:vendor/vendored-1.0.0.tgz | file:vendor/vendored-1.0.1.tgz | unclassifiable | direct',
  'removed | glob | 7.2.3 | - | - | direct',
  'scope-changed | picomatch | 2.3.1 | - | - | direct',
].sort();

const PNPM_V9_EXPECTED = [
  'added | picocolors | 1.0.1 | - | - | transitive',
  'bumped | @polka/url | 1.0.0-next.25 | 1.0.0-next.29 | prerelease | direct',
  'bumped | abbrev | 1.1.1 | 2.0.0 | major | transitive',
  'bumped | local-ui | link:packages/ui | link:packages/ui-next | unclassifiable | direct',
  'bumped | ms | 2.1.2 | 2.1.3 | patch | transitive',
  'bumped | rimraf | 2.7.1 | 5.0.5 | major | direct',
  'bumped | semver | 6.3.0 | 6.3.1 | patch | transitive',
  'bumped | semver | 7.5.4 | 7.6.0 | minor | direct',
  'bumped | three | 0.183.2 | 0.184.0 | minor | direct',
  'bumped | uuid | 3.4.0 | 9.0.1 | major | direct',
  'removed | glob | 7.2.3 | - | - | direct',
  'scope-changed | picomatch | 2.3.1 | - | - | direct',
].sort();

const PNPM_V6_EXPECTED = [
  'added | picocolors | 1.0.1 | - | - | transitive',
  'bumped | abbrev | 1.1.1 | 2.0.0 | major | transitive',
  'bumped | ms | 2.1.2 | 2.1.3 | patch | transitive',
  'bumped | rimraf | 2.7.1 | 5.0.5 | major | direct',
  'bumped | semver | 6.3.0 | 6.3.1 | patch | transitive',
  'bumped | semver | 7.5.4 | 7.6.0 | minor | direct',
  'removed | glob | 7.2.3 | - | - | transitive',
].sort();

const NPM_V2_EXPECTED = [
  'added | picocolors | 1.0.1 | - | - | transitive',
  'bumped | ms | 2.1.2 | 2.1.3 | patch | direct',
  'bumped | rimraf | 2.7.1 | 5.0.5 | major | direct',
  'removed | glob | 7.2.3 | - | - | transitive',
].sort();

test('package-lock v3: every change classifies exactly as designed', () => {
  const report = diffFixtures('npm-v3/base.json', 'npm-v3/head.json');
  assert.deepEqual(tuples(report), NPM_V3_EXPECTED);
  assert.equal(report.base.lockfileVersion, '3');
});

test('pnpm-lock v9: every change classifies exactly as designed', () => {
  const report = diffFixtures('pnpm-v9/base.yaml', 'pnpm-v9/head.yaml');
  assert.deepEqual(tuples(report), PNPM_V9_EXPECTED);
  assert.equal(report.base.lockfileVersion, '9.0');
});

test('pnpm-lock v6: every change classifies exactly as designed', () => {
  const report = diffFixtures('pnpm-v6/base.yaml', 'pnpm-v6/head.yaml');
  assert.deepEqual(tuples(report), PNPM_V6_EXPECTED);
  assert.equal(report.base.lockfileVersion, '6.0');
});

test('package-lock v2: every change classifies exactly as designed', () => {
  const report = diffFixtures('npm-v2/base.json', 'npm-v2/head.json');
  assert.deepEqual(tuples(report), NPM_V2_EXPECTED);
  assert.equal(report.base.lockfileVersion, '2');
});

test('DIRECT vs TRANSITIVE: one package, two versions, two different scopes', () => {
  // semver is a direct dependency at 7.x and simultaneously buried under eslint at 6.x. Both
  // move. A reader keyed on package name alone reports one change with one scope and is wrong
  // about half of it, which is the failure this whole fixture exists to catch.
  const report = diffFixtures('direct-transitive/base.json', 'direct-transitive/head.json');
  assert.equal(report.changes.length, 2, JSON.stringify(report.changes.map(tuple), null, 2));

  const direct = findChange(report, 'semver', '7.5.4');
  assert.equal(direct.scope, 'direct');
  assert.equal(direct.kind, 'minor');
  assert.equal(direct.to, '7.6.0');

  const transitive = findChange(report, 'semver', '6.3.0');
  assert.equal(transitive.scope, 'transitive');
  assert.equal(transitive.kind, 'patch');
  assert.equal(transitive.to, '6.3.1');

  // And at the parse layer, so a rendering change cannot mask it.
  const base = parseFixture('direct-transitive/base.json');
  assert.equal(base.units.get('semver@7.5.4').direct, true);
  assert.equal(base.units.get('semver@6.3.0').direct, false);
  assert.deepEqual(base.units.get('semver@6.3.0').paths, ['node_modules/eslint/node_modules/semver']);
  // eslint is named in devDependencies, so it is direct even though nothing imports it in src.
  assert.equal(base.units.get('eslint@8.57.0').direct, true);
});

test('the same distinction holds in pnpm, where the importer pins exact versions', () => {
  const base = parseFixture('pnpm-v9/base.yaml');
  assert.equal(base.units.get('semver@7.5.4').direct, true);
  assert.equal(base.units.get('semver@6.3.0').direct, false);
  assert.equal(base.units.get('semver@6.3.0').dev, true, 'only reachable from eslint, a devDependency');
  assert.equal(base.units.get('ms@2.1.2').dev, false, 'reachable from rimraf, a production dependency');

  const report = diffFixtures('pnpm-v9/base.yaml', 'pnpm-v9/head.yaml');
  assert.equal(findChange(report, 'semver', '7.5.4').scope, 'direct');
  assert.equal(findChange(report, 'semver', '6.3.0').scope, 'transitive');
});

test('NEGATIVE CONTROL: every fixture diffed against itself reports zero changes', () => {
  const pairs = [
    'npm-v3/base.json', 'npm-v3/head.json',
    'npm-v2/base.json', 'npm-v2/head.json',
    'pnpm-v9/base.yaml', 'pnpm-v9/head.yaml',
    'pnpm-v6/base.yaml', 'pnpm-v6/head.yaml',
    'direct-transitive/base.json',
    'real/toryo-30d679f-package-lock.json',
    'real/language-learning-app-8ae6855-pnpm-lock.yaml',
  ];
  for (const rel of pairs) {
    const report = diffFixtures(rel, rel);
    assert.equal(report.changes.length, 0, `${rel} diffed against itself reported ${report.changes.length} changes: ${JSON.stringify(report.changes.slice(0, 3))}`);
    assert.equal(report.counts.total, 0);
    assert.ok(report.base.packages > 0, `${rel} parsed to zero packages, so the control is vacuous`);
    assert.equal(report.base.packages, report.head.packages);
  }
});

test('v2 and v3 descriptions of the same install produce zero changes', () => {
  // The two formats really do differ, so this is the check that the v2 reader is not quietly
  // reading something else.
  const report = diffFixtures('npm-v2/base.json', 'npm-v2/as-v3.json');
  assert.equal(report.changes.length, 0, JSON.stringify(report.changes));
  assert.equal(report.base.lockfileVersion, '2');
  assert.equal(report.head.lockfileVersion, '3');
});

test('a v2 lockfile that contradicts itself gets a warning, not a silent pick', () => {
  const report = diffFixtures('npm-v2/disagrees.json', 'npm-v2/base.json');
  assert.equal(report.changes.length, 0);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /disagrees with itself/);
  assert.match(report.warnings[0], /ms@2\.1\.1/);
});

test('real lockfiles from real repositories diff to their real answers', () => {
  const pnpm = diffFixtures(
    'real/language-learning-app-2068c04-pnpm-lock.yaml',
    'real/language-learning-app-8ae6855-pnpm-lock.yaml',
  );
  assert.equal(pnpm.base.packages, 880);
  assert.equal(pnpm.head.packages, 881);
  assert.deepEqual(tuples(pnpm), ['added | @testing-library/user-event | 14.6.1 | - | - | direct']);

  const npm = diffFixtures(
    'real/toryo-790b2b4-package-lock.json',
    'real/toryo-30d679f-package-lock.json',
  );
  // A real workspace rename: three linked workspace packages changed name.
  assert.deepEqual(tuples(npm), [
    'added | @jweigel/toryo | link:packages/cli | - | - | transitive',
    'added | toryo-adapters | link:packages/adapters | - | - | direct',
    'added | toryo-core | link:packages/core | - | - | direct',
    'removed | @toryo/adapters | link:packages/adapters | - | - | direct',
    'removed | @toryo/core | link:packages/core | - | - | direct',
    'removed | toryo | link:packages/cli | - | - | transitive',
  ]);
});

test('reversing a diff reverses every classification', () => {
  const forward = diffFixtures('npm-v3/base.json', 'npm-v3/head.json');
  const back = diffFixtures('npm-v3/head.json', 'npm-v3/base.json');
  assert.equal(forward.counts.total, back.counts.total);
  assert.equal(back.counts.newPackages, forward.counts.removedPackages);
  assert.equal(back.counts.removedPackages, forward.counts.newPackages);
  assert.equal(findChange(back, 'rimraf', '5.0.5').kind, 'major');
  assert.equal(findChange(back, 'rimraf', '5.0.5').direction, 'down');
  assert.equal(back.counts.downgrades, 8, 'every bump reverses into a downgrade');
});

test('pairVersions matches major lines first, then a lone leftover pair', () => {
  assert.deepEqual(pairVersions(['7.5.4', '6.3.0'], ['7.6.0', '6.3.1']).pairs.sort(),
    [['6.3.0', '6.3.1'], ['7.5.4', '7.6.0']]);
  assert.deepEqual(pairVersions(['1.1.1'], ['2.0.0']).pairs, [['1.1.1', '2.0.0']]);
  const partial = pairVersions(['2.4.0'], ['2.5.0', '3.0.0']);
  assert.deepEqual(partial.pairs, [['2.4.0', '2.5.0']]);
  assert.deepEqual(partial.added, ['3.0.0']);
  assert.deepEqual(pairVersions(['1.0.0'], []).removed, ['1.0.0']);
});

test('a malformed or truncated lockfile throws instead of producing an empty diff', () => {
  const files = fs.readdirSync(fixture('malformed'));
  assert.ok(files.length >= 10, `expected a real set of malformed fixtures, found ${files.length}`);
  for (const name of files) {
    const path = fixture(`malformed/${name}`);
    assert.throws(
      () => diffLockfiles(
        parseLockfile(fs.readFileSync(path, 'utf8'), path),
        parseLockfile(fs.readFileSync(path, 'utf8'), path),
      ),
      (err) => {
        assert.match(err.message, /.+/);
        return true;
      },
      `${name} produced a diff instead of throwing`,
    );
  }
  void FIXTURES;
});
