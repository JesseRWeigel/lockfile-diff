#!/usr/bin/env node
/**
 * lockfile-diff CLI.
 *
 * Exit codes:
 *   0  ran, produced a diff
 *   1  could not run: bad usage, unreadable file, malformed lockfile. Never an empty diff.
 *   2  ran, and a --fail-on gate matched
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { LockfileError } from '../src/errors.js';
import { parseLockfileAs } from '../src/parse.js';
import { diffLockfiles } from '../src/diff.js';
import { Registry } from '../src/registry.js';
import { enrich, enrichOffline } from '../src/enrich.js';
import { renderMarkdown, renderText } from '../src/render.js';

const USAGE = `lockfile-diff - answer the five questions a reviewer has about a lockfile change

  lockfile-diff <base-lockfile> <head-lockfile> [options]
  lockfile-diff --repo <dir> --base <ref> --head <ref> --path <lockfile> [options]

Options
  --format md|text|json     output format (default: md)
  --format-in npm|pnpm      force the input reader instead of detecting it
  --out FILE                write to FILE instead of stdout
  --title TEXT              heading for the markdown comment
  --cache-dir DIR           registry cache (default: ~/.cache/lockfile-diff)
  --no-registry             skip the registry entirely; maintainer and size become UNKNOWN
  --refresh                 bypass saved registry entries (incompatible with --offline/--no-registry)
  --offline                 use only the cache; a miss is UNKNOWN, never "no change"
  --registry URL            registry base URL (default: https://registry.npmjs.org)
  --fail-on LIST            comma-separated gates: major, downgrade, maintainer, new, any
  --max-rows N              cap rows per markdown table (default: 60)
  -h, --help                this text
`;

function parseArgs(argv) {
  const opts = {
    positional: [],
    format: 'md',
    formatIn: null,
    out: null,
    title: 'Lockfile diff',
    cacheDir: path.join(os.homedir(), '.cache', 'lockfile-diff'),
    registry: undefined,
    noRegistry: false,
    offline: false,
    refresh: false,
    failOn: [],
    maxRows: 60,
    repo: null,
    base: null,
    head: null,
    path: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '-h': case '--help': opts.help = true; break;
      case '--format': opts.format = next(); break;
      case '--format-in': opts.formatIn = next(); break;
      case '--out': opts.out = next(); break;
      case '--title': opts.title = next(); break;
      case '--cache-dir': opts.cacheDir = next(); break;
      case '--registry': opts.registry = next(); break;
      case '--no-registry': opts.noRegistry = true; break;
      case '--offline': opts.offline = true; break;
      case '--refresh': opts.refresh = true; break;
      case '--fail-on': opts.failOn = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--max-rows': opts.maxRows = Number(next()); break;
      case '--repo': opts.repo = next(); break;
      case '--base': opts.base = next(); break;
      case '--head': opts.head = next(); break;
      case '--path': opts.path = next(); break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        opts.positional.push(arg);
    }
  }
  if (!['md', 'text', 'json'].includes(opts.format)) {
    throw new Error(`--format must be md, text or json (got "${opts.format}")`);
  }
  if (opts.formatIn && !['npm', 'pnpm'].includes(opts.formatIn)) {
    throw new Error(`--format-in must be npm or pnpm (got "${opts.formatIn}")`);
  }
  if (opts.refresh && (opts.offline || opts.noRegistry)) {
    throw new Error('--refresh cannot be combined with --offline or --no-registry');
  }
  const gates = new Set(['major', 'downgrade', 'maintainer', 'new', 'any']);
  for (const g of opts.failOn) {
    if (!gates.has(g)) throw new Error(`--fail-on: unknown gate "${g}" (known: ${[...gates].join(', ')})`);
  }
  return opts;
}

function gitShow(repo, ref, filePath) {
  try {
    return execFileSync('git', ['-C', repo, 'show', `${ref}:${filePath}`], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    throw new LockfileError(
      `git show ${ref}:${filePath} failed in ${repo}: ${String(err.stderr || err.message).trim()}`,
    );
  }
}

/** Read the two lockfiles named by the options. Returns [{text,label},{text,label}]. */
export function readInputs(opts) {
  if (opts.repo || opts.base || opts.head) {
    for (const field of ['repo', 'base', 'head', 'path']) {
      if (!opts[field]) throw new Error(`git mode needs --${field}`);
    }
    return [
      { text: gitShow(opts.repo, opts.base, opts.path), label: `${opts.base}:${opts.path}` },
      { text: gitShow(opts.repo, opts.head, opts.path), label: `${opts.head}:${opts.path}` },
    ];
  }
  if (opts.positional.length !== 2) {
    throw new Error('need exactly two lockfile paths, or --repo/--base/--head/--path');
  }
  return opts.positional.map((p) => {
    if (!fs.existsSync(p)) throw new LockfileError(`no such file: ${p}`);
    return { text: fs.readFileSync(p, 'utf8'), label: p };
  });
}

function gateHit(report, failOn) {
  const hits = [];
  const c = report.counts;
  if (failOn.includes('any') && c.total > 0) hits.push(`${c.total} change(s)`);
  if (failOn.includes('major') && c.major > 0) hits.push(`${c.major} major bump(s)`);
  if (failOn.includes('downgrade') && c.downgrades > 0) hits.push(`${c.downgrades} downgrade(s)`);
  if (failOn.includes('new') && c.newPackages > 0) hits.push(`${c.newPackages} new package(s)`);
  if (failOn.includes('maintainer') && (c.maintainerChanged ?? 0) > 0) {
    hits.push(`${c.maintainerChanged} maintainer change(s)`);
  }
  return hits;
}

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`lockfile-diff: ${err.message}\n\n${USAGE}`);
    return 1;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  let report;
  try {
    const [baseInput, headInput] = readInputs(opts);
    const base = parseLockfileAs(baseInput.text, opts.formatIn, baseInput.label);
    const head = parseLockfileAs(headInput.text, opts.formatIn, headInput.label);
    if (base.format !== head.format) {
      throw new LockfileError(
        `base is ${base.format} and head is ${head.format}; comparing across package managers `
        + 'is not something this tool can do honestly',
      );
    }
    report = diffLockfiles(base, head);
  } catch (err) {
    if (err instanceof LockfileError || err instanceof Error) {
      process.stderr.write(`lockfile-diff: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  if (opts.noRegistry) {
    enrichOffline(report);
  } else {
    const registry = new Registry({
      cacheDir: opts.cacheDir,
      offline: opts.offline,
      refresh: opts.refresh,
      ...(opts.registry ? { registryUrl: opts.registry } : {}),
    });
    await enrich(report, registry);
  }

  const output = opts.format === 'json'
    ? `${JSON.stringify(report, null, 2)}\n`
    : opts.format === 'text'
      ? `${renderText(report)}\n`
      : `${renderMarkdown(report, { title: opts.title, maxRows: opts.maxRows })}\n`;

  if (opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, output);
  } else {
    process.stdout.write(output);
  }

  const hits = gateHit(report, opts.failOn);
  if (hits.length) {
    process.stderr.write(`lockfile-diff: --fail-on matched: ${hits.join(', ')}\n`);
    return 2;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    process.stderr.write(`lockfile-diff: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}
