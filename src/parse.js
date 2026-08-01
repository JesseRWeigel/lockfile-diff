/**
 * Pick a lockfile reader from the filename, or from the content when the name is unhelpful
 * (git show writes to stdout, and a base copy is often called `base.lock`).
 */
import { LockfileError } from './errors.js';
import { parseNpmLock } from './npm-lock.js';
import { parsePnpmLock } from './pnpm-lock.js';

export function detectFormat(text, filename = '') {
  const base = filename.split('/').pop() || '';
  if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') return 'npm';
  if (base === 'pnpm-lock.yaml' || base === 'pnpm-lock.yml') return 'pnpm';
  const head = text.slice(0, 4096);
  if (/^\s*\{/.test(head)) return 'npm';
  if (/^\s*lockfileVersion:/m.test(head)) return 'pnpm';
  return null;
}

export function parseLockfile(text, filename = 'lockfile') {
  if (typeof text !== 'string') throw new LockfileError('lockfile content is not text', { file: filename });
  if (text.trim() === '') throw new LockfileError('file is empty', { file: filename });
  const format = detectFormat(text, filename);
  if (format === 'npm') return parseNpmLock(text, filename);
  if (format === 'pnpm') return parsePnpmLock(text, filename);
  throw new LockfileError(
    'cannot tell whether this is a package-lock.json or a pnpm-lock.yaml. '
    + 'Name the file package-lock.json or pnpm-lock.yaml, or pass --format-in npm|pnpm.',
    { file: filename },
  );
}

export function parseLockfileAs(text, format, filename = 'lockfile') {
  if (format === 'npm') return parseNpmLock(text, filename);
  if (format === 'pnpm') return parsePnpmLock(text, filename);
  return parseLockfile(text, filename);
}
