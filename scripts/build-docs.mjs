#!/usr/bin/env node
/**
 * Build docs/index.html from docs/data.json.
 *
 * The page is a single self-contained file: no CDN, no external stylesheet, no remote font, no
 * fetch. The data is inlined as a JSON script tag and the page's own script renders it, which
 * means the browser check can assert on numbers only the script could have produced. A page
 * that merely contains the right strings in its HTML source would pass a grep and tell you
 * nothing about whether the script runs.
 *
 *   node scripts/build-docs.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'data.json'), 'utf8'));

const TITLE = 'lockfile-diff — the five questions a reviewer actually asks';

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf8;
  --panel: #ffffff;
  --ink: #1b1a19;
  --muted: #5d5a55;
  --line: #ddd8d0;
  --accent: #7a4a12;
  --accent-soft: #f2e6d6;
  --major: #8c2f18;
  --major-bg: #f8e4de;
  --minor: #6a5406;
  --minor-bg: #f7eecd;
  --patch: #23566b;
  --patch-bg: #dfeef4;
  --new: #1f5c34;
  --new-bg: #dff0e3;
  --gone: #5a4b7c;
  --gone-bg: #e9e3f5;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16151a;
    --panel: #1e1d23;
    --ink: #eceaf0;
    --muted: #a49fae;
    --line: #35333d;
    --accent: #e0aa6a;
    --accent-soft: #3a2f22;
    --major: #ffab93;
    --major-bg: #4a2119;
    --minor: #f0d68a;
    --minor-bg: #423616;
    --patch: #9fd4e8;
    --patch-bg: #17394a;
    --new: #97dcae;
    --new-bg: #17381f;
    --gone: #c9bbe8;
    --gone-bg: #2d2545;
  }
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #fbfaf8; --panel: #ffffff; --ink: #1b1a19; --muted: #5d5a55; --line: #ddd8d0;
  --accent: #7a4a12; --accent-soft: #f2e6d6;
  --major: #8c2f18; --major-bg: #f8e4de; --minor: #6a5406; --minor-bg: #f7eecd;
  --patch: #23566b; --patch-bg: #dfeef4; --new: #1f5c34; --new-bg: #dff0e3;
  --gone: #5a4b7c; --gone-bg: #e9e3f5;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #16151a; --panel: #1e1d23; --ink: #eceaf0; --muted: #a49fae; --line: #35333d;
  --accent: #e0aa6a; --accent-soft: #3a2f22;
  --major: #ffab93; --major-bg: #4a2119; --minor: #f0d68a; --minor-bg: #423616;
  --patch: #9fd4e8; --patch-bg: #17394a; --new: #97dcae; --new-bg: #17381f;
  --gone: #c9bbe8; --gone-bg: #2d2545;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.wrap { max-width: 68rem; margin: 0 auto; padding: 2rem 1rem 5rem; }
header { border-bottom: 2px solid var(--line); padding-bottom: 1.25rem; margin-bottom: 1.5rem; }
h1 { font-size: clamp(1.6rem, 5vw, 2.4rem); margin: 0 0 .35rem; letter-spacing: -.02em; }
h2 { font-size: 1.25rem; margin: 2.5rem 0 .75rem; letter-spacing: -.01em; }
h3 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
p { margin: .6rem 0; max-width: 62ch; }
.lede { color: var(--muted); font-size: 1.05rem; }
code, .mono { font-family: var(--mono); font-size: .875em; }
a { color: var(--accent); }
.topbar { display: flex; flex-wrap: wrap; gap: .75rem; align-items: baseline; justify-content: space-between; }
button {
  font: inherit; font-size: .875rem; cursor: pointer;
  background: var(--panel); color: var(--ink);
  border: 1px solid var(--line); border-radius: .4rem; padding: .35rem .7rem;
}
button:hover { border-color: var(--accent); }
button[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); font-weight: 600; }
#tabs { display: flex; flex-wrap: wrap; gap: .5rem; margin: 1rem 0; }
.panel {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: .6rem; padding: 1rem 1.15rem; margin: 1rem 0;
}
.before-after { display: grid; gap: 1rem; grid-template-columns: 1fr; }
@media (min-width: 56rem) { .before-after { grid-template-columns: 18rem 1fr; align-items: start; } }
.raw { font-family: var(--mono); font-size: .8rem; }
.raw .n { font-size: 2.4rem; font-weight: 700; display: block; line-height: 1.1; letter-spacing: -.03em; }
.raw .plus { color: var(--new); }
.raw .minus { color: var(--major); }
.summary { font-size: .95rem; }
.summary strong { font-weight: 700; }
.stats { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; margin: .75rem 0 0; padding: 0; list-style: none; }
.stats li { font-size: .85rem; color: var(--muted); }
.stats b { display: block; font-size: 1.35rem; color: var(--ink); font-variant-numeric: tabular-nums; }
.tablewrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: .5rem 0; }
table { border-collapse: collapse; width: 100%; min-width: 44rem; font-size: .85rem; }
th, td { text-align: left; padding: .4rem .55rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
td.pkg { font-family: var(--mono); white-space: nowrap; }
td.ver { font-family: var(--mono); font-size: .78rem; }
td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tag {
  display: inline-block; font-size: .7rem; font-weight: 700; letter-spacing: .04em;
  padding: .1rem .4rem; border-radius: .25rem; border: 1px solid currentColor; white-space: nowrap;
}
.tag-major { color: var(--major); background: var(--major-bg); }
.tag-minor { color: var(--minor); background: var(--minor-bg); }
.tag-patch { color: var(--patch); background: var(--patch-bg); }
.tag-prerelease { color: var(--patch); background: var(--patch-bg); }
.tag-added { color: var(--new); background: var(--new-bg); }
.tag-removed { color: var(--gone); background: var(--gone-bg); }
.tag-other { color: var(--muted); background: transparent; }
.handoff { color: var(--major); font-weight: 700; }
.unknown { color: var(--muted); font-style: italic; }
.note { font-size: .85rem; color: var(--muted); max-width: 68ch; }
.q { border-left: 3px solid var(--accent); padding-left: .9rem; margin: 1.5rem 0; }
.q h3 { margin-top: 0; }
footer { margin-top: 3rem; border-top: 1px solid var(--line); padding-top: 1rem; font-size: .85rem; color: var(--muted); }
.empty { color: var(--muted); font-style: italic; }
`;

const JS = String.raw`
(function () {
  var DATA = JSON.parse(document.getElementById('payload').textContent);
  var current = DATA.datasets[0].key;

  function bytes(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'unknown';
    var sign = n < 0 ? '-' : '';
    var abs = Math.abs(n);
    if (abs < 1024) return sign + abs + ' B';
    if (abs < 1048576) return sign + (abs / 1024).toFixed(1) + ' KB';
    return sign + (abs / 1048576).toFixed(2) + ' MB';
  }
  function delta(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'unknown';
    return (n > 0 ? '+' : '') + bytes(n);
  }
  function label(c) {
    if (c.type === 'added') return c.newPackage ? 'NEW' : 'NEW VERSION';
    if (c.type === 'removed') return c.gonePackage ? 'GONE' : 'VERSION DROPPED';
    if (c.type === 'bumped') {
      if (c.kind === 'unclassifiable') return 'UNCLASSIFIED';
      var base = c.kind === 'major' ? 'MAJOR' : c.kind;
      return c.direction === 'down' ? base + ' DOWNGRADE' : base;
    }
    if (c.type === 'scope-changed') return c.scopeBefore + ' \u2192 ' + c.scope;
    return c.type;
  }
  function tagClass(c) {
    if (c.type === 'added') return 'tag-added';
    if (c.type === 'removed') return 'tag-removed';
    if (c.type === 'bumped' && ['major', 'minor', 'patch', 'prerelease'].indexOf(c.kind) !== -1) {
      return 'tag-' + c.kind;
    }
    return 'tag-other';
  }
  function shorten(v, limit) {
    v = String(v);
    limit = limit || 40;
    return v.length <= limit ? v : v.slice(0, limit - 14) + '\u2026' + v.slice(-12);
  }
  function versions(c) {
    return c.type === 'bumped' ? shorten(c.from) + ' \u2192 ' + shorten(c.to) : shorten(c.version);
  }
  function maintainerCell(m) {
    if (!m) return { text: 'not checked', cls: 'unknown' };
    if (m.status === 'changed') {
      var bits = [];
      if (m.removed.length) bits.push('out: ' + m.removed.slice(0, 3).join(', ') + (m.removed.length > 3 ? ' +' + (m.removed.length - 3) : ''));
      if (m.added.length) bits.push('in: ' + m.added.slice(0, 3).join(', ') + (m.added.length > 3 ? ' +' + (m.added.length - 3) : ''));
      return { text: 'CHANGED \u2014 ' + bits.join('; '), cls: 'handoff' };
    }
    if (m.status === 'publisher-changed') {
      return { text: 'PUBLISHER CHANGED \u2014 ' + m.publisherBefore + ' \u2192 ' + m.publisherAfter, cls: 'handoff' };
    }
    if (m.status === 'same') return { text: 'unchanged', cls: '' };
    if (m.status === 'new') return { text: 'new: ' + (m.added.slice(0, 3).join(', ') || 'none listed'), cls: '' };
    if (m.status === 'unknown') return { text: 'UNKNOWN', cls: 'unknown' };
    return { text: 'n/a', cls: 'unknown' };
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  function table(changes, cap) {
    var wrap = el('div', { class: 'tablewrap' });
    if (!changes.length) {
      wrap.appendChild(el('p', { class: 'empty', text: 'Nothing in this category.' }));
      return wrap;
    }
    var t = el('table');
    var head = el('tr');
    ['Package', 'Version', 'Change', 'Scope', 'Maintainers', 'Size'].forEach(function (h) {
      head.appendChild(el('th', { text: h }));
    });
    t.appendChild(el('thead', null, [head]));
    var body = el('tbody');
    changes.slice(0, cap || 25).forEach(function (c) {
      var row = el('tr');
      row.setAttribute('data-name', c.name);
      row.appendChild(el('td', { class: 'pkg', text: c.name }));
      row.appendChild(el('td', { class: 'ver', text: versions(c) }));
      var tag = el('span', { class: 'tag ' + tagClass(c), text: label(c) });
      row.appendChild(el('td', null, [tag]));
      row.appendChild(el('td', { text: c.scope + (c.dev ? ' (dev)' : '') }));
      var m = maintainerCell(c.maintainer);
      row.appendChild(el('td', { class: m.cls, text: m.text }));
      row.appendChild(el('td', { class: 'num', text: delta(c.size ? c.size.delta : null) }));
      body.appendChild(row);
    });
    t.appendChild(body);
    wrap.appendChild(t);
    if (changes.length > (cap || 25)) {
      wrap.appendChild(el('p', { class: 'note', text: 'and ' + (changes.length - (cap || 25)) + ' more.' }));
    }
    return wrap;
  }

  function section(n, question, count, nodes) {
    var box = el('section', { class: 'q' });
    box.appendChild(el('h3', { text: n + '. ' + question + ' (' + count + ')' }));
    nodes.forEach(function (x) { box.appendChild(x); });
    return box;
  }

  function render(key) {
    var ds = null;
    DATA.datasets.forEach(function (d) { if (d.key === key) ds = d; });
    if (!ds) return;
    var r = ds.report;
    var c = r.counts;

    document.querySelectorAll('#tabs button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-key') === key));
    });

    var out = document.getElementById('output');
    out.textContent = '';

    var raw = el('div', { class: 'panel raw' });
    raw.appendChild(el('h3', { text: 'What git shows you' }));
    raw.appendChild(el('span', { class: 'n', text: String(ds.raw.added + ds.raw.removed) }));
    raw.appendChild(el('div', { text: 'lines changed in ' + r.base.format }));
    raw.appendChild(el('div', null, [
      el('span', { class: 'plus', text: '+' + ds.raw.added }),
      document.createTextNode('  '),
      el('span', { class: 'minus', text: '\u2212' + ds.raw.removed }),
    ]));
    raw.appendChild(el('p', { class: 'note', text: ds.source }));

    var summary = el('div', { class: 'panel summary' });
    summary.appendChild(el('h3', { text: 'What lockfile-diff posts' }));
    summary.appendChild(el('p', {
      text: c.total + ' changes: ' + c.newPackages + ' new, ' + c.removedPackages + ' removed, '
        + c.bumped + ' bumped. ' + c.direct + ' touch a direct dependency, '
        + c.transitive + ' are transitive.',
    }));
    var stats = el('ul', { class: 'stats' });
    [
      ['major', c.major], ['minor', c.minor], ['patch', c.patch],
      ['unclassified', c.unclassifiable], ['maintainer changed', c.maintainerChanged],
      ['size delta', delta(r.size.net)],
    ].forEach(function (pair) {
      stats.appendChild(el('li', null, [
        el('b', { text: String(pair[1]) }),
        document.createTextNode(pair[0]),
      ]));
    });
    summary.appendChild(stats);
    summary.appendChild(el('p', { class: 'note', text: ds.blurb }));

    var grid = el('div', { class: 'before-after' }, [raw, summary]);
    out.appendChild(grid);

    var added = r.changes.filter(function (x) { return x.type === 'added'; });
    var breaking = r.changes.filter(function (x) {
      return x.type === 'bumped' && (x.kind === 'major' || x.direction === 'down'
        || x.kind === 'unclassifiable' || (x.zeroMajor && x.kind === 'minor'));
    });
    var transitive = r.changes.filter(function (x) { return x.scope === 'transitive'; });
    var handoffs = r.changes.filter(function (x) {
      return x.maintainer && (x.maintainer.status === 'changed' || x.maintainer.status === 'publisher-changed');
    });
    var unknownMaint = r.changes.filter(function (x) {
      return x.maintainer && x.maintainer.status === 'unknown';
    });

    out.appendChild(section(1, 'What is new?', added.length, [table(added)]));
    out.appendChild(section(2, 'What changed major?', breaking.length, [table(breaking)]));
    out.appendChild(section(3, 'What changed transitively?', transitive.length, [
      el('p', {
        class: 'note',
        text: transitive.length + ' of ' + c.total + ' changes are to packages nothing in the '
          + 'repository depends on directly.',
      }),
      table(transitive, 15),
    ]));

    var maintNodes = [table(handoffs)];
    maintNodes.push(el('p', {
      class: 'note',
      text: unknownMaint.length + ' change(s) could not be checked and are shown as UNKNOWN, '
        + 'never as "no maintainer change".',
    }));
    out.appendChild(section(4, 'What changed maintainer?', handoffs.length, maintNodes));

    var sizeNodes = [el('p', {
      text: 'Install size delta: ' + delta(r.size.net)
        + ' (added ' + bytes(r.size.bytesAdded) + ', removed ' + bytes(r.size.bytesRemoved) + ').',
    })];
    if (r.size.platformPackages > 0) {
      sizeNodes.push(el('p', {
        class: 'note',
        text: delta(r.size.platformBytes) + ' of that is ' + r.size.platformPackages
          + ' platform-specific optional packages: prebuilt binaries listed once per os/cpu, of '
          + 'which an install downloads at most one from each set. Excluding them the delta is '
          + delta(r.size.netExcludingPlatform) + '.',
      }));
    }
    if (r.size.lowerBound) {
      sizeNodes.push(el('p', {
        class: 'note',
        text: 'Lower bound: ' + r.size.unknownVersions + ' version(s) have no dist.unpackedSize in '
          + 'the registry and contribute zero rather than being guessed at.',
      }));
    }
    sizeNodes.push(el('p', { class: 'note', text: 'Measured as the ' + r.size.basis + '.' }));
    out.appendChild(section(5, 'Total install size delta', delta(r.size.net), sizeNodes));

    document.body.dataset.rendered = key + ':' + c.total + ':' + handoffs.length;
  }

  var tabs = document.getElementById('tabs');
  DATA.datasets.forEach(function (d) {
    var b = el('button', { type: 'button', 'data-key': d.key, text: d.label });
    b.addEventListener('click', function () { current = d.key; render(current); });
    tabs.appendChild(b);
  });

  var toggle = document.getElementById('theme');
  toggle.addEventListener('click', function () {
    var root = document.documentElement;
    var now = root.getAttribute('data-theme');
    var isDark = now ? now === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', isDark ? 'light' : 'dark');
  });

  render(current);
})();
`;

const html = `<title>${TITLE}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="A lockfile diff that answers what is new, what changed major, what changed transitively, what changed maintainer, and the install size delta.">
<style>${CSS}</style>
<div class="wrap">
  <header>
    <div class="topbar">
      <div>
        <h1>lockfile-diff</h1>
        <p class="lede">A lockfile diff is thousands of unreadable lines, so reviewers approve it
        blind. These are the five questions they would ask if the answers were cheap.</p>
      </div>
      <button id="theme" type="button">Light / dark</button>
    </div>
  </header>

  <p>Every panel below is generated from a real diff, run by
  <code>bin/lockfile-diff.js</code> against real repositories and the public npm registry.
  Nothing here is illustrative.</p>

  <div id="tabs" role="group" aria-label="Choose a diff"></div>
  <main id="output"></main>

  <h2>How each question is answered</h2>
  <div class="panel">
    <p><strong>What is new</strong>, <strong>what changed major</strong> and
    <strong>what changed transitively</strong> come out of the lockfile itself. Directness is the
    one the lockfile buries: npm answers it from <code>packages[""]</code> and the install path,
    pnpm from the exact version each importer pins. A package can be a direct dependency at 7.x
    and simultaneously sit under some other package at 6.x, and those are two different rows.</p>
    <p><strong>What changed maintainer</strong> needs the registry: the
    <code>maintainers</code> list and the <code>_npmUser</code> who published each version.
    A package that changed hands between two versions is the highest-signal supply-chain warning
    the public registry offers. A lookup that fails is reported as UNKNOWN and never as
    "no maintainer change".</p>
    <p><strong>Install size delta</strong> is the sum of <code>dist.unpackedSize</code>. That is
    unpacked tarball size as the registry measured it at publish time, not node_modules on disk.
    A version with no size field makes the total a lower bound, and the count of those versions
    is printed next to it.</p>
  </div>

  <footer>
    <p>Data generated ${data.generated} by <code>scripts/build-data.mjs</code>. This page is a
    single file with no remote assets and no network access. Change type is always carried by a
    word as well as a colour.</p>
  </footer>
</div>
<script type="application/json" id="payload">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>${JS}</script>
`;

fs.writeFileSync(path.join(ROOT, 'docs', 'index.html'), html);
process.stderr.write(`wrote docs/index.html (${html.length} bytes, ${data.datasets.length} datasets)\n`);
