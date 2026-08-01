import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseYamlSubset } from '../src/yaml.js';
import { splitDepPath, stripPeerSuffix } from '../src/pnpm-lock.js';
import { LockfileError } from '../src/errors.js';
import { fixture } from './helpers.js';

test('parses the block mapping, flow mapping and quoting styles pnpm emits', () => {
  const doc = parseYamlSubset([
    "lockfileVersion: '9.0'",
    '',
    '# a comment',
    'settings:',
    '  autoInstallPeers: true',
    '  excludeLinksFromLockfile: false',
    '  depth: 3',
    '',
    'packages:',
    '',
    "  '@scope/pkg@1.2.3':",
    '    resolution: {integrity: sha512-abc+/def==, tarball: https://r.example/x.tgz}',
    "    engines: {node: '>=18'}",
    '    peerDependencies:',
    "      zod: ^3.25.76 || ^4.1.8",
    '    hasBin: true',
    '',
    '  plain@0.0.1:',
    '    resolution: {integrity: sha512-zzz==}',
    '',
    'neverBuiltDependencies:',
    '  - esbuild',
    '  - sharp',
    '',
  ].join('\n'));

  assert.equal(doc.lockfileVersion, '9.0');
  assert.equal(doc.settings.autoInstallPeers, true);
  assert.equal(doc.settings.excludeLinksFromLockfile, false);
  assert.equal(doc.settings.depth, 3);
  assert.equal(doc.packages['@scope/pkg@1.2.3'].resolution.integrity, 'sha512-abc+/def==');
  assert.equal(doc.packages['@scope/pkg@1.2.3'].resolution.tarball, 'https://r.example/x.tgz');
  assert.equal(doc.packages['@scope/pkg@1.2.3'].engines.node, '>=18');
  assert.equal(doc.packages['@scope/pkg@1.2.3'].peerDependencies.zod, '^3.25.76 || ^4.1.8');
  assert.equal(doc.packages['@scope/pkg@1.2.3'].hasBin, true);
  assert.deepEqual(doc.packages['plain@0.0.1'], { resolution: { integrity: 'sha512-zzz==' } });
  assert.deepEqual(doc.neverBuiltDependencies, ['esbuild', 'sharp']);
});

test('empty flow mappings stay empty rather than becoming null', () => {
  const doc = parseYamlSubset("lockfileVersion: '9.0'\n\nsnapshots:\n\n  ms@2.1.2: {}\n");
  assert.deepEqual(doc.snapshots['ms@2.1.2'], {});
});

test('single-quote escaping follows YAML rules', () => {
  const doc = parseYamlSubset("a: 'it''s here'\nb: \"tab\\there\"\n");
  assert.equal(doc.a, "it's here");
  assert.equal(doc.b, 'tab\there');
});

test('CRLF line endings parse identically to LF', () => {
  const lf = "lockfileVersion: '9.0'\n\npackages:\n\n  ms@2.1.2:\n    resolution: {integrity: x}\n";
  assert.deepEqual(parseYamlSubset(lf.replace(/\n/g, '\r\n')), parseYamlSubset(lf));
});

test('everything outside the accepted grammar throws instead of being guessed at', () => {
  const rejected = [
    ['\tkey: value\n', /tab/],
    ["a: &anchor\n  b: c\n", /anchors/],
    ['a: *alias\n', /anchors|aliases/],
    ['---\na: b\n', /multi-document/],
    ['a: |\n  block\n', /block scalars/],
    ['  a: b\n', /indented/],
    ['   a: b\n', /odd indentation/],
    ["a: 'unterminated\n", /unterminated/],
    ['a: {b: c\n', /unterminated flow/],
    ['just a bare line\n', /neither/],
    ['a:\n b: c\n', /odd indentation/],
    ['', /empty/],
  ];
  for (const [text, pattern] of rejected) {
    assert.throws(() => parseYamlSubset(text), (err) => {
      assert.ok(err instanceof LockfileError, `expected LockfileError for ${JSON.stringify(text)}`);
      assert.match(err.message, pattern);
      return true;
    }, `should have thrown for ${JSON.stringify(text)}`);
  }
});

test('the parser handles a real 4000-line pnpm-lock without losing entries', () => {
  // Guards against a parser that silently drops a branch: the counts are checked against a
  // second, independent count taken by grepping the raw text.
  const path = fixture('real/language-learning-app-8ae6855-pnpm-lock.yaml');
  const text = fs.readFileSync(path, 'utf8');
  const doc = parseYamlSubset(text, path);
  const rawPackageKeys = text
    .slice(text.indexOf('\npackages:'), text.indexOf('\nsnapshots:'))
    .split('\n')
    .filter((l) => /^ {2}\S.*:$/.test(l)).length;
  assert.equal(Object.keys(doc.packages).length, rawPackageKeys);
  assert.ok(rawPackageKeys > 800, `expected a big lockfile, got ${rawPackageKeys} packages`);
  assert.equal(Object.keys(doc.snapshots).length, rawPackageKeys);
});

test('stripPeerSuffix removes nested peer groups and leaves plain versions alone', () => {
  assert.equal(stripPeerSuffix('19.2.4'), '19.2.4');
  assert.equal(stripPeerSuffix('19.2.4(react@19.2.4)'), '19.2.4');
  assert.equal(
    stripPeerSuffix('16.2.1(@babel/core@7.29.0)(react-dom@19.2.4(react@19.2.4))(react@19.2.4)'),
    '16.2.1',
  );
});

test('splitDepPath finds the name boundary in every dep-path style', () => {
  assert.deepEqual(splitDepPath('ms@2.1.2'), ['ms', '2.1.2']);
  assert.deepEqual(splitDepPath('/ms@2.1.2'), ['ms', '2.1.2']);
  assert.deepEqual(splitDepPath('@ai-sdk/openai@3.0.48'), ['@ai-sdk/openai', '3.0.48']);
  assert.deepEqual(splitDepPath('/@ai-sdk/openai@3.0.48'), ['@ai-sdk/openai', '3.0.48']);
  // pnpm 5.x style.
  assert.deepEqual(splitDepPath('/ms/2.1.2'), ['ms', '2.1.2']);
  assert.deepEqual(splitDepPath('/@ai-sdk/openai/3.0.48'), ['@ai-sdk/openai', '3.0.48']);
  // The last @ is inside the URL, so lastIndexOf would split this in the wrong place.
  assert.deepEqual(
    splitDepPath('gitdep@git+ssh://git@github.com/example/gitdep.git#aaa'),
    ['gitdep', 'git+ssh://git@github.com/example/gitdep.git#aaa'],
  );
  assert.throws(() => splitDepPath('noversion'), LockfileError);
});
