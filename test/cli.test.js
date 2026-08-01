import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { CACHE, FIXTURES, ROOT, fixture } from './helpers.js';

const BIN = path.join(ROOT, 'bin', 'lockfile-diff.js');

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    ...options,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const OFFLINE = ['--cache-dir', CACHE, '--offline'];

test('two lockfile paths produce a markdown comment and exit 0', () => {
  const r = run([fixture('npm-v3/base.json'), fixture('npm-v3/head.json'), ...OFFLINE]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /### Lockfile diff/);
  assert.match(r.out, /#### 5\. Total install size delta/);
});

test('--format json emits a parseable report with the fields the Action needs', () => {
  const r = run([fixture('npm-v3/base.json'), fixture('npm-v3/head.json'), ...OFFLINE, '--format', 'json']);
  assert.equal(r.code, 0, r.err);
  const report = JSON.parse(r.out);
  assert.equal(report.counts.total, 15);
  assert.equal(report.counts.major, 3);
  assert.equal(report.counts.direct, 10);
  assert.equal(report.counts.transitive, 5);
  assert.equal(report.counts.maintainerChanged, 6, "5 roster changes plus 1 publisher change");
  assert.equal(report.base.format, 'package-lock.json');
  assert.equal(report.size.lowerBound, true);
  for (const change of report.changes) {
    assert.ok(change.maintainer, 'every change carries a maintainer verdict');
    assert.ok(change.size, 'every change carries a size verdict');
    assert.ok(['direct', 'transitive'].includes(change.scope));
  }
});

test('EVERY malformed lockfile exits 1 with a message, never an empty diff and exit 0', () => {
  const files = fs.readdirSync(fixture('malformed'));
  assert.ok(files.length >= 10, `only ${files.length} malformed fixtures`);
  for (const name of files) {
    const p = fixture(`malformed/${name}`);
    const r = run([p, p, '--no-registry']);
    assert.equal(r.code, 1, `${name} exited ${r.code}\nstdout: ${r.out}`);
    assert.equal(r.out, '', `${name} wrote a diff to stdout`);
    assert.match(r.err, /^lockfile-diff: .+/, name);
  }
});

test('a good base against a malformed head still exits 1', () => {
  const r = run([fixture('npm-v3/base.json'), fixture('malformed/truncated.json'), '--no-registry']);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
});

test('mixing a package-lock with a pnpm-lock is refused rather than half-answered', () => {
  const r = run([fixture('npm-v3/base.json'), fixture('pnpm-v9/base.yaml'), '--no-registry']);
  assert.equal(r.code, 1);
  assert.match(r.err, /comparing across package managers/);
});

test('--fail-on gates exit 2, and only when the gate actually matches', () => {
  const base = fixture('npm-v3/base.json');
  const head = fixture('npm-v3/head.json');
  const major = run([base, head, ...OFFLINE, '--format', 'text', '--fail-on', 'major']);
  assert.equal(major.code, 2);
  assert.match(major.err, /--fail-on matched: 3 major bump\(s\)/);
  assert.match(major.out, /MAJOR/, 'the report is still printed when the gate trips');

  const maintainer = run([base, head, ...OFFLINE, '--format', 'text', '--fail-on', 'maintainer']);
  assert.equal(maintainer.code, 2);
  assert.match(maintainer.err, /6 maintainer change\(s\)/);

  // Nothing changed, so no gate can match.
  const quiet = run([base, base, ...OFFLINE, '--format', 'text', '--fail-on', 'major,maintainer,new,any']);
  assert.equal(quiet.code, 0, quiet.err);
  assert.match(quiet.out, /no changes/);

  const unknownGate = run([base, head, ...OFFLINE, '--fail-on', 'nonsense']);
  assert.equal(unknownGate.code, 1);
  assert.match(unknownGate.err, /unknown gate "nonsense"/);
});

test('--out writes the comment to a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfd-'));
  try {
    const target = path.join(dir, 'nested', 'comment.md');
    const r = run([fixture('npm-v3/base.json'), fixture('npm-v3/head.json'), ...OFFLINE, '--out', target]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, '');
    assert.match(fs.readFileSync(target, 'utf8'), /#### 4\. What changed maintainer\?/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('git mode reads both sides out of a repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfd-git-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    fs.copyFileSync(fixture('npm-v3/base.json'), path.join(dir, 'package-lock.json'));
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    fs.copyFileSync(fixture('npm-v3/head.json'), path.join(dir, 'package-lock.json'));
    git('add', '-A');
    git('commit', '-q', '-m', 'head');

    const r = run(['--repo', dir, '--base', 'HEAD~1', '--head', 'HEAD',
      '--path', 'package-lock.json', ...OFFLINE, '--format', 'json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).counts.total, 15);

    const missing = run(['--repo', dir, '--base', 'HEAD~1', '--head', 'HEAD',
      '--path', 'nope.json', '--no-registry']);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /git show HEAD~1:nope\.json failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('usage errors exit 1 and print the usage text', () => {
  assert.equal(run(['--help']).code, 0);
  assert.match(run(['--help']).out, /lockfile-diff <base-lockfile> <head-lockfile>/);
  assert.equal(run([]).code, 1);
  assert.equal(run([fixture('npm-v3/base.json')]).code, 1);
  assert.equal(run(['--format', 'yaml', 'a', 'b']).code, 1);
  assert.match(run(['--wat']).err, /unknown option --wat/);
  assert.equal(run(['/does/not/exist.json', '/nor/this.json']).code, 1);
});

test('the shipped GitHub Action workflow and action.yml reference commands that exist', () => {
  const action = fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8');
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'lockfile-diff.yml'), 'utf8');
  for (const text of [action, workflow]) {
    for (const flag of text.match(/--[a-z-]+/g) ?? []) {
      if (['--fail-on', '--format', '--out', '--repo', '--base', '--head', '--path',
        '--cache-dir', '--title', '--offline', '--no-registry', '--registry',
        '--max-rows', '--format-in', '--help', '--depth', '--no-save', '--body-file',
        '--edit-last', '--create-if-none'].includes(flag)) continue;
      assert.fail(`unrecognised flag ${flag} in an Action file`);
    }
  }
  assert.match(action, /bin\/lockfile-diff\.js/);
  assert.ok(fs.existsSync(path.join(ROOT, 'bin', 'lockfile-diff.js')));
  void FIXTURES;
});
