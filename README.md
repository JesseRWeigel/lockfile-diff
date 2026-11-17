# lockfile-diff

**[Open the live page](https://jesserweigel.github.io/lockfile-diff/)**

A lockfile diff is thousands of unreadable lines, so reviewers approve it blind. This is a CLI
and a GitHub Action that reads `package-lock.json` or `pnpm-lock.yaml` on both sides of a pull
request and posts a comment answering the five questions a reviewer would ask if the answers
were cheap.

Zero runtime dependencies. Node 20 or newer. The only network access is the public npm registry,
and every lookup is cached on disk.

```
npx lockfile-diff old-lock.json new-lock.json
node bin/lockfile-diff.js --repo . --base main --head HEAD --path package-lock.json --format md
```

## The five questions, and how each one is answered

**1. What is new?** Straight from the lockfile. A package name present in head and absent in
base is new; a new version of a name that already existed is listed separately, because those
are different facts.

**2. What changed major?** Semver comparison of the two version strings. A version that is not
semver (`file:`, `link:`, `workspace:`, a git URL, a tarball URL, or a missing version field) is
reported as UNCLASSIFIED with the reason, and is never quietly rounded down to a patch. Section 2
also collects downgrades and 0.x minor bumps, because a minor bump below 1.0.0 is a breaking
change under npm's caret ranges.

**3. What changed transitively?** This is the one lockfiles bury, and the one this tool works
hardest at. For npm, a package is direct when the root or a workspace manifest inside
`packages[""]` names it and the entry sits at the top of that importer's `node_modules`. For
pnpm, the `importers` block records the exact resolved version of every direct dependency, so
the answer is exact. The consequence in both cases is that one package can be direct at 7.x and
transitive at 6.x under some other package at the same time, and those produce two rows with
different scopes rather than one confused row.

**4. What changed maintainer?** From the npm registry's per-version manifest: the `maintainers`
list and the `_npmUser` who published that version. A package that changed hands between the two
versions is the highest-signal supply-chain warning the public registry offers. A roster change
is reported as CHANGED; the same roster with a different publishing account is reported as
PUBLISHER CHANGED, which is a weaker signal and gets its own label. A lookup that fails, for any
reason, is UNKNOWN with the reason attached. It is never reported as "no maintainer change",
because "we could not check" and "we checked and it is fine" are different facts.

The approach is borrowed from the sibling project
[npm-handoff-watch](../npm-handoff-watch), which detects handoffs from the same fields. It is
reimplemented here rather than imported, because that project is a separate Python repo and
reaching across project boundaries would couple two things that should stay independently
runnable.

**5. Total install size delta?** The sum of `dist.unpackedSize` from the registry. Three caveats
are printed with the number rather than buried here:

- It is unpacked tarball size as the registry measured it at publish time. It is not the size of
  `node_modules` on disk: no dedup, no peer resolution, no install-script output.
- A version with no `unpackedSize` field contributes zero, which makes the total a
  **lower bound**, and the count of such versions is printed next to it.
- Platform-specific optional packages (prebuilt binaries constrained by `os`/`cpu`/`libc`) are
  listed once per platform and installed at most one per set, so they are totalled separately.
  A real diff in `docs/` moves +52.86 MB overall, of which +234.49 MB is 49 platform-specific
  binaries; excluding them the delta is -181.64 MB.

## Formats and versions verified

| Format | Versions | Verified against |
|---|---|---|
| `package-lock.json` | 1, 2, 3 | hand-built v2 and v3 pairs with an asserted row-by-row answer, plus real v3 lockfiles from four of Jesse's repos |
| `pnpm-lock.yaml` | 6.0, 9.0 (5.x dep-path style accepted) | hand-built v6 and v9 pairs with an asserted answer, plus a real 881-package v9 lockfile |

The two npm versions really do differ: v2 carries both the flat `packages` map and the legacy
nested `dependencies` tree, and v3 carries only `packages`. This reader treats `packages` as
authoritative in both and cross-checks v2's legacy tree, warning if a lockfile contradicts
itself. A v2 lockfile and a v3 lockfile describing the same install diff to zero changes, which
is the test that the v2 path is not reading something else.

The two pnpm versions differ more. v6 writes dep paths as `/name@1.2.3`, keeps the dependency
graph inside `packages`, and records `dev:` on each entry. v9 drops the leading slash, moves the
graph into a separate `snapshots` map keyed by the full peer-suffixed dep path, and records no
`dev` field at all, so dev-only status has to be derived by walking the graph from the production
roots.

### YAML

`pnpm-lock.yaml` is parsed by a focused parser in `src/yaml.js` rather than by a YAML library. The project
has zero runtime dependencies on purpose: a lockfile diff Action that pulls in a dependency tree
to read lockfiles is a slightly absurd object, and its audience is people who care about that.
pnpm writes with js-yaml in a deliberately narrow style, so the accepted grammar is small and
enumerated in the module docstring. Anything outside it (anchors, aliases, block scalars,
multi-document markers, tabs, complex keys) throws rather than being guessed at. The parser is
checked against a real 4,300-line pnpm lockfile, with its package count cross-checked by an
independent count taken from the raw text.

## Usage

```
lockfile-diff <base-lockfile> <head-lockfile> [options]
lockfile-diff --repo <dir> --base <ref> --head <ref> --path <lockfile> [options]

  --format md|text|json     output format (default: md)
  --out FILE                write to FILE instead of stdout
  --cache-dir DIR           registry cache (default: ~/.cache/lockfile-diff)
  --no-registry             skip the registry; maintainer and size become UNKNOWN
  --refresh                 bypass saved registry entries (incompatible with --offline/--no-registry)
  --offline                 use only the cache; a miss is UNKNOWN, never "no change"
  --fail-on LIST            gates: major, downgrade, maintainer, new, any
```

Exit codes: `0` ran and produced a diff, `1` could not run (bad usage, unreadable file,
malformed lockfile), `2` ran and a `--fail-on` gate matched. A malformed lockfile never produces
an empty diff and exit 0.

### As a GitHub Action

Add this to `.github/workflows/lockfile-review.yml` **in the repository you want to
check**. The full commit SHA pins the public Lockfile Diff action; the action reads the
base and head lockfiles with `git show`, so fetch their history. It does not install
packages from the pull request.

```yaml
name: Lockfile review
on:
  pull_request:
    paths:
      - '**/package-lock.json'
permissions:
  contents: read
jobs:
  lockfile-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Diff the lockfile
        uses: JesseRWeigel/lockfile-diff@e338f03c25722e9b8751ac26cb40fa112fc71ae5
        with:
          path: package-lock.json
          comment: 'false'
          # fail-on: maintainer  # optional; summary is still produced before gating
```

This workflow uses only a read-only token. Repository settings may require approval
before a fork PR workflow can run. Read the report in the run's **Summary**; the
action also exposes `markdown-file`, `json-file`, and `changes` outputs. To use pnpm,
change both the path filter and the action's `path` to `pnpm-lock.yaml`, or use the
repository-relative lockfile path for a nested project. Run each lockfile separately.
When calling the action more than once in one job, copy each Markdown and JSON report to a
unique path before the next call. The pinned action reuses its report filenames; separate
jobs also keep the reports isolated.

On trusted same-repository PRs, the action can write a comment if the caller explicitly
grants `pull-requests: write` and enables `comment: 'true'`. At the pinned revision,
attempting to comment without that permission can fail the step even though the summary
has already been written. Keep comments disabled for fork PRs; don't switch to
`pull_request_target` to get a write token. The workflow in this repository uses
`uses: ./` to test its own checkout; consuming workflows use the remote reference above.

## Registry cache freshness

Online lookups reuse successful metadata for 24 hours and failed lookups for 60 seconds.
Network errors, timeouts, 404, 429 and 5xx responses remain UNKNOWN during that backoff;
the next lookup after expiry retries once. There is no background retry loop. Both memory
and disk entries expire, and records include a fetch timestamp and HTTP status (null if no
response arrived). Old records without timestamps refresh on their next online lookup.

Use `--refresh` to bypass saved entries for a run, or set the Action input `refresh: 'true'`.
Concurrent requests for the same version still share one fetch. The Action renders its JSON
and failure gates from the cache snapshot used by the Markdown report, avoiding extra requests.
`--offline` deliberately reads saved snapshots regardless of age, including legacy fixtures;
it does not claim current registry metadata. It cannot be combined with `--refresh`.
`--no-registry` also cannot be combined with `--refresh`. Library callers can set
`successTtlMs` and `failureTtlMs` to finite nonnegative millisecond values.

## Status

Verified by `bash scripts/verify.sh`. Real output from the run below.

```text
0. environment
        node v22.22.0
  ok    node present

1. unit suite
  ok    69 of 69 unit tests passed

2. hand-built pairs: the EXACT classification of every change, per format and version
  ok    package-lock.json v3: all 15 changes classified exactly as specified
  ok    package-lock.json v2: all 4 changes classified exactly as specified
  ok    pnpm-lock.yaml v9.0: all 12 changes classified exactly as specified
  ok    pnpm-lock.yaml v6.0: all 7 changes classified exactly as specified

3. DIRECT versus TRANSITIVE, the classification most likely to be quietly wrong
  ok    one package, two versions: semver 7.5.4->7.6.0 is DIRECT, semver 6.3.0->6.3.1 is TRANSITIVE
  ok    pnpm reaches the same verdict from its importer pins

4. every semver shape classifies as itself, and non-semver never becomes a patch
  ok    major, minor, patch, prerelease, 0.x, git, link:, file: and a missing version all correct

5. NEGATIVE CONTROL: a lockfile diffed against ITSELF must report zero changes
  ok    18 lockfiles (7976 package entries in total) each diffed to zero changes

6. malformed and truncated lockfiles exit nonzero, never an empty diff and exit 0
  ok    14 of 14 malformed lockfiles rejected with a message and a nonzero exit

7. real diffs from real repositories, read straight out of git
        jesseweigel.com portfolio rebuild       154 changes,  11 direct, 143 transitive,  0 major
  ok    jesseweigel.com portfolio rebuild: 154 changes, 11 of them direct
        scribble adds vitest                     66 changes,   2 direct,  64 transitive,  0 major
  ok    scribble adds vitest: 66 changes, 2 of them direct
        language-learning-app (pnpm v9)           1 changes,   1 direct,   0 transitive,  0 major
  ok    language-learning-app (pnpm v9): 1 changes, 1 of them direct
        toryo workspace rename                    6 changes,   4 direct,   2 transitive,  0 major
  ok    toryo workspace rename: 6 changes, 4 of them direct

7b. the direct dependencies reported for a real diff match that repo's package.json
        11 direct changes, exactly the set package.json changed
  ok    direct-dependency set independently confirmed against package.json

8. registry answers: maintainer handoffs and install size, offline from the committed cache
  ok    handoffs, publisher changes, UNKNOWNs and the size lower bound are all as recorded

9. live registry check (informational, never gates this script)
        live abbrev 1.1.1 maintainers [gabra,isaacs] -> 2.0.0 [darcyclarke,fritzy,gar,lukekarrys,nlf]
handoff still visible live
        (the suite does not depend on this; a failed lookup is reported UNKNOWN)

10. self-attack: the checks above must FAIL when the engine is broken
        sabotage "empty-parse" output: 0 packages -> 0 packages no changes 
  ok    sabotage "empty-parse" demonstrably changed the tool's output (no changes)
        sabotage "empty-parse": unit suite exit 1, direct/transitive check exit 1
  ok    sabotage "empty-parse": unit suite FAILED as it must (exit 1, 25 failing tests)
  ok    sabotage "empty-parse": section 3's direct/transitive check FAILED as it must (exit 1)
        sabotage "always-patch" output: 15 packages -> 15 packages 15 changes: 1 new, 1 removed, 12 bumped (0 major, 0 minor, 12 patch, 0 prerelease, 0 unclassified), 10 direct, 5 transitive 
  ok    sabotage "always-patch" demonstrably changed the tool's output (0 major)
        sabotage "always-patch": unit suite exit 1, direct/transitive check exit 1
  ok    sabotage "always-patch": unit suite FAILED as it must (exit 1, 16 failing tests)
  ok    sabotage "always-patch": section 3's direct/transitive check FAILED as it must (exit 1)

11. docs/index.html loads in a real browser and renders from its own script
        browser checks passed: 48
        48 passed, 0 failed
  ok    docs/index.html verified in Chromium at 1280px and 390px

12. docs/index.html is exactly what build-docs.mjs produces from docs/data.json
  ok    docs/index.html is reproducible from its data

13. docs/data.json still matches a live re-derivation from the real repositories
        2 committed datasets re-derived and matched
  ok    the published page's numbers still match the repositories they came from

14. no absolute home paths, no secrets, no NUL bytes in tracked files
  ok    no absolute home paths in tracked files
  ok    no credential-shaped strings in tracked files
  ok    no tracked file contains a NUL byte, so the scans above could read all of them
  ok    no tracked file is over 1 MB

15. the README describes what this script actually does
  ok    README.md has a Status section carrying real verify output
  ok    README.md's claim of 69 unit tests matches this run

lockfile-diff: 69 unit tests, 18 lockfiles self-diffed to zero changes, 14 malformed inputs rejected
32 passed, 0 failed
VERIFY OK
```

## A real diff from a real repository

`jesseweigel.com`, commit `f2c8564` to `a6deb9d`, the commit that rebuilt the portfolio and
dropped Three.js. git shows 2,233 changed lines in `package-lock.json`. The Action posts this
(tables truncated to five rows here with `--max-rows 5`):

````markdown
### Lockfile diff: jesseweigel.com f2c8564..a6deb9d

`package-lock.json v3` · 964 packages -> 940 packages

**154 changes.** 32 new, 55 removed, 64 bumped (**0 major**, 32 minor, 32 patch). 11 touch a direct dependency, 143 are transitive.

#### 1. What is new? (33)

| Package | Version | Change | Scope | Maintainers | Size |
|---|---|---|---|---|---|
| `@emnapi/core` | 1.11.2 | NEW | transitive (dev) | new: toyobayashi | +1.94 MB |
| `@emnapi/runtime` | 1.11.2 | NEW | transitive | new: toyobayashi | +423.4 KB |
| `@esbuild/aix-ppc64` | 0.28.1 | NEW | transitive (dev) | new: esbuild | +12.01 MB |
| `@esbuild/android-arm` | 0.28.1 | NEW | transitive (dev) | new: esbuild | +13.32 MB |
| `@esbuild/android-arm64` | 0.28.1 | NEW | transitive (dev) | new: esbuild | +11.00 MB |

...and 28 more.

#### 2. What changed major? (1)

| Package | Version | Change | Scope | Maintainers | Size |
|---|---|---|---|---|---|
| `@oxc-project/types` | 0.122.0 -> 0.139.0 | minor | transitive (dev) | unchanged | +76 B |

1 of these is a 0.x minor bump (`@oxc-project/types`). A minor bump below 1.0.0 is a breaking change under npm caret ranges, so they are listed here rather than under minor.

#### 3. What changed transitively? (143)

143 of 154 changes are to packages nothing in this repo depends on directly. They arrived through some other package's dependency range.

<details><summary>Show transitive changes</summary>

(five of 143 rows, elided here for length; the full table is in the comment)

</details>

#### 4. What changed maintainer? (20)

A package that changed hands between the two versions is the highest-signal supply-chain warning the public registry offers. Look at these first.

| Package | Version | Change | Scope | Maintainers | Size |
|---|---|---|---|---|---|
| `@babel/helper-globals` | 7.28.0 -> 7.29.7 | minor | transitive (dev) | **PUBLISHER CHANGED** nicolo-ribaudo -> GitHub Actions | 0 B |
| `@babel/helper-string-parser` | 7.27.1 -> 7.29.7 | minor | transitive (dev) | **PUBLISHER CHANGED** nicolo-ribaudo -> GitHub Actions | 0 B |
| `@babel/helper-validator-option` | 7.27.1 -> 7.29.7 | minor | transitive (dev) | **PUBLISHER CHANGED** nicolo-ribaudo -> GitHub Actions | 0 B |
| `postcss` | 8.4.31 -> 8.5.19 | minor | transitive | **PUBLISHER CHANGED** ai -> GitHub Actions | +17.9 KB |
| `vite` | 8.0.3 -> 8.1.4 | minor | transitive (dev) | **CHANGED** (out: antfu, patak) | +63.3 KB |
| `@next/env` | 16.2.1 -> 16.2.10 | patch | transitive | **CHANGED** (out: rauchg, timer, timneutkens) | -54 B |
| `@next/eslint-plugin-next` | 16.2.1 -> 16.2.10 | patch | transitive (dev) | **CHANGED** (out: rauchg, timer, timneutkens) | -54 B |
| `@next/swc-darwin-arm64` | 16.2.1 -> 16.2.10 | patch | transitive | **CHANGED** (out: rauchg, timer, timneutkens) | +145.8 KB |
| `@next/swc-darwin-x64` | 16.2.1 -> 16.2.10 | patch | transitive | **CHANGED** (out: rauchg, timer, timneutkens) | +108.5 KB |
| `@next/swc-linux-arm64-gnu` | 16.2.1 -> 16.2.10 | patch | transitive | **CHANGED** (out: rauchg, timer, timneutkens) | +145.4 KB |
| `@next/swc-linux-arm64-musl` | 16.2.1 -> 16.2.10 | patch | transitive | **CHANGED** (out: rauchg, timer, timneutkens) | +142.1 KB |
| `@next/swc-linux-x64-gnu` | 16.2.1 -> 16.2.10 | patch | transitive | **CHANGED** (out: rauchg, timer, timneutkens) | +149.5 KB |
| `@next/swc-linux-x64-musl` | 16.2.1 -> 16.2.10 | patch | transitive | **CHANGED** (out: rauchg, timer, timneutkens) | +137.4 KB |
| `@next/swc-win32-arm64-msvc` | 16.2.1 -> 16.2.10 | patch | transitive | **CHANGED** (out: rauchg, timer, timneutkens) | +103.0 KB |
| `@next/swc-win32-x64-msvc` | 16.2.1 -> 16.2.10 | patch | transitive | **CHANGED** (out: rauchg, timer, timneutkens) | +166.0 KB |
| `eslint-config-next` | 16.2.1 -> 16.2.10 | patch | direct (dev) | **PUBLISHER CHANGED** vercel-release-bot -> GitHub Actions | -53 B |
| `fast-uri` | 3.1.0 -> 3.1.3 | patch | transitive (dev) | **PUBLISHER CHANGED** gurgunday -> matteo.collina | +11.1 KB |
| `hono` | 4.12.9 -> 4.12.30 | patch | transitive (dev) | **PUBLISHER CHANGED** yusukebe -> GitHub Actions | -9.5 KB |
| `nanoid` | 3.3.11 -> 3.3.16 | patch | transitive | **PUBLISHER CHANGED** ai -> GitHub Actions | -7.7 KB |
| `next` | 16.2.1 -> 16.2.10 | patch | direct | **CHANGED** (in: matheuss, matt.straka) | +835.7 KB |

#### 5. Total install size delta

**+52.86 MB** (added 1665.91 MB, removed 1613.05 MB). Measured as the sum of dist.unpackedSize from the npm registry, which is unpacked tarball size and not node_modules on disk. +234.49 MB of that is 49 platform-specific optional package(s): prebuilt binaries listed once per os/cpu, of which an install downloads at most one from each set. The headline number therefore overstates what any single machine pulls. Excluding them the delta is **-181.64 MB**. This is a **lower bound**: 4 version(s) had no `dist.unpackedSize` in the registry and contribute 0 to the total rather than being guessed at.

<details><summary>Everything else (6)</summary>

| Package | Version | Change | Scope | Maintainers | Size |
|---|---|---|---|---|---|
| `@react-three/drei` | 10.7.7 | GONE | direct | n/a | -1.67 MB |
| `@react-three/fiber` | 9.5.0 | GONE | direct | n/a | -2.07 MB |
| `@types/three` | 0.183.1 | GONE | direct | n/a | -1.72 MB |
| `framer-motion` | 12.38.0 | GONE | direct | n/a | -4.51 MB |
| `lucide-react` | 1.7.0 | GONE | direct | n/a | -28.45 MB |

...and 1 more.

</details>

<sub>lockfile-diff · registry: 0 fetched, 218 cached, 0 unknown</sub>
````

## Limitations

- **The size number is unpacked tarball size.** See question 5 above. Treat it as a comparative
  signal. It does not measure what lands in your `node_modules`.
- **Registry lookups are per version, over the public registry.** A private or scoped-to-a-org
  package returns 404 and is reported UNKNOWN. There is no auth support yet; `--registry` points
  at a different base URL but sends no token.
- **`maintainers` is the roster recorded on that version's manifest.** npm backfills it in ways
  that are not fully documented, so a CHANGED verdict is a reason to look, not proof of a
  compromise. The `three` example in the fixtures is a normal case of two co-maintainers taking
  turns publishing.
- **Install scripts are detected but not surfaced as their own section.** `hasInstallScript` is
  parsed and counted (`counts.newInstallScripts` in the JSON output) but does not yet get a
  heading in the comment. The catalog task lists it as a sixth question and it is not done.
- **npm lockfileVersion 1 is read but degraded.** v1 files carry no manifest, so "direct" falls
  back to "at the top of `node_modules`" and a warning says so.
- **Directness for npm is a rule rather than a full resolver.** A direct dependency that npm was forced to
  place deeper than the top level (a version conflict with a hoisted copy) is found by falling
  back to the shallowest entry with that name, and a warning is recorded. This has not been seen
  in any of the real lockfiles tested here.
- **Cross-manager diffs are refused.** Comparing a `package-lock.json` against a
  `pnpm-lock.yaml` exits 1 rather than producing a half-meaningful answer.
- **No pnpm `patchedDependencies` handling.** A patched dependency is diffed on its version only,
  so a changed patch file with an unchanged version is invisible.

## Tests

```
node --test test/*.test.js     # the unit suite
bash scripts/verify.sh          # everything, including two sabotages and a real browser
```


- 69 unit tests, built around the ways this tool could be quietly wrong.
- Hand-built lockfile **pairs with a known answer** for every format and version, asserting the
  exact classification of every change rather than a count.
- A fixture where one package is **both a direct dependency and buried deep in the tree**, at two
  different versions, both moving.
- A major, a minor, a patch, a prerelease, a 0.x minor, a `file:`, a `link:`, a git URL and a
  missing version, each asserted to classify as itself.
- A **negative control**: 17 lockfiles, including seven real ones, each diffed against itself and
  required to report zero changes. This catches the likeliest bug, a parser that misreads and
  invents churn.
- 14 malformed and truncated lockfiles, each required to exit nonzero with a message.
- All registry results come from a **committed cache** and the tests inject a `fetch` that
  throws, so the suite cannot pass because of the network or fail because of it. A live check
  exists in `verify.sh` and is informational only.
- Two **sabotages** in `verify.sh`: the parser is stubbed to return an empty dependency set, and
  every version comparison is stubbed to return "patch". Each is proved to change real output
  before anything is concluded, and the suite must fail under both.
- The docs page is loaded in a real Chromium at 1280px and 390px, and every assertion is on a
  node the page's own script had to build.

`docs/index.html` is a single self-contained file with no remote assets, built from
`docs/data.json` by `scripts/build-docs.mjs`. `scripts/build-data.mjs` regenerates that data from
real repositories and the live registry; it is the only step that needs the network, so
`verify.sh` instead re-derives the change counts with `--no-registry` and asserts they still
match what is committed.

## License

MIT

Part of [722 things to build](https://github.com/JesseRWeigel/722-things-to-build).
