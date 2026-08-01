#!/usr/bin/env bash
# Verification for lockfile-diff.
#
# The failure this project is most likely to have is a parser that misreads a lockfile and
# reports plausible-looking churn, or none at all, with nobody noticing. So the checks are
# arranged around that:
#
#   - a hand-built pair per format and version whose EXACT answer is asserted row by row,
#     not counted;
#   - the direct-versus-transitive fixture, where one package is both at once;
#   - a negative control: every lockfile in reach diffed against ITSELF must report zero
#     changes, including seven real ones from Jesse's repos;
#   - malformed input must exit nonzero rather than produce an empty diff;
#   - two sabotages, each proved to change real output BEFORE the verify is re-run against it.
#
# Everything except the "live registry" section runs offline from the committed cache.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

# Verify output gets pasted into the README, so keep $HOME out of it. Bash tilde-expands the
# replacement, which is why the backslash is not optional.
tilde() { printf '%s' "${1/#$HOME/\~}"; }

pass=0; fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CACHE="$ROOT/test/fixtures/registry-cache"
CLI=(node "$ROOT/bin/lockfile-diff.js")
OFFLINE=(--cache-dir "$CACHE" --offline)

echo "0. environment"
node --version | sed 's/^/        node /'
ok "node present"

echo
echo "1. unit suite"
if node --test test/*.test.js >"$TMP/unit.log" 2>&1; then
  UNIT_TESTS=$(grep -oE '^. tests [0-9]+' "$TMP/unit.log" | tail -1 | grep -oE '[0-9]+')
  UNIT_PASS=$(grep -oE '^. pass [0-9]+' "$TMP/unit.log" | tail -1 | grep -oE '[0-9]+')
  ok "$UNIT_PASS of $UNIT_TESTS unit tests passed"
else
  UNIT_TESTS=0; UNIT_PASS=0
  bad "unit suite"
  grep -E '✖|AssertionError|Error:' "$TMP/unit.log" | head -20 | sed 's/^/        /'
fi

echo
echo "2. hand-built pairs: the EXACT classification of every change, per format and version"
# Each line is one change, checked in full: type, package, versions, semver class, and scope.
# A count would pass with two changes swapped; this will not.
expect_exact() {
  local label="$1" base="$2" head="$3" expected="$4"
  local got
  got=$("${CLI[@]}" "$base" "$head" "${OFFLINE[@]}" --format json \
        | python3 -c "
import json,sys
d = json.load(sys.stdin)
rows = []
for c in d['changes']:
    rows.append('%s %s %s>%s %s %s' % (
        c['type'], c['name'], c.get('from') or c.get('version'), c.get('to') or '-',
        c.get('kind') or '-', c['scope']))
print('\n'.join(sorted(rows)))
") || { bad "$label: the CLI failed"; return; }
  if [ "$got" = "$(printf '%s' "$expected")" ]; then
    ok "$label: all $(printf '%s\n' "$expected" | wc -l) changes classified exactly as specified"
  else
    bad "$label: classification differs"
    diff <(printf '%s\n' "$expected") <(printf '%s\n' "$got") | head -20 | sed 's/^/        /'
  fi
}

NPM_V3_EXPECTED='added picocolors 1.0.1>- - transitive
bumped @polka/url 1.0.0-next.25>1.0.0-next.29 prerelease direct
bumped abbrev 1.1.1>2.0.0 major transitive
bumped gitdep git:git+ssh://git@github.com/example/gitdep.git#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa>git:git+ssh://git@github.com/example/gitdep.git#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb unclassifiable direct
bumped local-ui link:packages/ui>link:packages/ui-next unclassifiable direct
bumped ms 2.1.2>2.1.3 patch transitive
bumped nover 1.0.0><no version> unclassifiable transitive
bumped rimraf 2.7.1>5.0.5 major direct
bumped semver 6.3.0>6.3.1 patch transitive
bumped semver 7.5.4>7.6.0 minor direct
bumped three 0.183.2>0.184.0 minor direct
bumped uuid 3.4.0>9.0.1 major direct
bumped vendored file:vendor/vendored-1.0.0.tgz>file:vendor/vendored-1.0.1.tgz unclassifiable direct
removed glob 7.2.3>- - direct
scope-changed picomatch 2.3.1>- - direct'

PNPM_V9_EXPECTED='added picocolors 1.0.1>- - transitive
bumped @polka/url 1.0.0-next.25>1.0.0-next.29 prerelease direct
bumped abbrev 1.1.1>2.0.0 major transitive
bumped local-ui link:packages/ui>link:packages/ui-next unclassifiable direct
bumped ms 2.1.2>2.1.3 patch transitive
bumped rimraf 2.7.1>5.0.5 major direct
bumped semver 6.3.0>6.3.1 patch transitive
bumped semver 7.5.4>7.6.0 minor direct
bumped three 0.183.2>0.184.0 minor direct
bumped uuid 3.4.0>9.0.1 major direct
removed glob 7.2.3>- - direct
scope-changed picomatch 2.3.1>- - direct'

PNPM_V6_EXPECTED='added picocolors 1.0.1>- - transitive
bumped abbrev 1.1.1>2.0.0 major transitive
bumped ms 2.1.2>2.1.3 patch transitive
bumped rimraf 2.7.1>5.0.5 major direct
bumped semver 6.3.0>6.3.1 patch transitive
bumped semver 7.5.4>7.6.0 minor direct
removed glob 7.2.3>- - transitive'

NPM_V2_EXPECTED='added picocolors 1.0.1>- - transitive
bumped ms 2.1.2>2.1.3 patch direct
bumped rimraf 2.7.1>5.0.5 major direct
removed glob 7.2.3>- - transitive'

expect_exact "package-lock.json v3" test/fixtures/npm-v3/base.json test/fixtures/npm-v3/head.json "$NPM_V3_EXPECTED"
expect_exact "package-lock.json v2" test/fixtures/npm-v2/base.json test/fixtures/npm-v2/head.json "$NPM_V2_EXPECTED"
expect_exact "pnpm-lock.yaml v9.0"  test/fixtures/pnpm-v9/base.yaml test/fixtures/pnpm-v9/head.yaml "$PNPM_V9_EXPECTED"
expect_exact "pnpm-lock.yaml v6.0"  test/fixtures/pnpm-v6/base.yaml test/fixtures/pnpm-v6/head.yaml "$PNPM_V6_EXPECTED"

echo
echo "3. DIRECT versus TRANSITIVE, the classification most likely to be quietly wrong"
# semver is a direct dependency at 7.x and simultaneously buried under eslint at 6.x, and both
# move. A name-keyed reader reports one row and is wrong about half of it.
dt=$("${CLI[@]}" test/fixtures/direct-transitive/base.json test/fixtures/direct-transitive/head.json \
     "${OFFLINE[@]}" --format json)
if printf '%s' "$dt" | python3 -c "
import json,sys
d = json.load(sys.stdin)
by = {c['from']: c for c in d['changes']}
assert len(d['changes']) == 2, d['changes']
assert by['7.5.4']['scope'] == 'direct', by['7.5.4']
assert by['7.5.4']['kind'] == 'minor', by['7.5.4']
assert by['6.3.0']['scope'] == 'transitive', by['6.3.0']
assert by['6.3.0']['kind'] == 'patch', by['6.3.0']
assert by['7.5.4']['name'] == by['6.3.0']['name'] == 'semver'
"; then
  ok "one package, two versions: semver 7.5.4->7.6.0 is DIRECT, semver 6.3.0->6.3.1 is TRANSITIVE"
else
  bad "direct/transitive split is wrong"
  printf '%s' "$dt" | head -40 | sed 's/^/        /'
fi
# The same distinction, expressed the pnpm way (the importer pins exact versions).
if "${CLI[@]}" test/fixtures/pnpm-v9/base.yaml test/fixtures/pnpm-v9/head.yaml "${OFFLINE[@]}" \
   --format json | python3 -c "
import json,sys
d = json.load(sys.stdin)
s = {c['from']: c['scope'] for c in d['changes'] if c['name'] == 'semver'}
assert s == {'7.5.4': 'direct', '6.3.0': 'transitive'}, s
"; then ok "pnpm reaches the same verdict from its importer pins"
else bad "pnpm direct/transitive split is wrong"; fi

echo
echo "4. every semver shape classifies as itself, and non-semver never becomes a patch"
if "${CLI[@]}" test/fixtures/npm-v3/base.json test/fixtures/npm-v3/head.json "${OFFLINE[@]}" \
   --format json | python3 -c "
import json,sys
d = json.load(sys.stdin)
k = {c['name']: c for c in d['changes'] if c['type'] == 'bumped'}
assert k['rimraf']['kind'] == 'major'
assert k['semver']['kind'] in ('minor', 'patch')
assert k['three']['kind'] == 'minor' and k['three']['zeroMajor'] is True
assert k['ms']['kind'] == 'patch'
assert k['@polka/url']['kind'] == 'prerelease'
for name, phrase in [('gitdep', 'git'), ('local-ui', 'link:'), ('vendored', 'file:'), ('nover', 'missing')]:
    assert k[name]['kind'] == 'unclassifiable', (name, k[name]['kind'])
    assert phrase in k[name]['reason'], (name, k[name]['reason'])
"; then
  ok "major, minor, patch, prerelease, 0.x, git, link:, file: and a missing version all correct"
else
  bad "a version shape classified wrongly"
fi

echo
echo "5. NEGATIVE CONTROL: a lockfile diffed against ITSELF must report zero changes"
# The most likely bug is a parser that misreads and invents churn. Real lockfiles, not fixtures,
# because the fixtures were written by the same person who wrote the parser.
self_diff_ran=0
self_diff_pkgs=0
for lock in "$HOME"/Projects/*/package-lock.json "$HOME"/Projects/*/pnpm-lock.yaml \
            "$ROOT"/test/fixtures/real/*; do
  [ -f "$lock" ] || continue
  line=$("${CLI[@]}" "$lock" "$lock" --no-registry --format text 2>&1) || {
    bad "self-diff of $(tilde "$lock") did not exit 0"; continue; }
  n=$(printf '%s\n' "$line" | sed -n '2p' | grep -oE '^[0-9]+')
  if printf '%s\n' "$line" | grep -q '^no changes$'; then
    self_diff_ran=$((self_diff_ran+1))
    self_diff_pkgs=$((self_diff_pkgs + ${n:-0}))
  else
    bad "self-diff of $(tilde "$lock") reported changes"
    printf '%s\n' "$line" | head -5 | sed 's/^/        /'
  fi
done
if [ "$self_diff_ran" -ge 8 ]; then
  ok "$self_diff_ran lockfiles ($self_diff_pkgs package entries in total) each diffed to zero changes"
else
  bad "only $self_diff_ran lockfiles were available for the self-diff control, expected at least 8"
fi

echo
echo "6. malformed and truncated lockfiles exit nonzero, never an empty diff and exit 0"
mal_ok=0; mal_total=0
for f in test/fixtures/malformed/*; do
  mal_total=$((mal_total+1))
  set +e
  out=$("${CLI[@]}" "$f" "$f" --no-registry 2>"$TMP/mal.err")
  rc=$?
  set -e
  if [ "$rc" -ne 0 ] && [ -z "$out" ] && grep -q 'lockfile-diff: ' "$TMP/mal.err"; then
    mal_ok=$((mal_ok+1))
  else
    bad "$(basename "$f") exited $rc with $(printf '%s' "$out" | wc -c) bytes of stdout"
  fi
done
if [ "$mal_ok" -eq "$mal_total" ] && [ "$mal_total" -ge 10 ]; then
  ok "$mal_ok of $mal_total malformed lockfiles rejected with a message and a nonzero exit"
else
  bad "only $mal_ok of $mal_total malformed lockfiles were rejected"
fi

echo
echo "7. real diffs from real repositories, read straight out of git"
# label|repo|base|head|lockfile|expected total changes|expected direct changes
REAL_CASES=(
  "jesseweigel.com portfolio rebuild|$HOME/Projects/jesseweigel.com|f2c8564|a6deb9d|package-lock.json|154|11"
  "scribble adds vitest|$HOME/Projects/scribble|c40f012|7300d93|package-lock.json|66|2"
  "language-learning-app (pnpm v9)|$HOME/Projects/language-learning-app|2068c04|8ae6855|pnpm-lock.yaml|1|1"
  "toryo workspace rename|$HOME/Projects/toryo|790b2b4|30d679f|package-lock.json|6|4"
)
real_ran=0
for case in "${REAL_CASES[@]}"; do
  IFS='|' read -r label repo base head lock want_total want_direct <<<"$case"
  if [ ! -d "$repo/.git" ]; then
    bad "$label: $(tilde "$repo") is not a git repository, so the tool was not exercised on real data"
    continue
  fi
  if ! "${CLI[@]}" --repo "$repo" --base "$base" --head "$head" --path "$lock" \
       --no-registry --format json >"$TMP/real.json" 2>"$TMP/real.err"; then
    bad "$label: run failed"
    head -3 "$TMP/real.err" | sed 's/^/        /'
    continue
  fi
  read -r got_total got_direct got_major got_trans <<<"$(python3 -c "
import json
d = json.load(open('$TMP/real.json'))
c = d['counts']
print(c['total'], c['direct'], c['major'], c['transitive'])
")"
  printf '        %-38s %4s changes, %3s direct, %3s transitive, %2s major\n' \
    "$label" "$got_total" "$got_direct" "$got_trans" "$got_major"
  if [ "$got_total" = "$want_total" ] && [ "$got_direct" = "$want_direct" ]; then
    ok "$label: $got_total changes, $got_direct of them direct"
  else
    bad "$label: expected $want_total changes and $want_direct direct, got $got_total and $got_direct"
  fi
  real_ran=$((real_ran+1))
done
[ "$real_ran" -gt 0 ] || bad "no real repository was reachable, so nothing was verified against real data"

echo
echo "7b. the direct dependencies reported for a real diff match that repo's package.json"
# An independent recount: git diff the manifest and compare the names, so the tool is checked
# against the actual source of truth rather than against itself.
if python3 - "$HOME/Projects/jesseweigel.com" f2c8564 a6deb9d "$TMP/real-jw.json" <<'PY'
import json, subprocess, sys
repo, base, head, out = sys.argv[1:5]
subprocess.run(['node', 'bin/lockfile-diff.js', '--repo', repo, '--base', base, '--head', head,
                '--path', 'package-lock.json', '--no-registry', '--format', 'json', '--out', out],
               check=True)
report = json.load(open(out))
tool = {c['name'] for c in report['changes'] if c['scope'] == 'direct'}

def manifest(ref):
    text = subprocess.run(['git', '-C', repo, 'show', f'{ref}:package.json'],
                          capture_output=True, text=True, check=True).stdout
    doc = json.loads(text)
    deps = {}
    for field in ('dependencies', 'devDependencies', 'optionalDependencies'):
        deps.update(doc.get(field) or {})
    return deps

a, b = manifest(base), manifest(head)
# A direct dependency counts as changed if it was added, removed, or its range moved.
expected = {n for n in set(a) | set(b) if a.get(n) != b.get(n)}
# shadcn moved between dependency sections without changing its range or version, so the
# lockfile records nothing; that is correct and is excluded on both sides.
expected = {n for n in expected if a.get(n) != b.get(n) or n in tool}
missing, extra = expected - tool, tool - expected
assert not missing, f'package.json changed these direct deps but the tool missed them: {sorted(missing)}'
assert not extra, f'the tool called these direct but package.json did not change them: {sorted(extra)}'
assert len(tool) >= 10, f'only {len(tool)} direct changes, the check is too weak'
print(f'        {len(tool)} direct changes, exactly the set package.json changed')
PY
then ok "direct-dependency set independently confirmed against package.json"
else bad "the direct-dependency set disagrees with the repository's package.json"; fi

echo
echo "8. registry answers: maintainer handoffs and install size, offline from the committed cache"
if "${CLI[@]}" test/fixtures/npm-v3/base.json test/fixtures/npm-v3/head.json "${OFFLINE[@]}" \
   --format json | python3 -c "
import json,sys
d = json.load(sys.stdin)
by = {c['name']: c for c in d['changes']}
assert d['registry']['fetched'] == 0, 'the offline run reached the network'
assert d['registry']['cacheHits'] >= 18
# Real handoffs recorded in the registry.
assert by['abbrev']['maintainer']['status'] == 'changed'
assert by['abbrev']['maintainer']['removed'] == ['gabra', 'isaacs']
assert by['uuid']['maintainer']['status'] == 'changed'
assert by['rimraf']['maintainer']['status'] == 'same'
assert by['three']['maintainer']['status'] == 'publisher-changed'
# A lookup that cannot be made is UNKNOWN, never 'same'.
for name in ('gitdep', 'local-ui', 'vendored', 'nover'):
    assert by[name]['maintainer']['status'] == 'unknown', (name, by[name]['maintainer'])
# Real sizes, and an honest lower bound because abbrev 1.1.1 has no unpackedSize.
assert by['rimraf']['size']['delta'] == 277365 - 15463
assert by['abbrev']['size']['delta'] is None
assert d['size']['lowerBound'] is True
measured = sum(c['size']['delta'] for c in d['changes'] if c['size']['delta'] is not None)
assert d['size']['net'] == measured, (d['size']['net'], measured)
"; then
  ok "handoffs, publisher changes, UNKNOWNs and the size lower bound are all as recorded"
else
  bad "registry enrichment is wrong"
fi

echo
echo "9. live registry check (informational, never gates this script)"
set +e
live=$(timeout 40 node -e "
import('./src/registry.js').then(async ({ Registry }) => {
  const r = new Registry({ cacheDir: null, timeoutMs: 15000 });
  const a = await r.manifest('abbrev', '1.1.1');
  const b = await r.manifest('abbrev', '2.0.0');
  if (a.status !== 'ok' || b.status !== 'ok') {
    console.log('unreachable: ' + (a.reason || b.reason));
    return;
  }
  const left = a.manifest.maintainers.join(',');
  const right = b.manifest.maintainers.join(',');
  console.log('live abbrev 1.1.1 maintainers [' + left + '] -> 2.0.0 [' + right + ']');
  console.log(left === right ? 'MATCH-CACHE-MISMATCH' : 'handoff still visible live');
});
" 2>&1)
set -e
printf '        %s\n' "$live" | head -3
echo "        (the suite does not depend on this; a failed lookup is UNKNOWN, not a pass)"

echo
echo "10. self-attack: the checks above must FAIL when the engine is broken"
# Each sabotage is proved to change real output BEFORE anything is concluded from a re-run.
# An attack that turns out to be a no-op makes a correct verify look weak.
attack() {
  local name="$1" file="$2" marker="$3" stub="$4" expect="$5"
  local dir="$TMP/attack-$name"
  rm -rf "$dir"; mkdir -p "$dir"
  tar -cf - --exclude=.git --exclude=node_modules --exclude=.cache -C "$ROOT" . | tar -xf - -C "$dir"
  python3 - "$dir/$file" "$marker" "$stub" <<'PY'
import sys
path, marker, stub = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).read().split('\n')
for i, line in enumerate(lines):
    if marker in line:
        indent = ' ' * (len(line) - len(line.lstrip()))
        lines.insert(i + 1, indent + stub)
        open(path, 'w').write('\n'.join(lines))
        sys.exit(0)
sys.exit(f'marker {marker!r} not found in {path}')
PY

  # STEP ONE: look at the sabotaged tool's real output and confirm it is now wrong.
  local observed
  observed=$( (cd "$dir" && node bin/lockfile-diff.js test/fixtures/npm-v3/base.json \
      test/fixtures/npm-v3/head.json --no-registry --format text 2>&1) | sed -n '2,3p' | tr '\n' ' ')
  printf '        sabotage "%s" output: %s\n' "$name" "$observed"
  if printf '%s' "$observed" | grep -q "$expect"; then
    ok "sabotage \"$name\" demonstrably changed the tool's output ($expect)"
  else
    bad "sabotage \"$name\" was a NO-OP: output still reads \"$observed\". Nothing can be concluded."
    return
  fi

  # STEP TWO: only now is a passing verify meaningful.
  local urc erc
  set +e
  ( cd "$dir" && node --test test/*.test.js ) >"$TMP/$name-unit.log" 2>&1
  urc=$?
  ( cd "$dir" && node bin/lockfile-diff.js test/fixtures/direct-transitive/base.json \
      test/fixtures/direct-transitive/head.json --cache-dir "$CACHE" --offline --format json \
      | python3 -c "
import json,sys
d = json.load(sys.stdin)
by = {c['from']: c for c in d['changes']}
assert len(d['changes']) == 2
assert by['7.5.4']['scope'] == 'direct' and by['7.5.4']['kind'] == 'minor'
assert by['6.3.0']['scope'] == 'transitive' and by['6.3.0']['kind'] == 'patch'
" ) >"$TMP/$name-dt.log" 2>&1
  erc=$?
  set -e
  printf '        sabotage "%s": unit suite exit %s, direct/transitive check exit %s\n' "$name" "$urc" "$erc"
  if [ "$urc" -eq 0 ]; then
    bad "sabotage \"$name\": the unit suite still passed, so it does not test the engine"
  else
    ok "sabotage \"$name\": unit suite FAILED as it must (exit $urc, $(grep -cE '^✖' "$TMP/$name-unit.log" || true) failing tests)"
  fi
  if [ "$erc" -eq 0 ]; then
    bad "sabotage \"$name\": section 3's direct/transitive check still passed"
  else
    ok "sabotage \"$name\": section 3's direct/transitive check FAILED as it must (exit $erc)"
  fi
}

attack "empty-parse" "src/npm-lock.js" "SABOTAGE-POINT: buildLockfile" \
  "installed = [];" "no changes"
attack "always-patch" "src/semver.js" "SABOTAGE-POINT: classifyChange" \
  "return { kind: 'patch', direction: 'up', reason: null, zeroMajor: false };" "0 major"

echo
echo "11. docs/index.html loads in a real browser and renders from its own script"
if node scripts/check-page.mjs >"$TMP/page.log" 2>&1; then
  grep -cE '^  ok ' "$TMP/page.log" | sed 's/^/        browser checks passed: /'
  tail -1 "$TMP/page.log" | sed 's/^/        /'
  ok "docs/index.html verified in Chromium at 1280px and 390px"
else
  bad "docs page check failed"
  tail -25 "$TMP/page.log" | sed 's/^/        /'
fi

echo
echo "12. docs/index.html is exactly what build-docs.mjs produces from docs/data.json"
cp docs/index.html "$TMP/index.committed.html"
if node scripts/build-docs.mjs >/dev/null 2>&1 && cmp -s docs/index.html "$TMP/index.committed.html"; then
  ok "docs/index.html is reproducible from its data"
else
  bad "docs/index.html differs from a fresh build; run: node scripts/build-docs.mjs"
  cp "$TMP/index.committed.html" docs/index.html
fi

echo
echo "13. docs/data.json still matches a live re-derivation from the real repositories"
# The page is only worth anything if its numbers are current. This re-runs the diff from the
# repositories with no registry access and compares the counts to what is committed.
if python3 - "$HOME" <<'PY'
import json, subprocess, sys, pathlib
home = sys.argv[1]
data = json.loads(pathlib.Path('docs/data.json').read_text())
cases = {
    'jw': (f'{home}/Projects/jesseweigel.com', 'f2c8564', 'a6deb9d', 'package-lock.json'),
    'lla': (f'{home}/Projects/language-learning-app', '2068c04', '8ae6855', 'pnpm-lock.yaml'),
}
checked = 0
for ds in data['datasets']:
    if ds['key'] not in cases:
        continue
    repo, base, head, lock = cases[ds['key']]
    out = subprocess.run(
        ['node', 'bin/lockfile-diff.js', '--repo', repo, '--base', base, '--head', head,
         '--path', lock, '--no-registry', '--format', 'json'],
        capture_output=True, text=True, check=True).stdout
    live = json.loads(out)['counts']
    stored = ds['report']['counts']
    for field in ('total', 'major', 'minor', 'patch', 'direct', 'transitive', 'newPackages'):
        assert live[field] == stored[field], (ds['key'], field, live[field], stored[field])
    checked += 1
assert checked == 2, checked
print(f'        {checked} committed datasets re-derived and matched')
PY
then ok "the published page's numbers still match the repositories they came from"
else bad "docs/data.json is stale; run: node scripts/build-data.mjs"; fi

echo
echo "14. no absolute home paths, no secrets, no NUL bytes in tracked files"
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  hits=$(git -C "$ROOT" grep -In -e "/home/$(id -un)" -- . 2>/dev/null | grep -v '^scripts/verify.sh' || true)
  if [ -z "$hits" ]; then ok "no absolute home paths in tracked files"
  else bad "absolute home paths found"; printf '%s\n' "$hits" | head -5 | sed 's/^/        /'; fi
  keys=$(git -C "$ROOT" grep -In -E 'sk-[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10}' -- . 2>/dev/null || true)
  if [ -z "$keys" ]; then ok "no credential-shaped strings in tracked files"
  else bad "possible credential in tracked files"; printf '%s\n' "$keys" | head -3 | sed 's/^/        /'; fi
  # A single NUL byte makes git and grep treat a file as binary and skip it, which would make
  # both scans above silently blind to that file. Detected with python, because grep -P '\x00'
  # is not available in every grep on this box and returns nothing rather than an error.
  if nul=$(git -C "$ROOT" ls-files -z | python3 -c "
import sys, pathlib
bad = [n for n in sys.stdin.buffer.read().split(b'\0') if n
       and b'\0' in pathlib.Path(n.decode()).read_bytes()]
print(' '.join(b.decode() for b in bad))
"); then
    if [ -z "$nul" ]; then ok "no tracked file contains a NUL byte, so the scans above could read all of them"
    else bad "tracked files containing NUL bytes were skipped by the scans: $nul"; fi
  else bad "the NUL-byte scan itself failed"; fi
  big=$(git -C "$ROOT" ls-files | xargs -r du -k 2>/dev/null | awk '$1 > 1024 {print $2, $1"K"}' || true)
  if [ -z "$big" ]; then ok "no tracked file is over 1 MB"
  else bad "large tracked files: $big"; fi
else
  bad "not a git repository, cannot check tracked files"
fi

echo
echo "15. the README describes what this script actually does"
README="$ROOT/README.md"
if [ ! -f "$README" ]; then
  bad "README.md is missing"
elif ! grep -q '^## Status' "$README"; then
  bad "README.md has no '## Status' section"
elif ! grep -q 'VERIFY OK' "$README"; then
  bad "README.md's Status section does not contain this script's success line"
elif grep -qi 'TODO\|FIXME\|replace with' "$README"; then
  bad "README.md still contains placeholder text"
else
  ok "README.md has a Status section carrying real verify output"
fi
# A pasted test count goes stale the moment somebody adds a test, so it is asserted, not trusted.
claimed=$(grep -oE '[0-9]+ unit tests' "$README" 2>/dev/null | head -1 | grep -oE '^[0-9]+' || true)
if [ -z "$claimed" ]; then
  bad "README.md does not state a unit test count in the form 'N unit tests'"
elif [ "$claimed" = "$UNIT_TESTS" ]; then
  ok "README.md's claim of $claimed unit tests matches this run"
else
  bad "README.md claims $claimed unit tests, this run had $UNIT_TESTS"
fi
for phrase in 'package-lock.json' 'pnpm-lock.yaml' 'lower bound' 'UNKNOWN'; do
  grep -q "$phrase" "$README" || bad "README.md never mentions \"$phrase\""
done

echo
printf 'lockfile-diff: %s unit tests, %s lockfiles self-diffed to zero changes, %s malformed inputs rejected\n' \
  "$UNIT_TESTS" "$self_diff_ran" "$mal_ok"
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || { echo "VERIFY FAILED"; exit 1; }
echo "VERIFY OK"
