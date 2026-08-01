/**
 * Renderers. The markdown one is the product: it is what gets posted as a PR comment, and it
 * is organised around the five questions rather than around the data structure.
 *
 * Change type is always carried by a word (MAJOR, minor, patch, NEW, GONE, UNCLASSIFIED), so
 * the comment reads the same to someone who cannot distinguish the colours a renderer might
 * add, and the same in a terminal with no colour at all.
 */

const KIND_LABEL = {
  major: 'MAJOR',
  minor: 'minor',
  patch: 'patch',
  prerelease: 'prerelease',
  build: 'build-metadata',
  none: 'none',
  unclassifiable: 'UNCLASSIFIED',
};

export function formatBytes(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'unknown';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 1024) return `${sign}${abs} B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`;
  return `${sign}${(abs / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDelta(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'unknown';
  return (n > 0 ? '+' : '') + formatBytes(n);
}

/** One short human phrase for a change. */
export function describeChange(change) {
  switch (change.type) {
    case 'added':
      return change.newPackage ? 'NEW' : 'NEW VERSION';
    case 'removed':
      return change.gonePackage ? 'GONE' : 'VERSION DROPPED';
    case 'bumped': {
      const label = KIND_LABEL[change.kind] ?? change.kind;
      if (change.kind === 'unclassifiable') return 'UNCLASSIFIED';
      return change.direction === 'down' ? `${label} DOWNGRADE` : label;
    }
    case 'scope-changed':
      return `${change.scopeBefore} -> ${change.scope}`;
    case 'resolution-changed':
      return 'SAME VERSION, NEW TARBALL';
    default:
      return change.type;
  }
}

/**
 * Keep a git URL or a long tarball path from taking over the table, while preserving the tail,
 * which is where the commit sha lives and therefore where the difference is.
 */
export function shortenVersion(value, limit = 44) {
  const s = String(value);
  if (s.length <= limit) return s;
  return `${s.slice(0, limit - 15)}...${s.slice(-12)}`;
}

function versionCell(change) {
  if (change.type === 'bumped') return `${shortenVersion(change.from)} -> ${shortenVersion(change.to)}`;
  return shortenVersion(change.version);
}

/** Cap a maintainer list so one package with 50 maintainers cannot eat the whole comment. */
function names(list, cap = 4) {
  if (list.length <= cap) return list.join(', ');
  return `${list.slice(0, cap).join(', ')} +${list.length - cap} more`;
}

function maintainerCell(m) {
  if (!m) return 'not checked';
  switch (m.status) {
    case 'same': return 'unchanged';
    case 'changed': {
      const bits = [];
      if (m.removed.length) bits.push(`out: ${names(m.removed)}`);
      if (m.added.length) bits.push(`in: ${names(m.added)}`);
      return `**CHANGED** (${bits.join('; ')})`;
    }
    case 'publisher-changed':
      return `**PUBLISHER CHANGED** ${m.publisherBefore} -> ${m.publisherAfter}`;
    case 'new':
      return m.added.length ? `new: ${names(m.added)}` : 'new (no maintainers listed)';
    case 'unknown': return `UNKNOWN (${m.reason})`;
    default: return 'n/a';
  }
}

function escapePipes(s) {
  return String(s).replace(/\|/g, '\\|');
}

function table(rows, headers) {
  const out = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const row of rows) out.push(`| ${row.map(escapePipes).join(' | ')} |`);
  return out.join('\n');
}

function changeRow(change) {
  return [
    `\`${change.name}\``,
    versionCell(change),
    describeChange(change),
    change.scope + (change.dev ? ' (dev)' : ''),
    maintainerCell(change.maintainer),
    formatDelta(change.size?.delta),
  ];
}

const HEADERS = ['Package', 'Version', 'Change', 'Scope', 'Maintainers', 'Size'];

function sizeSentence(report) {
  const { size } = report;
  if (size.unknownVersions > 0 && size.bytesAdded === 0 && size.bytesRemoved === 0) {
    return `Install size delta could not be measured: ${size.basis}.`;
  }
  const bound = size.lowerBound
    ? ` This is a **lower bound**: ${size.unknownVersions} version(s) had no \`dist.unpackedSize\` `
      + 'in the registry and contribute 0 to the total rather than being guessed at.'
    : '';
  const platform = size.platformPackages > 0
    ? ` ${formatDelta(size.platformBytes)} of that is ${size.platformPackages} platform-specific `
      + 'optional package(s): prebuilt binaries listed once per os/cpu, of which an install '
      + 'downloads at most one from each set. The headline number therefore overstates what any '
      + `single machine pulls. Excluding them the delta is **${formatDelta(size.netExcludingPlatform)}**.`
    : '';
  return `**${formatDelta(size.net)}** (added ${formatBytes(size.bytesAdded)}, `
    + `removed ${formatBytes(size.bytesRemoved)}). Measured as the ${size.basis}.${platform}${bound}`;
}

export function renderMarkdown(report, { title = 'Lockfile diff', maxRows = 60 } = {}) {
  const lines = [];
  const b = report.base;
  const h = report.head;
  const versionNote = b.lockfileVersion === h.lockfileVersion
    ? `${b.format} v${b.lockfileVersion}`
    : `${b.format} v${b.lockfileVersion} -> v${h.lockfileVersion}`;
  lines.push(`### ${title}`);
  lines.push('');
  lines.push(`\`${versionNote}\` · ${b.packages} packages -> ${h.packages} packages`);
  lines.push('');

  if (report.changes.length === 0) {
    lines.push('**No changes.** The two lockfiles resolve to exactly the same set of packages and versions.');
    lines.push('');
    lines.push(renderFooter(report));
    return lines.join('\n');
  }

  const c = report.counts;
  lines.push(
    `**${c.total} change${c.total === 1 ? '' : 's'}.** `
    + `${c.newPackages} new, ${c.removedPackages} removed, ${c.bumped} bumped `
    + `(**${c.major} major**, ${c.minor} minor, ${c.patch} patch`
    + (c.prerelease ? `, ${c.prerelease} prerelease` : '')
    + (c.unclassifiable ? `, ${c.unclassifiable} unclassified` : '')
    + `). ${c.direct} touch a direct dependency, ${c.transitive} are transitive.`,
  );
  lines.push('');

  // 1. What is new.
  const added = report.changes.filter((x) => x.type === 'added');
  lines.push(`#### 1. What is new? (${added.length})`);
  lines.push('');
  if (added.length === 0) lines.push('Nothing was added.');
  else lines.push(table(added.slice(0, maxRows).map(changeRow), HEADERS));
  if (added.length > maxRows) lines.push('', `...and ${added.length - maxRows} more.`);
  lines.push('');

  // 2. What changed major.
  const breaking = report.changes.filter(
    (x) => x.type === 'bumped' && (x.kind === 'major' || x.direction === 'down' || x.kind === 'unclassifiable'
      || (x.zeroMajor && x.kind === 'minor')),
  );
  lines.push(`#### 2. What changed major? (${breaking.length})`);
  lines.push('');
  if (breaking.length === 0) {
    lines.push('No major bumps, no downgrades, and nothing that could not be classified.');
  } else {
    lines.push(table(breaking.slice(0, maxRows).map(changeRow), HEADERS));
    const zero = breaking.filter((x) => x.zeroMajor && x.kind === 'minor');
    if (zero.length) {
      lines.push('');
      lines.push(
        `${zero.length} of these ${zero.length === 1 ? 'is a' : 'are'} 0.x minor `
        + `${zero.length === 1 ? 'bump' : 'bumps'} (${zero.map((x) => `\`${x.name}\``).join(', ')}). `
        + 'A minor bump below 1.0.0 is a breaking change under npm caret ranges, so they are '
        + 'listed here rather than under minor.',
      );
    }
    const unclassified = breaking.filter((x) => x.kind === 'unclassifiable');
    if (unclassified.length) {
      lines.push('');
      lines.push('Unclassified, because at least one side is not a semver version:');
      for (const x of unclassified) lines.push(`- \`${x.name}\`: ${x.reason}`);
    }
  }
  lines.push('');

  // 3. What changed transitively.
  const transitive = report.changes.filter((x) => x.scope === 'transitive');
  lines.push(`#### 3. What changed transitively? (${transitive.length})`);
  lines.push('');
  if (transitive.length === 0) {
    lines.push('Every change is to a package your package.json names directly.');
  } else {
    lines.push(
      `${transitive.length} of ${report.counts.total} changes are to packages nothing in this `
      + 'repo depends on directly. They arrived through some other package\'s dependency range.',
    );
    lines.push('');
    lines.push('<details><summary>Show transitive changes</summary>');
    lines.push('');
    lines.push(table(transitive.slice(0, maxRows).map(changeRow), HEADERS));
    if (transitive.length > maxRows) lines.push('', `...and ${transitive.length - maxRows} more.`);
    lines.push('');
    lines.push('</details>');
  }
  lines.push('');

  // 4. What changed maintainer.
  const maintainerChanged = report.changes.filter(
    (x) => x.maintainer && (x.maintainer.status === 'changed' || x.maintainer.status === 'publisher-changed'),
  );
  const maintainerUnknown = report.changes.filter((x) => x.maintainer && x.maintainer.status === 'unknown');
  lines.push(`#### 4. What changed maintainer? (${maintainerChanged.length})`);
  lines.push('');
  if (maintainerChanged.length === 0) {
    lines.push('No package changed its maintainer set or its publishing user between the two versions.');
  } else {
    lines.push(
      'A package that changed hands between the two versions is the highest-signal '
      + 'supply-chain warning the public registry offers. Look at these first.',
    );
    lines.push('');
    lines.push(table(maintainerChanged.map(changeRow), HEADERS));
  }
  if (maintainerUnknown.length > 0) {
    lines.push('');
    lines.push(
      `${maintainerUnknown.length} change(s) could not be checked and are reported as UNKNOWN, `
      + 'not as "no change". First few: '
      + maintainerUnknown.slice(0, 5).map((x) => `\`${x.name}\` (${x.maintainer.reason})`).join('; '),
    );
  }
  lines.push('');

  // 5. Total install size delta.
  lines.push('#### 5. Total install size delta');
  lines.push('');
  lines.push(sizeSentence(report));
  lines.push('');

  const rest = report.changes.filter(
    (x) => !added.includes(x) && !breaking.includes(x) && !transitive.includes(x) && !maintainerChanged.includes(x),
  );
  if (rest.length) {
    lines.push('<details><summary>Everything else (' + rest.length + ')</summary>');
    lines.push('');
    lines.push(table(rest.slice(0, maxRows).map(changeRow), HEADERS));
    if (rest.length > maxRows) lines.push('', `...and ${rest.length - maxRows} more.`);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  lines.push(renderFooter(report));
  return lines.join('\n');
}

function renderFooter(report) {
  const bits = [];
  if (report.registry) {
    bits.push(
      report.registry.disabled
        ? 'registry lookups disabled'
        : `registry: ${report.registry.fetched} fetched, ${report.registry.cacheHits} cached, `
          + `${report.registry.unknown} unknown`,
    );
  }
  const out = [];
  if (report.warnings.length) {
    out.push('> [!WARNING]');
    for (const w of report.warnings) out.push(`> ${w}`);
    out.push('');
  }
  out.push(`<sub>lockfile-diff${bits.length ? ` · ${bits.join(' · ')}` : ''}</sub>`);
  return out.join('\n');
}

export function renderText(report) {
  const lines = [];
  lines.push(`${report.base.format} v${report.base.lockfileVersion} -> v${report.head.lockfileVersion}`);
  lines.push(`${report.base.packages} packages -> ${report.head.packages} packages`);
  if (report.changes.length === 0) {
    lines.push('no changes');
    // Warnings are printed even when nothing changed. A lockfile that contradicts itself is
    // worth saying out loud, and the zero-change path used to swallow it.
    for (const w of report.warnings) lines.push(`warning: ${w}`);
    return lines.join('\n');
  }
  const c = report.counts;
  lines.push(
    `${c.total} changes: ${c.newPackages} new, ${c.removedPackages} removed, ${c.bumped} bumped `
    + `(${c.major} major, ${c.minor} minor, ${c.patch} patch, ${c.prerelease} prerelease, `
    + `${c.unclassifiable} unclassified), ${c.direct} direct, ${c.transitive} transitive`,
  );
  lines.push(
    `size delta: ${formatDelta(report.size?.net)}${report.size?.lowerBound ? ' (lower bound)' : ''}`
    + (report.size?.platformPackages
      ? `, of which ${formatDelta(report.size.platformBytes)} is platform-specific binaries `
        + `(${formatDelta(report.size.netExcludingPlatform)} excluding them)`
      : ''),
  );
  lines.push('');
  const width = Math.min(40, Math.max(...report.changes.map((x) => x.name.length)));
  for (const change of report.changes) {
    lines.push(
      `${describeChange(change).padEnd(18)} ${change.name.padEnd(width)} `
      + `${versionCell(change).padEnd(28)} ${change.scope.padEnd(10)} `
      + `${formatDelta(change.size?.delta).padStart(11)}`
      + (change.maintainer && change.maintainer.status === 'changed' ? '  MAINTAINER CHANGED' : '')
      + (change.maintainer && change.maintainer.status === 'publisher-changed' ? '  PUBLISHER CHANGED' : '')
      + (change.maintainer && change.maintainer.status === 'unknown' ? '  maintainer: unknown' : ''),
    );
  }
  for (const w of report.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n');
}
