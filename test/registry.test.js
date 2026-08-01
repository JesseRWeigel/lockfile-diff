import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Registry, cacheKey, slimManifest } from '../src/registry.js';
import { enrich, enrichOffline } from '../src/enrich.js';
import { CACHE, diffFixtures, enrichedDiff, findChange, offlineRegistry } from './helpers.js';

test('slimManifest keeps only the three fields this tool uses, and normalises identities', () => {
  const slim = slimManifest({
    maintainers: [{ name: 'b', email: 'b@x' }, 'a <a@x>', { email: 'c@x' }, { name: 'b' }],
    _npmUser: { name: 'b', email: 'b@x' },
    dist: { unpackedSize: 1234, fileCount: 7, tarball: 'https://x' },
    deprecated: 'use v2',
    readme: 'a very long readme that must not be cached',
  });
  assert.deepEqual(slim.maintainers, ['a', 'b', 'c@x']);
  assert.equal(slim.publisher, 'b');
  assert.equal(slim.unpackedSize, 1234);
  assert.equal(slim.fileCount, 7);
  assert.equal(slim.deprecated, 'use v2');
  assert.equal('readme' in slim, false);
});

test('a manifest with no maintainers list yields null, not an empty list', () => {
  // The difference matters downstream: [] would compare equal to [] and read as "unchanged".
  assert.equal(slimManifest({ dist: {} }).maintainers, null);
  assert.equal(slimManifest({ dist: {} }).unpackedSize, null);
});

test('cacheKey is filesystem-safe for scoped names', () => {
  assert.equal(cacheKey('@polka/url', '1.0.0-next.25'), '_polka_url@1.0.0-next.25.json');
  assert.equal(cacheKey('ms', '2.1.2'), 'ms@2.1.2.json');
});

test('offline lookups never touch the network and say so when the cache misses', async () => {
  const registry = offlineRegistry();
  const hit = await registry.manifest('ms', '2.1.2');
  assert.equal(hit.status, 'ok');
  assert.ok(hit.manifest.maintainers.length > 10);

  const miss = await registry.manifest('definitely-not-cached', '1.0.0');
  assert.equal(miss.status, 'unknown');
  assert.match(miss.reason, /offline and not in the cache/);
});

test('a registry error is UNKNOWN with a reason, never a silent "no change"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfd-'));
  try {
    const failing = new Registry({
      cacheDir: dir,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    const result = await failing.manifest('ms', '2.1.2');
    assert.equal(result.status, 'unknown');
    assert.match(result.reason, /registry lookup failed: ECONNREFUSED/);

    const notFound = new Registry({
      cacheDir: dir,
      fetchImpl: async () => ({ status: 404, ok: false }),
    });
    const gone = await notFound.manifest('never-published', '1.0.0');
    assert.equal(gone.status, 'unknown');
    assert.match(gone.reason, /no manifest for this version/);

    const serverError = new Registry({
      cacheDir: null,
      fetchImpl: async () => ({ status: 503, ok: false }),
    });
    const down = await serverError.manifest('ms', '2.1.2');
    assert.equal(down.status, 'unknown');
    assert.match(down.reason, /HTTP 503/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('results are cached to disk and served from there on the next run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfd-'));
  try {
    let calls = 0;
    const doc = { maintainers: [{ name: 'a' }], _npmUser: { name: 'a' }, dist: { unpackedSize: 10 } };
    const first = new Registry({
      cacheDir: dir,
      fetchImpl: async () => { calls += 1; return { status: 200, ok: true, json: async () => doc }; },
    });
    assert.equal((await first.manifest('thing', '1.0.0')).status, 'ok');
    assert.equal(calls, 1);
    assert.ok(fs.existsSync(path.join(dir, 'thing@1.0.0.json')));

    const second = new Registry({
      cacheDir: dir,
      offline: true,
      fetchImpl: () => { throw new Error('should not be called'); },
    });
    const cached = await second.manifest('thing', '1.0.0');
    assert.equal(cached.status, 'ok');
    assert.equal(cached.manifest.unpackedSize, 10);
    assert.equal(second.stats.hits, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a maintainer handoff is reported as CHANGED with who left and who arrived', async () => {
  const report = await enrichedDiff('npm-v3/base.json', 'npm-v3/head.json');
  const abbrev = findChange(report, 'abbrev', '1.1.1');
  assert.equal(abbrev.maintainer.status, 'changed');
  // Real registry data: abbrev moved from isaacs to the npm CLI team between 1.1.1 and 2.0.0.
  assert.deepEqual(abbrev.maintainer.removed, ['gabra', 'isaacs']);
  assert.ok(abbrev.maintainer.added.includes('lukekarrys'));

  const semverTransitive = findChange(report, 'semver', '6.3.0');
  assert.equal(semverTransitive.maintainer.status, 'changed');
  assert.deepEqual(semverTransitive.maintainer.removed, ['isaacs', 'othiym23']);
});

test('a package with the same maintainers is "same", and a new publisher is called out separately', async () => {
  const report = await enrichedDiff('npm-v3/base.json', 'npm-v3/head.json');
  assert.equal(findChange(report, 'rimraf', '2.7.1').maintainer.status, 'same');

  // three kept both maintainers but was published by the other one, which is a weaker signal
  // than a roster change and gets its own status rather than being folded into "changed".
  const three = findChange(report, 'three', '0.183.2');
  assert.equal(three.maintainer.status, 'publisher-changed');
  assert.equal(three.maintainer.publisherBefore, 'mugen87');
  assert.equal(three.maintainer.publisherAfter, 'mrdoob');
});

test('a failed lookup is UNKNOWN, never "no maintainer change"', async () => {
  const report = await enrichedDiff('npm-v3/base.json', 'npm-v3/head.json');
  // nover@1.0.0 is not a real package; the cached 404 makes the comparison impossible.
  const nover = findChange(report, 'nover', '1.0.0');
  assert.equal(nover.maintainer.status, 'unknown');
  assert.match(nover.maintainer.reason, /no manifest for this version|not a registry version/);
  assert.notEqual(nover.maintainer.status, 'same');

  // Local, linked and git dependencies can never be checked, and say so.
  for (const name of ['local-ui', 'vendored', 'gitdep']) {
    const change = report.changes.find((c) => c.name === name);
    assert.equal(change.maintainer.status, 'unknown', name);
    assert.match(change.maintainer.reason, /not a registry version/, name);
  }
  assert.ok(report.counts.maintainerUnknown >= 4);
});

test('install size sums dist.unpackedSize and reports a lower bound when a version has none', async () => {
  const report = await enrichedDiff('npm-v3/base.json', 'npm-v3/head.json');
  // Real sizes from the registry: rimraf 2.7.1 is 15463 and 5.0.5 is 277365.
  assert.equal(findChange(report, 'rimraf', '2.7.1').size.from, 15463);
  assert.equal(findChange(report, 'rimraf', '2.7.1').size.to, 277365);
  assert.equal(findChange(report, 'rimraf', '2.7.1').size.delta, 277365 - 15463);
  assert.equal(findChange(report, 'glob', '7.2.3').size.delta, -55064);
  assert.equal(findChange(report, 'picocolors', '1.0.1').size.delta, 5152);

  // abbrev 1.1.1 genuinely has no unpackedSize in the registry, so its bump contributes
  // nothing and the total is explicitly a lower bound rather than silently wrong.
  const abbrev = findChange(report, 'abbrev', '1.1.1');
  assert.equal(abbrev.size.delta, null);
  assert.match(abbrev.size.why, /no dist\.unpackedSize|no manifest/);
  assert.equal(report.size.lowerBound, true);
  assert.ok(report.size.unknownVersions >= 1);
  assert.match(report.size.basis, /unpacked tarball size/);

  // The net figure is the sum of the deltas that could be measured, recomputed here from the
  // per-change numbers rather than trusting the aggregate.
  const measured = report.changes
    .filter((c) => c.size.delta !== null)
    .reduce((sum, c) => sum + c.size.delta, 0);
  assert.equal(report.size.net, measured);
});

test('--no-registry makes everything UNKNOWN rather than pretending', () => {
  const report = enrichOffline(diffFixtures('npm-v3/base.json', 'npm-v3/head.json'));
  assert.equal(report.counts.maintainerChanged, 0);
  assert.equal(report.counts.maintainerUnknown, report.changes.length);
  for (const change of report.changes) {
    assert.equal(change.maintainer.status, 'unknown');
    assert.equal(change.size.delta, null);
  }
  assert.equal(report.size.lowerBound, true);
});

test('the committed cache is complete enough that the offline suite is not vacuous', async () => {
  const report = await enrich(diffFixtures('npm-v3/base.json', 'npm-v3/head.json'), offlineRegistry());
  assert.equal(report.registry.fetched, 0, 'the offline suite must not fetch anything');
  assert.ok(report.registry.cacheHits >= 18, `only ${report.registry.cacheHits} cache hits`);
  assert.ok(fs.readdirSync(CACHE).length >= 18);
});
