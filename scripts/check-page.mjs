#!/usr/bin/env node
/**
 * Load docs/index.html in a real Chromium and assert on what the page's own script produced.
 *
 * Written around four traps that have each cost a project here:
 *
 * 1. A whole inline script can fail to parse while every unit test passes, leaving a page that
 *    renders as static HTML with no numbers in it. Every assertion below is on a node the
 *    script had to create.
 * 2. The shared Playwright browser is one instance across all agents on this box, so another
 *    agent can navigate it out from under a measurement. This launches its own Chromium and
 *    asserts document.title inside every evaluation.
 * 3. A stale server on a fixed port serves a different project's page with a cheerful 200. This
 *    binds to port 0 and asserts on served content, not status.
 * 4. `body { overflow-x: hidden }` hides overflow and makes the scrollWidth probe vacuous, so
 *    the check refuses to run against a page that sets it, and finds the offending element by
 *    walking the tree rather than trusting one number.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TITLE = 'lockfile-diff — the five questions a reviewer actually asks';
const require_ = createRequire(path.join(ROOT, 'scripts', 'x.js'));

// Most portable first. The sibling-project path is LAST and is a fallback, not the mechanism:
// several projects here only ever worked in the directory they were written in because that
// hardcoded path was the sole candidate.
const CANDIDATES = [
  ...(process.env.PLAYWRIGHT_CORE ? [process.env.PLAYWRIGHT_CORE] : []),
  path.join(ROOT, 'node_modules', 'playwright-core'),
  path.join(ROOT, 'node_modules', 'playwright'),
  'playwright-core',
  'playwright',
  path.join(ROOT, '..', 'a11y-sweep', 'node_modules', 'playwright-core'),
];
let playwright = null;
for (const candidate of CANDIDATES) {
  try { playwright = require_(candidate); break; } catch { /* try the next one */ }
}
if (!playwright) {
  console.error(
    'playwright-core not found, so docs/index.html was NOT verified in a browser.\n'
    + 'This is a failure, not a skip: a check that did not run reports "could not verify",\n'
    + 'never "verified".\n\n'
    + 'To run it:  npm install --no-save playwright-core && npx playwright install chromium\n'
    + 'Or point at an existing install:  PLAYWRIGHT_CORE=/path/to/playwright-core\n\n'
    + 'Everything else in scripts/verify.sh runs without a browser.');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'data.json'), 'utf8'));
const oks = [];
const fails = [];
const check = (cond, m) => (cond ? oks.push(m) : fails.push(m));

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = rel === '/' ? '/index.html' : rel;
  const abs = path.join(ROOT, 'docs', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(path.join(ROOT, 'docs')) || !fs.existsSync(abs)) {
    res.writeHead(404).end('no');
    return;
  }
  res.writeHead(200, {
    'content-type': abs.endsWith('.html') ? 'text/html; charset=utf-8'
      : abs.endsWith('.json') ? 'application/json' : 'text/plain',
  });
  res.end(fs.readFileSync(abs));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log(`serving docs/ on ${base} (port chosen by the OS, never hardcoded)`);

const probe = await fetch(`${base}/index.html`).then((r) => r.text());
check(probe.includes(`<title>${TITLE}</title>`),
  `the served bytes are this project's page (title found in ${probe.length} bytes)`);
check(probe.includes('id="payload"'), 'the served page carries its inlined data payload');

const browser = await playwright.chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

async function evalOnOurPage(page, fn, arg) {
  const out = await page.evaluate(({ expectTitle, a }) => {
    if (document.title !== expectTitle) return { __wrongPage: document.title };
    return { value: (0, eval)(a.fnSource)(a.arg) };
  }, { expectTitle: TITLE, a: { fnSource: fn.toString(), arg } });
  if (out.__wrongPage !== undefined) {
    throw new Error(`page identity check failed: title is "${out.__wrongPage}", expected `
      + `"${TITLE}". Another agent's browser may have navigated this tab.`);
  }
  return out.value;
}

const consoleErrors = [];
const first = data.datasets[0];
const expectedHandoffs = (ds) => ds.report.changes.filter(
  (c) => c.maintainer && (c.maintainer.status === 'changed' || c.maintainer.status === 'publisher-changed'),
).length;

try {
  for (const [labelName, width, height] of [['desktop', 1280, 900], ['narrow', 390, 780]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${labelName}: ${m.text()}`); });
    page.on('pageerror', (e) => consoleErrors.push(`${labelName}: pageerror ${e.message}`));
    await page.goto(`${base}/index.html`, { waitUntil: 'load' });

    // 1. The script ran to completion. body[data-rendered] is set on the last line of render().
    const rendered = await evalOnOurPage(page, () => document.body.dataset.rendered || '');
    const want = `${first.key}:${first.report.counts.total}:${expectedHandoffs(first)}`;
    check(rendered === want,
      `${labelName}: the page script ran and rendered the first dataset `
      + `(data-rendered="${rendered}", expected "${want}")`);

    // 2. Structure the script had to build from the payload.
    const built = await evalOnOurPage(page, () => ({
      tabs: document.querySelectorAll('#tabs button').length,
      sections: document.querySelectorAll('#output section.q').length,
      headings: [...document.querySelectorAll('#output section.q h3')].map((h) => h.textContent),
      rows: document.querySelectorAll('#output table tbody tr').length,
      tags: document.querySelectorAll('#output .tag').length,
      handoffCells: document.querySelectorAll('#output td.handoff').length,
      unknownCells: document.querySelectorAll('#output td.unknown').length,
      rawTotal: (document.querySelector('.raw .n') || {}).textContent || '',
      stats: [...document.querySelectorAll('.stats li')].map((li) => li.textContent),
      scrollers: document.querySelectorAll('#output .tablewrap').length,
    }));
    check(built.tabs === data.datasets.length, `${labelName}: ${built.tabs} dataset tabs rendered`);
    check(built.sections === 5, `${labelName}: all five question sections rendered (${built.sections})`);
    check(/^1\. What is new\?/.test(built.headings[0] || ''), `${labelName}: section 1 is "what is new"`);
    check(/^4\. What changed maintainer\?/.test(built.headings[3] || ''),
      `${labelName}: section 4 is "what changed maintainer"`);
    check(built.rows > 20, `${labelName}: ${built.rows} change rows drawn from the payload`);
    check(built.tags === built.rows,
      `${labelName}: every row carries a WORD for its change type, not colour alone `
      + `(${built.tags} tags for ${built.rows} rows)`);
    check(built.handoffCells >= 5,
      `${labelName}: ${built.handoffCells} maintainer handoffs highlighted`);
    check(built.rawTotal === String(first.raw.added + first.raw.removed),
      `${labelName}: the raw lockfile line count reads ${built.rawTotal}`);
    check(built.stats.length === 6, `${labelName}: 6 summary stats`);
    check(built.scrollers >= 4, `${labelName}: each table sits in its own scroll container`);

    // 3. Switching dataset re-renders from the payload rather than showing stale numbers.
    const second = data.datasets[1];
    await page.click(`#tabs button[data-key="${second.key}"]`);
    const after = await evalOnOurPage(page, () => ({
      rendered: document.body.dataset.rendered,
      pressed: [...document.querySelectorAll('#tabs button')]
        .filter((b) => b.getAttribute('aria-pressed') === 'true').length,
    }));
    check(after.rendered === `${second.key}:${second.report.counts.total}:${expectedHandoffs(second)}`,
      `${labelName}: switching dataset re-rendered (${after.rendered})`);
    check(after.pressed === 1, `${labelName}: exactly one tab is marked pressed`);
    // The fixture dataset is the one that contains lookups that cannot succeed (a link:, a
    // git dep, a package that was never published), so the UNKNOWN path is checked there.
    const fixtureDs = data.datasets[data.datasets.length - 1];
    await page.click(`#tabs button[data-key="${fixtureDs.key}"]`);
    const unknowns = await evalOnOurPage(page, () => ({
      cells: document.querySelectorAll('#output td.unknown').length,
      note: [...document.querySelectorAll('#output section.q p.note')]
        .map((n) => n.textContent).join(' | '),
    }));
    check(unknowns.cells >= 3,
      `${labelName}: ${unknowns.cells} lookups that could not be made are shown as UNKNOWN`);
    check(/never as "no maintainer change"/.test(unknowns.note),
      `${labelName}: the page says UNKNOWN is not the same as "no maintainer change"`);
    await page.click(`#tabs button[data-key="${first.key}"]`);

    // 4. Theme works in both directions and both selectors apply.
    const theme = await evalOnOurPage(page, () => {
      const root = document.documentElement;
      const read = () => getComputedStyle(document.body).backgroundColor;
      root.setAttribute('data-theme', 'light');
      const light = read();
      root.setAttribute('data-theme', 'dark');
      const dark = read();
      root.removeAttribute('data-theme');
      document.getElementById('theme').click();
      const one = root.getAttribute('data-theme');
      document.getElementById('theme').click();
      const two = root.getAttribute('data-theme');
      root.removeAttribute('data-theme');
      return { light, dark, one, two };
    });
    check(theme.light !== theme.dark,
      `${labelName}: data-theme light and dark give different backgrounds (${theme.light} vs ${theme.dark})`);
    check(theme.one && theme.two && theme.one !== theme.two,
      `${labelName}: the toggle flips both ways (${theme.one} then ${theme.two})`);

    if (labelName === 'narrow') {
      const overflow = await evalOnOurPage(page, () => {
        const docW = document.documentElement.clientWidth;
        const offenders = [];
        const inScroller = (node) => {
          for (let p = node.parentElement; p; p = p.parentElement) {
            const ox = getComputedStyle(p).overflowX;
            if (ox === 'auto' || ox === 'scroll') return true;
          }
          return false;
        };
        for (const node of document.querySelectorAll('body *')) {
          const r = node.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.right > docW + 0.5 && !inScroller(node)) {
            offenders.push({
              tag: node.tagName.toLowerCase(),
              id: node.id || null,
              cls: String(node.className || '').slice(0, 40),
              right: Math.round(r.right),
            });
          }
        }
        return {
          docW,
          scrollW: document.documentElement.scrollWidth,
          offenders: offenders.slice(0, 8),
          bodyOverflowX: getComputedStyle(document.body).overflowX,
          htmlOverflowX: getComputedStyle(document.documentElement).overflowX,
          tableScrolls: [...document.querySelectorAll('.tablewrap')]
            .filter((n) => n.scrollWidth > n.clientWidth).length,
        };
      });
      check(overflow.bodyOverflowX !== 'hidden' && overflow.htmlOverflowX !== 'hidden',
        `overflow-x is not hidden on body or html (${overflow.bodyOverflowX}/${overflow.htmlOverflowX}), `
        + 'so this probe is not vacuous');
      check(overflow.offenders.length === 0,
        `narrow: no element escapes the 390px viewport (client ${overflow.docW}px, `
        + `scroll ${overflow.scrollW}px)`
        + (overflow.offenders.length ? ` offenders: ${JSON.stringify(overflow.offenders)}` : ''));
      check(overflow.scrollW <= overflow.docW + 1,
        `narrow: documentElement.scrollWidth ${overflow.scrollW} <= clientWidth ${overflow.docW}`);
      check(overflow.tableScrolls >= 1,
        `narrow: ${overflow.tableScrolls} wide table(s) scroll inside their own container`);
    }

    await page.close();
  }

  const html = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
  const remote = [...html.matchAll(/(?:src|href)\s*=\s*["'](https?:|\/\/)[^"']*/gi)].map((m) => m[0]);
  check(remote.length === 0, `no remote src/href${remote.length ? ': ' + remote.join(', ') : ''}`);
  check(!/<link\b/i.test(html), 'no <link> elements, so no external stylesheet or font');
  check(!/@import/i.test(html), 'no CSS @import');
  check(!/\bfetch\s*\(/.test(html), 'the page makes no network requests of its own');
  check(/@media \(prefers-color-scheme: dark\)/.test(html), 'prefers-color-scheme dark block present');
  check(/:root\[data-theme="dark"\]/.test(html) && /:root\[data-theme="light"\]/.test(html),
    'both data-theme overrides present');
  check(consoleErrors.length === 0,
    `no console or page errors${consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''}`);
} catch (err) {
  fails.push(`exception: ${err.message}`);
} finally {
  await browser.close();
  server.close();
}

for (const m of oks) console.log(`  ok    ${m}`);
for (const m of fails) console.log(`  FAIL  ${m}`);
console.log(`${oks.length} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
