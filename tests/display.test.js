import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from '../src/lib/diff.js';
import { parseGitattributes } from '../src/lib/gitattributes.js';
import { parseConfigFile, matchesScope } from '../src/lib/config.js';
import { classify } from '../src/lib/classify.js';
import { abbreviate, formatCount } from '../src/lib/format.js';
import { ICON_PATHS } from '../src/lib/icons.js';
import { fileAnchor, attachAnchors } from '../src/lib/anchor.js';

function fileDiff(path, additions, deletions) {
  return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n`
    + `@@ -1,${deletions || 0} +1,${additions || 0} @@\n`
    + '-x\n'.repeat(deletions) + '+y\n'.repeat(additions);
}

const files = parseDiff(
  fileDiff('src/client.py', 8, 7) +
  fileDiff('README.md', 42, 56) +
  fileDiff('tests/cassettes/test_fetch.yaml', 1296, 2308),
).files;

const byLabel = (result, label) => result.buckets.find((b) => b.label === label);

test('numbers: shortened by default, exact below 1000', () => {
  assert.equal(abbreviate(8), '8');
  assert.equal(abbreviate(999), '999');
  assert.equal(abbreviate(1000), '1k');
  assert.equal(abbreviate(1296), '1.3k');
  assert.equal(abbreviate(2308), '2.3k');
  assert.equal(abbreviate(9999), '10k');
  assert.equal(abbreviate(12500), '13k');
  assert.equal(abbreviate(1_250_000), '1.3m');
});

test('numbers: "full" opts back into exact counts', () => {
  assert.equal(formatCount(1296, 'abbreviated'), '1.3k');
  assert.equal(formatCount(1296, 'full'), '1,296');
  assert.equal(formatCount(8, 'full'), '8');
});

test('config: the numbers setting is validated and defaulted', () => {
  assert.deepEqual(parseConfigFile('numbers: full\n', 'cfg').settings, { numbers: 'full' });
  assert.deepEqual(parseConfigFile('numbers: abbreviated\n', 'cfg').settings, { numbers: 'abbreviated' });
  assert.deepEqual(parseConfigFile('buckets: []\n', 'cfg').settings, {}, 'unset means the caller picks the default');
  assert.match(parseConfigFile('numbers: sometimes\n', 'cfg').errors[0], /"numbers" must be/);
});

test('icons: well-known extensions get one from their own label', () => {
  const result = classify({ files });
  assert.equal(byLabel(result, 'py').icon.name, 'python');
  assert.equal(byLabel(result, 'md').icon.name, 'markdown');
  assert.equal(byLabel(result, 'yaml').icon.name, 'yaml');
  // The path data travels with the bucket: the content script has no imports.
  assert.equal(byLabel(result, 'py').icon.path, ICON_PATHS.python);
});

test('icons: brand colors are clamped per theme so they survive both', () => {
  const md = byLabel(classify({ files }), 'md');
  assert.equal(md.color.light, '#000000');
  assert.notEqual(md.color.dark, '#000000', 'pure black would vanish on GitHub dark');
});

test('icons: a custom bucket can set its own, and it beats the derived one', () => {
  const { rules: repoRules, errors } = parseConfigFile(
    'buckets:\n  - label: cassettes\n    icon: yaml\n    patterns: [tests/cassettes/**]\n', 'repo');
  assert.deepEqual(errors, []);
  const bucket = byLabel(classify({ files, repoRules }), 'cassettes');
  assert.equal(bucket.icon.name, 'yaml');
  assert.equal(bucket.color.light, '#cb171e', 'an unset color falls back to the icon brand color');
});

test('icons: a custom bucket without one keeps a plain color swatch', () => {
  const { rules: repoRules } = parseConfigFile(
    'buckets:\n  - label: cassettes\n    patterns: [tests/cassettes/**]\n', 'repo');
  assert.equal(byLabel(classify({ files, repoRules }), 'cassettes').icon, null);
});

test('icons: remote URLs are refused, data: URIs are allowed', () => {
  const remote = parseConfigFile(
    'buckets:\n  - label: x\n    icon: https://example.com/i.png\n    patterns: [a]\n', 'repo');
  assert.match(remote.errors[0], /Content-Security-Policy/);
  assert.equal(remote.rules[0].icon, null, 'the bucket survives, just without the icon');

  const inline = parseConfigFile(
    'buckets:\n  - label: x\n    icon: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="\n    patterns: [a]\n', 'repo');
  assert.deepEqual(inline.errors, []);
  assert.equal(inline.rules[0].icon.kind, 'data');
});

test('local overrides can add files to the generated bucket and inherit its stripes', () => {
  const gitattributes = parseGitattributes('tests/cassettes/** linguist-generated=true\n');
  const { rules: localRules, errors } = parseConfigFile(
    'buckets:\n  - label: generated\n    patterns: ["*.md"]\n', 'local');
  assert.deepEqual(errors, []);

  const result = classify({ files, localRules, gitattributes });
  const generated = byLabel(result, 'generated');
  assert.equal(generated.files, 2, 'the README joins the cassette in one bucket');
  assert.equal(generated.additions, 42 + 1296);
  assert.equal(generated.deletions, 56 + 2308);
  assert.equal(generated.demoted, true, 'and it is striped and sorted last like any generated bucket');
  assert.equal(result.buckets.at(-1).label, 'generated');
  assert.deepEqual(generated.byExt.map((e) => e.ext), ['yaml', 'md']);
});

test('file anchors match the ones GitHub actually uses', async () => {
  // Captured from a live Files changed page (sindresorhus/got#2465) so this
  // stays pinned to GitHub's real scheme, not our idea of it.
  const known = [
    ['source/as-promise/index.ts', '4fd462a09629aa458e4fad7c6ec4a0393527acc587b657fff4f3d774490881a2'],
    ['source/core/index.ts', 'c0192b59eaa0ed83a6ac9d7faeedc53698193feb222bb9e419b2cf46378db2e7'],
    ['source/core/options.ts', '2f3e8826265473771140c976ef87b61e41bac6a476c91a3e1dedfc5f89a4e950'],
  ];
  for (const [path, anchor] of known) {
    assert.equal(await fileAnchor(path), anchor, path);
  }
});

test('file anchors hash the UTF-8 bytes of the path', async () => {
  assert.equal(
    await fileAnchor('docs/café.md'),
    'ded0eaa0c9db6a5e431856be7b63de083aff885f840b24a31b25ccd054051bf2',
  );
});

test('attachAnchors fills in every kept path', async () => {
  const result = classify({ files });
  await attachAnchors(result.buckets);
  const py = byLabel(result, 'py');
  assert.equal(py.paths[0].path, 'src/client.py');
  assert.match(py.paths[0].anchor, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// content.js cannot be imported (it is a classic content script), so these
// mirror its chip-overflow rule and pin the behaviour that matters: generated
// always sorts last and is dropped first, and the "+N more" chip then has to
// say how much of the diff went with it — GitHub's own total is hidden, so
// without that the header would understate the PR.
const NOTABLE_HIDDEN_SHARE = 0.1;
function overflowLabel(buckets, count, totals) {
  const hidden = buckets.slice(count);
  if (!hidden.length) return null;
  const span = totals.additions + totals.deletions;
  const share = span > 0 ? hidden.reduce((s, b) => s + b.additions + b.deletions, 0) / span : 0;
  return share >= NOTABLE_HIDDEN_SHARE
    ? `+${hidden.length} more · ${Math.round(share * 100)}%`
    : `+${hidden.length} more`;
}

const GENERATED_HEAVY = parseDiff(
  // Shaped after grafana/grafana#127479: 44% of the diff is generated.
  fileDiff('pkg/search/builders.go', 1134, 8) +
  fileDiff('apps/alerting/manifest.yaml', 380, 23) +
  fileDiff('apps/alerting/kinds/rule.cue', 325, 6) +
  fileDiff('apps/alerting/zz_generated.go', 1456, 24),
).files;
const GENERATED_HEAVY_ATTRS = parseGitattributes('**/zz_generated.* linguist-generated=true\n');

test('generated always sorts last and is the first chip dropped', () => {
  const result = classify({ files: GENERATED_HEAVY, gitattributes: GENERATED_HEAVY_ATTRS });
  assert.deepEqual(result.buckets.map((b) => b.label), ['go', 'yaml', 'cue', 'generated']);
  assert.equal(result.buckets.at(-1).label, 'generated');
  // With three slots, generated is what overflows — never a real file type.
  assert.deepEqual(result.buckets.slice(0, 3).map((b) => b.label), ['go', 'yaml', 'cue']);
});

test('the overflow chip reports the share it is hiding', () => {
  const result = classify({ files: GENERATED_HEAVY, gitattributes: GENERATED_HEAVY_ATTRS });
  // 1,480 of 3,356 lines are generated: the header must not imply 1,876 is all of it.
  assert.equal(overflowLabel(result.buckets, 3, result.totals), '+1 more · 44%');
});

test('a trivial overflow is not dressed up with a percentage', () => {
  const files2 = parseDiff(
    fileDiff('src/a.py', 900, 900) + fileDiff('src/b.ts', 400, 400) +
    fileDiff('README.md', 200, 200) + fileDiff('gen/tiny.txt', 5, 5),
  ).files;
  const result = classify({ files: files2, gitattributes: parseGitattributes('gen/** linguist-generated=true\n') });
  assert.equal(overflowLabel(result.buckets, 3, result.totals), '+1 more');
});

test('nothing hidden means no overflow chip at all', () => {
  const result = classify({ files: GENERATED_HEAVY, gitattributes: GENERATED_HEAVY_ATTRS });
  assert.equal(overflowLabel(result.buckets, 4, result.totals), null);
});

// --------------------------------------------------------------------- scope

test('scope: an unscoped rule applies to every repository', () => {
  const { rules: localRules } = parseConfigFile(
    'buckets:\n  - label: vcr\n    patterns: [tests/cassettes/**]\n', 'local');
  for (const repo of [{ owner: 'camoag', name: 'api' }, { owner: 'other', name: 'thing' }, null]) {
    const labels = classify({ files, localRules, repo }).buckets.map((b) => b.label);
    assert.ok(labels.includes('vcr'), `expected vcr for ${JSON.stringify(repo)}`);
  }
});

test('scope: owner/repo restricts a rule to exactly that repository', () => {
  const { rules: localRules, errors } = parseConfigFile(
    'buckets:\n  - label: vcr\n    scope: camoag/api\n    patterns: [tests/cassettes/**]\n', 'local');
  assert.deepEqual(errors, []);

  const inside = classify({ files, localRules, repo: { owner: 'camoag', name: 'api' } });
  assert.ok(inside.buckets.some((b) => b.label === 'vcr'));

  // Elsewhere the rule is simply absent, so the files fall through as usual.
  const outside = classify({ files, localRules, repo: { owner: 'camoag', name: 'web' } });
  assert.ok(!outside.buckets.some((b) => b.label === 'vcr'));
  assert.ok(outside.buckets.some((b) => b.label === 'yaml'));
});

test('scope: a bare owner covers the whole organisation', () => {
  const { rules: localRules } = parseConfigFile(
    'buckets:\n  - label: vcr\n    scope: camoag\n    patterns: [tests/cassettes/**]\n', 'local');
  const hit = (owner, name) => classify({ files, localRules, repo: { owner, name } }).buckets.some((b) => b.label === 'vcr');
  assert.equal(hit('camoag', 'api'), true);
  assert.equal(hit('camoag', 'anything-else'), true);
  assert.equal(hit('elsewhere', 'api'), false);
});

test('scope: matching ignores case, and owner/* is the same as owner', () => {
  const { rules, errors } = parseConfigFile(
    'buckets:\n  - label: vcr\n    scope: ["CamoAG/*"]\n    patterns: [tests/cassettes/**]\n', 'local');
  assert.deepEqual(errors, []);
  assert.deepEqual(rules[0].scope, ['camoag'], 'the trailing /* is normalised away');
  assert.equal(matchesScope(rules[0].scope, 'camoag', 'API'), true);
});

test('scope: a scoped rule never applies when the repository is unknown', () => {
  assert.equal(matchesScope(['camoag/api'], undefined, undefined), false);
  assert.equal(matchesScope(null, undefined, undefined), true, 'unscoped still applies');
});

test('scope: takes a list, and rejects malformed entries without losing the bucket', () => {
  const ok = parseConfigFile(
    'buckets:\n  - label: vcr\n    scope: [camoag, other/repo]\n    patterns: [a/**]\n', 'local');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.rules[0].scope, ['camoag', 'other/repo']);

  const bad = parseConfigFile(
    'buckets:\n  - label: vcr\n    scope: a/b/c\n    patterns: [a/**]\n', 'local');
  assert.match(bad.errors[0], /must be "owner" or "owner\/repo"/);
  assert.equal(bad.rules[0].scope, null, 'an unusable scope means unscoped, not a dropped bucket');
});

test('scope: a scoped null-label rule undoes a repo rule only where it applies', () => {
  const { rules: repoRules } = parseConfigFile(
    'buckets:\n  - label: cassettes\n    patterns: [tests/cassettes/**]\n', 'repo');
  const { rules: localRules } = parseConfigFile(
    'buckets:\n  - label: ~\n    scope: camoag/api\n    patterns: [tests/cassettes/**]\n', 'local');

  const here = classify({ files, localRules, repoRules, repo: { owner: 'camoag', name: 'api' } });
  assert.ok(!here.buckets.some((b) => b.label === 'cassettes'), 'suppressed in the scoped repo');
  const elsewhere = classify({ files, localRules, repoRules, repo: { owner: 'camoag', name: 'web' } });
  assert.ok(elsewhere.buckets.some((b) => b.label === 'cassettes'), 'untouched everywhere else');
});

test('config: unknown bucket keys are reported rather than ignored', () => {
  assert.match(
    parseConfigFile('buckets:\n  - label: x\n    scopes: camoag\n    patterns: [a]\n', 'repo').errors[0],
    /unknown key "scopes"/,
  );
});
