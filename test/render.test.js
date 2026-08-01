import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderText, formatBytes, formatDelta, describeChange } from '../src/render.js';
import { diffFixtures, enrichedDiff } from './helpers.js';

test('byte formatting is signed, rounded and never a bare number', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(-1572864), '-1.50 MB');
  assert.equal(formatBytes(null), 'unknown');
  assert.equal(formatDelta(5152), '+5.0 KB');
  assert.equal(formatDelta(-55064), '-53.8 KB');
  assert.equal(formatDelta(null), 'unknown');
});

test('every change type gets a word, so colour is never the only signal', () => {
  const words = [
    [{ type: 'added', newPackage: true }, 'NEW'],
    [{ type: 'added', newPackage: false }, 'NEW VERSION'],
    [{ type: 'removed', gonePackage: true }, 'GONE'],
    [{ type: 'removed', gonePackage: false }, 'VERSION DROPPED'],
    [{ type: 'bumped', kind: 'major', direction: 'up' }, 'MAJOR'],
    [{ type: 'bumped', kind: 'major', direction: 'down' }, 'MAJOR DOWNGRADE'],
    [{ type: 'bumped', kind: 'minor', direction: 'up' }, 'minor'],
    [{ type: 'bumped', kind: 'patch', direction: 'up' }, 'patch'],
    [{ type: 'bumped', kind: 'prerelease', direction: 'up' }, 'prerelease'],
    [{ type: 'bumped', kind: 'unclassifiable' }, 'UNCLASSIFIED'],
    [{ type: 'scope-changed', scopeBefore: 'transitive', scope: 'direct' }, 'transitive -> direct'],
    [{ type: 'resolution-changed' }, 'SAME VERSION, NEW TARBALL'],
  ];
  for (const [change, word] of words) assert.equal(describeChange(change), word);
});

test('the markdown comment answers all five questions by name', async () => {
  const md = renderMarkdown(await enrichedDiff('npm-v3/base.json', 'npm-v3/head.json'));
  for (const heading of [
    '#### 1. What is new?',
    '#### 2. What changed major?',
    '#### 3. What changed transitively?',
    '#### 4. What changed maintainer?',
    '#### 5. Total install size delta',
  ]) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  assert.match(md, /\*\*15 changes\.\*\*/);
  assert.match(md, /3 major/);

  // Section 1 lists the one genuinely new package.
  assert.match(md, /#### 1\. What is new\? \(1\)/);
  assert.match(md, /`picocolors`/);

  // Section 2 covers majors, downgrades, unclassifiable and the 0.x trap.
  assert.match(md, /#### 2\. What changed major\? \(8\)/);
  assert.match(md, /1 of these is a 0\.x minor bump \(`three`\)/);
  assert.match(md, /`three`/);
  assert.match(md, /Unclassified, because at least one side is not a semver version/);
  assert.match(md, /`local-ui`: base is a link: dependency, head is a link: dependency/);

  // Section 4 names the handoff explicitly and reports unknowns as unknown.
  assert.match(md, /\*\*CHANGED\*\* \(out: gabra, isaacs; in:/);
  assert.match(md, /reported as UNKNOWN, not as "no change"/);

  // Section 5 is honest about what the number is.
  assert.match(md, /unpacked tarball size/);
  assert.match(md, /\*\*lower bound\*\*/);
});

test('a zero-change diff says so plainly instead of rendering empty tables', async () => {
  const md = renderMarkdown(await enrichedDiff('npm-v3/base.json', 'npm-v3/base.json'));
  assert.match(md, /\*\*No changes\.\*\*/);
  assert.ok(!md.includes('#### 1.'), 'no question sections when there is nothing to answer');
  assert.ok(!md.includes('| Package |'), 'no empty table');
});

test('markdown tables stay well formed when a value contains a pipe', () => {
  const report = diffFixtures('npm-v3/base.json', 'npm-v3/head.json');
  report.changes[0].name = 'weird|name';
  for (const c of report.changes) { c.maintainer = null; c.size = { delta: null }; }
  report.size = { bytesAdded: 0, bytesRemoved: 0, net: 0, unknownVersions: 0, lowerBound: false, basis: 'x' };
  const md = renderMarkdown(report);
  assert.ok(md.includes('weird\\|name'));
  for (const line of md.split('\n')) {
    if (!line.startsWith('| ')) continue;
    const cells = line.split(/(?<!\\)\|/).length - 2;
    assert.equal(cells, 6, `row has ${cells} cells, not 6: ${line}`);
  }
});

test('warnings surface in both renderers, including on a zero-change diff', async () => {
  const report = await enrichedDiff('npm-v2/disagrees.json', 'npm-v2/base.json');
  assert.equal(report.changes.length, 0);
  assert.match(renderText(report), /warning: base: lockfileVersion 2 disagrees with itself/);
  const md = renderMarkdown(report);
  assert.match(md, /\[!WARNING\]/);
  assert.match(md, /disagrees with itself/);
});

test('the text renderer prints one line per change with its scope and size', async () => {
  const text = renderText(await enrichedDiff('direct-transitive/base.json', 'direct-transitive/head.json'));
  const lines = text.split('\n').filter((l) => /^(minor|patch)/.test(l));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^minor\s+semver\s+7\.5\.4 -> 7\.6\.0\s+direct\s+\+843 B\s+MAINTAINER CHANGED$/);
  assert.match(lines[1], /^patch\s+semver\s+6\.3\.0 -> 6\.3\.1\s+transitive\s+\+1\.2 KB\s+MAINTAINER CHANGED$/);
});

test('a huge maintainer roster is capped rather than filling the comment', async () => {
  const md = renderMarkdown(await enrichedDiff('npm-v3/base.json', 'npm-v3/head.json'));
  // ms has roughly 50 maintainers on each side; the cell must not carry all of them.
  assert.match(md, /\+\d+ more/);
  // Long git URLs are shortened but keep their tail, which is where the sha differs.
  assert.match(md, /git:git\+ssh:\/\/git@github\.com\/\.\.\.aaaaaaaaaaaa -> git:git\+ssh:\/\/git@github\.com\/\.\.\.bbbbbbbbbbbb/);
  for (const line of md.split('\n')) {
    if (!line.startsWith('| ')) continue;
    assert.ok(line.length < 260, `overlong table row (${line.length}): ${line.slice(0, 120)}`);
  }
});
