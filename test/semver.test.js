import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChange, compareSemver, isSemver, parseSemver } from '../src/semver.js';

test('parseSemver accepts and rejects the right shapes', () => {
  assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, pre: null, build: null });
  assert.deepEqual(parseSemver('1.0.0-next.29').pre, ['next', '29']);
  assert.equal(parseSemver('1.2.3+build.1').build, 'build.1');
  for (const bad of ['1.2', 'v1.2.3', '1.2.3.4', 'latest', '', null, undefined, 'file:../x', 'link:../x']) {
    assert.equal(parseSemver(bad), null, `${bad} should not parse as semver`);
  }
  assert.equal(isSemver('0.0.1'), true);
});

test('compareSemver orders prereleases below their release', () => {
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareSemver('1.0.0-rc.2', '1.0.0-rc.10'), -1);
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareSemver('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compareSemver('1.0.0+a', '1.0.0+b'), 0);
});

test('every bump size classifies as itself and nothing else', () => {
  const cases = [
    ['1.0.0', '2.0.0', 'major', 'up'],
    ['2.0.0', '1.0.0', 'major', 'down'],
    ['1.0.0', '1.1.0', 'minor', 'up'],
    ['1.1.0', '1.0.0', 'minor', 'down'],
    ['1.0.0', '1.0.1', 'patch', 'up'],
    ['1.0.1', '1.0.0', 'patch', 'down'],
    ['1.0.0-next.25', '1.0.0-next.29', 'prerelease', 'up'],
    ['1.0.0-rc.1', '1.0.0', 'prerelease', 'up'],
    ['1.0.0+a', '1.0.0+b', 'build', null],
  ];
  for (const [from, to, kind, direction] of cases) {
    const got = classifyChange(from, to);
    assert.equal(got.kind, kind, `${from} -> ${to} should be ${kind}, got ${got.kind}`);
    assert.equal(got.direction, direction, `${from} -> ${to} direction`);
    assert.equal(got.reason, null);
  }
});

test('identical versions are "none", never a patch', () => {
  assert.equal(classifyChange('1.2.3', '1.2.3').kind, 'none');
});

test('0.x minor bumps are flagged, because they are breaking under caret ranges', () => {
  const zero = classifyChange('0.183.2', '0.184.0');
  assert.equal(zero.kind, 'minor');
  assert.equal(zero.zeroMajor, true);
  assert.equal(classifyChange('1.183.2', '1.184.0').zeroMajor, false);
});

test('non-semver versions are unclassifiable, never silently a patch', () => {
  const cases = [
    ['file:vendor/a-1.0.0.tgz', 'file:vendor/a-1.0.1.tgz', 'a file: dependency'],
    ['link:packages/ui', 'link:packages/ui-next', 'a link: dependency'],
    ['workspace:*', 'workspace:^', 'a workspace: dependency'],
    ['git:git+ssh://git@github.com/a/b.git#aaa', 'git:git+ssh://git@github.com/a/b.git#bbb', 'a git dependency'],
    ['https://example.com/a-1.0.0.tgz', 'https://example.com/a-1.0.1.tgz', 'a URL dependency'],
    ['npm:other@1.0.0', 'npm:other@2.0.0', 'an npm: alias'],
    ['latest', 'next', 'not a semver version'],
  ];
  for (const [from, to, phrase] of cases) {
    const got = classifyChange(from, to);
    assert.equal(got.kind, 'unclassifiable', `${from} -> ${to} must not be classified as ${got.kind}`);
    assert.equal(got.direction, null);
    assert.match(got.reason, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('a missing version on one side is unclassifiable and says which side', () => {
  const gone = classifyChange('1.0.0', null);
  assert.equal(gone.kind, 'unclassifiable');
  assert.equal(gone.reason, 'head is missing');
  const arrived = classifyChange(null, '1.0.0');
  assert.equal(arrived.kind, 'unclassifiable');
  assert.equal(arrived.reason, 'base is missing');
});

test('a semver side paired with a non-semver side is still unclassifiable', () => {
  assert.equal(classifyChange('1.0.0', 'link:packages/ui').kind, 'unclassifiable');
  assert.equal(classifyChange('link:packages/ui', '1.0.0').kind, 'unclassifiable');
});
