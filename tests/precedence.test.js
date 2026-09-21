import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from '../src/lib/diff.js';
import { parseGitattributes } from '../src/lib/gitattributes.js';
import { parseConfigFile } from '../src/lib/config.js';
import { classify } from '../src/lib/classify.js';

// The PR that started this: an 8/7 Python change buried under a re-recorded
// VCR cassette, totalling the +1,346 / -2,371 that makes people close the tab.
// Each layer below sharpens the picture, and the totals never drift from what
// GitHub itself prints in the header.
function fileDiff(path, additions, deletions) {
  const head = `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n`;
  const hunk = `@@ -1,${deletions || 0} +1,${additions || 0} @@\n`;
  const body =
    '-x\n'.repeat(deletions) +
    '+y\n'.repeat(additions);
  return head + hunk + body;
}

const PR_DIFF =
  fileDiff('src/client.py', 8, 7) +
  fileDiff('tests/cassettes/test_fetch.yaml', 1330, 2360) +
  fileDiff('.github/workflows/ci.yaml', 8, 4);

const files = parseDiff(PR_DIFF).files;
const summarize = (result) => result.buckets.map((b) => `${b.label} ${b.additions}/${b.deletions}`).join(' · ');

const CASSETTE_CONFIG = 'version: 1\nbuckets:\n  - label: cassettes\n    color: purple\n    patterns:\n      - tests/cassettes/**\n';
const CI_CONFIG = 'version: 1\nbuckets:\n  - label: ci\n    patterns: [.github/workflows/**]\n';
const GITATTRIBUTES = 'tests/cassettes/** linguist-generated=true\n';

test('the breakdown always sums to the number GitHub shows in the header', () => {
  const { totals } = classify({ files });
  assert.equal(totals.additions, 1346);
  assert.equal(totals.deletions, 2371);
  assert.equal(totals.files, 3);
});

test('layer 1: no config anywhere still separates the python from the yaml', () => {
  assert.equal(summarize(classify({ files })), 'yaml 1338/2364 · py 8/7');
});

test('layer 2: .gitattributes alone relabels the cassettes as generated and demotes them', () => {
  const gitattributes = parseGitattributes(GITATTRIBUTES);
  // Generated sinks below the code even though it is by far the larger bucket:
  // the thing you are meant to read should not be buried under the thing you
  // are not.
  assert.equal(summarize(classify({ files, gitattributes })), 'py 8/7 · yaml 8/4 · generated 1330/2360');
});

test('layer 3: the repo config names them, outranking .gitattributes', () => {
  const gitattributes = parseGitattributes(GITATTRIBUTES);
  const { rules: repoRules, errors } = parseConfigFile(CASSETTE_CONFIG, 'repo');
  assert.deepEqual(errors, []);
  const result = classify({ files, repoRules, gitattributes });
  assert.equal(summarize(result), 'cassettes 1330/2360 · py 8/7 · yaml 8/4');
  assert.deepEqual(result.buckets.find((b) => b.label === 'cassettes').color, { light: '#ab7df8', dark: '#ab7df8' });
});

test('layer 4: a local rule splits CI yaml out without disturbing the team config', () => {
  const { rules: repoRules } = parseConfigFile(CASSETTE_CONFIG, 'repo');
  const { rules: localRules } = parseConfigFile(CI_CONFIG, 'local');
  assert.equal(
    summarize(classify({ files, localRules, repoRules })),
    'cassettes 1330/2360 · py 8/7 · ci 8/4',
  );
});

test('a null local label falls through to the default layer, undoing a repo rule', () => {
  const { rules: repoRules } = parseConfigFile(CASSETTE_CONFIG, 'repo');
  const { rules: localRules } = parseConfigFile(
    'version: 1\nbuckets:\n  - label: ~\n    patterns: [tests/cassettes/**]\n', 'local');
  assert.equal(
    summarize(classify({ files, localRules, repoRules })),
    'yaml 1338/2364 · py 8/7',
    'the cassettes should be back to plain yaml, not still named "cassettes"',
  );
});

test('local rules beat repo rules for the same path', () => {
  const { rules: repoRules } = parseConfigFile(CASSETTE_CONFIG, 'repo');
  const { rules: localRules } = parseConfigFile(
    'version: 1\nbuckets:\n  - label: vcr\n    patterns: [tests/cassettes/**]\n', 'local');
  const labels = classify({ files, localRules, repoRules }).buckets.map((b) => b.label);
  assert.ok(labels.includes('vcr'));
  assert.ok(!labels.includes('cassettes'));
});

test('adding one local rule does not discard the rest of the repo config', () => {
  const { rules: repoRules } = parseConfigFile(
    'version: 1\nbuckets:\n  - label: cassettes\n    patterns: [tests/cassettes/**]\n  - label: ci\n    patterns: [.github/workflows/**]\n', 'repo');
  const { rules: localRules } = parseConfigFile(
    'version: 1\nbuckets:\n  - label: python\n    patterns: ["*.py"]\n', 'local');
  const labels = classify({ files, localRules, repoRules }).buckets.map((b) => b.label).sort();
  assert.deepEqual(labels, ['cassettes', 'ci', 'python']);
});

test('every bucket carries its extension mix for the expanded view', () => {
  const gitattributes = parseGitattributes(GITATTRIBUTES + '*.lock linguist-generated=true\n');
  const withLock = [...files, { path: 'poetry.lock', additions: 500, deletions: 400, binary: false, status: 'modified' }];
  const generated = classify({ files: withLock, gitattributes }).buckets.find((b) => b.label === 'generated');
  assert.deepEqual(
    generated.byExt.map((e) => `${e.ext} ${e.additions}/${e.deletions}`),
    ['yaml 1330/2360', 'lock 500/400'],
  );
});
