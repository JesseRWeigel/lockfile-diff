#!/usr/bin/env node
/**
 * Regenerate docs/data.json from real repositories and the real npm registry.
 *
 * This is the ONLY step in the project that needs the network and Jesse's local checkouts, so
 * it is deliberately not part of `scripts/verify.sh`. Verify instead re-derives the change
 * counts from the same repositories with `--no-registry` and asserts they still match what is
 * committed here, which catches a stale data.json without requiring the registry to be up.
 *
 *   node scripts/build-data.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLockfile } from '../src/parse.js';
import { diffLockfiles } from '../src/diff.js';
import { Registry } from '../src/registry.js';
import { enrich } from '../src/enrich.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();

const DATASETS = [
  {
    key: 'jw',
    label: 'jesseweigel.com',
    blurb: 'A real portfolio rebuild: Three.js dropped, Vercel analytics added, Next.js patched.',
    repo: path.join(HOME, 'Projects', 'jesseweigel.com'),
    file: 'package-lock.json',
    base: 'f2c8564',
    head: 'a6deb9d',
  },
  {
    key: 'lla',
    label: 'language-learning-app',
    blurb: 'A real pnpm workspace: one testing library added, and nothing else moved.',
    repo: path.join(HOME, 'Projects', 'language-learning-app'),
    file: 'pnpm-lock.yaml',
    base: '2068c04',
    head: '8ae6855',
  },
  {
    key: 'fixture',
    label: 'known-answer fixture',
    blurb: 'The hand-built pair from the test suite, which exercises every classification at once.',
    files: [path.join(ROOT, 'test', 'fixtures', 'npm-v3', 'base.json'),
      path.join(ROOT, 'test', 'fixtures', 'npm-v3', 'head.json')],
  },
];

function show(repo, ref, file) {
  return execFileSync('git', ['-C', repo, 'show', `${ref}:${file}`], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
}

function rawLineCounts(dataset) {
  if (!dataset.repo) {
    const [a, b] = dataset.files.map((f) => fs.readFileSync(f, 'utf8').split('\n'));
    return { added: b.length, removed: a.length };
  }
  const stat = execFileSync(
    'git',
    ['-C', dataset.repo, 'diff', '--numstat', dataset.base, dataset.head, '--', dataset.file],
    { encoding: 'utf8' },
  ).trim().split('\t');
  return { added: Number(stat[0]), removed: Number(stat[1]) };
}

const registry = new Registry({ cacheDir: path.join(ROOT, '.cache', 'registry') });
const out = { generated: new Date().toISOString().slice(0, 10), datasets: [] };

for (const dataset of DATASETS) {
  const [baseText, headText, baseLabel, headLabel] = dataset.repo
    ? [show(dataset.repo, dataset.base, dataset.file), show(dataset.repo, dataset.head, dataset.file),
      `${dataset.base}:${dataset.file}`, `${dataset.head}:${dataset.file}`]
    : [fs.readFileSync(dataset.files[0], 'utf8'), fs.readFileSync(dataset.files[1], 'utf8'),
      'base.json', 'head.json'];
  const report = await enrich(
    diffLockfiles(parseLockfile(baseText, baseLabel), parseLockfile(headText, headLabel)),
    registry,
  );
  const raw = rawLineCounts(dataset);
  process.stderr.write(
    `${dataset.label}: ${raw.added + raw.removed} raw lockfile lines -> ${report.counts.total} changes\n`,
  );
  out.datasets.push({
    key: dataset.key,
    label: dataset.label,
    blurb: dataset.blurb,
    source: dataset.repo ? `${dataset.base}..${dataset.head} · ${dataset.file}` : 'test/fixtures/npm-v3',
    raw,
    report,
  });
}

fs.writeFileSync(path.join(ROOT, 'docs', 'data.json'), `${JSON.stringify(out, null, 1)}\n`);
process.stderr.write(`wrote docs/data.json (${registry.stats.fetched} fetched, ${registry.stats.hits} cached, ${registry.stats.unknown} unknown)\n`);
