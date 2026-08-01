import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLockfile } from '../src/parse.js';
import { diffLockfiles } from '../src/diff.js';
import { Registry } from '../src/registry.js';
import { enrich } from '../src/enrich.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures');
export const CACHE = path.join(FIXTURES, 'registry-cache');

export function fixture(rel) {
  return path.join(FIXTURES, rel);
}

export function readFixture(rel) {
  return fs.readFileSync(fixture(rel), 'utf8');
}

export function parseFixture(rel) {
  return parseLockfile(readFixture(rel), fixture(rel));
}

export function diffFixtures(baseRel, headRel) {
  return diffLockfiles(parseFixture(baseRel), parseFixture(headRel));
}

/**
 * A registry that can only ever read the committed cache. `offline: true` plus a fetch that
 * throws means a test cannot accidentally depend on the network: if the fixture is missing,
 * the result is UNKNOWN and the assertion that expected 'changed' fails loudly.
 */
export function offlineRegistry() {
  return new Registry({
    cacheDir: CACHE,
    offline: true,
    fetchImpl: () => { throw new Error('a test tried to reach the network'); },
  });
}

export async function enrichedDiff(baseRel, headRel) {
  return enrich(diffFixtures(baseRel, headRel), offlineRegistry());
}

/** Find the single change matching a name and, optionally, a from-version. */
export function findChange(report, name, from) {
  const hits = report.changes.filter(
    (c) => c.name === name && (from === undefined || c.from === from || c.version === from),
  );
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one change for ${name}${from ? `@${from}` : ''}, found ${hits.length}: `
      + JSON.stringify(hits.map((c) => [c.type, c.from ?? c.version, c.to])),
    );
  }
  return hits[0];
}
