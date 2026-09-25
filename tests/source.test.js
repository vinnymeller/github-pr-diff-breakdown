import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRange, fetchPullDiff, fetchText, MAX_DIFF_BYTES } from '../src/lib/source.js';

// The PR metadata below is the shape of `/pull/{n}/_layout`'s
// payload.pullRequestsLayoutRoute.pullRequest, trimmed to the fields we read.
const HEAD = 'ccac4bca5a56d10798e9ba64852eb62f48544293';
const MERGE = 'dd3b295fdc7c921d21fa046003c63cf1f6d14332';
const PR = { owner: 'sindresorhus', repo: 'got', number: 2465 };
const REPO = 'https://github.com/sindresorhus/got';
const DIFF = 'diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x\n+y\n';
const PATCH_DIFF_503 = 'The server is unavailable at this time. Please wait a few minutes before you try again.';

const layout = (pullRequest) => JSON.stringify({ payload: { pullRequestsLayoutRoute: { pullRequest } } });
const OPEN_PR = { state: 'OPEN', baseBranch: 'main', headSha: HEAD, mergeCommitSha: null };

/**
 * A stand-in for fetch that answers from a route table and records every call,
 * so a test can assert both the outcome and which requests it took to get there.
 */
function fakeGitHub(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected request: ${url}`);
    if (route instanceof Error) throw route;
    const [status, body = '', headers = {}] = route;
    return new Response(body, { status, headers });
  };
  return { fetch: fetchImpl, calls, urls: () => calls.map((c) => c.url) };
}

test('compareRange: open and closed PRs diff their head against the base branch', () => {
  assert.equal(compareRange(OPEN_PR), `main...${HEAD}`);
  assert.equal(compareRange({ ...OPEN_PR, state: 'CLOSED' }), `main...${HEAD}`);
});

test('compareRange: merged PRs use the base as it stood before the merge', () => {
  // After a merge commit lands, the base branch contains the head and a diff
  // against it is empty. The merge commit's first parent is the pre-merge base.
  assert.equal(compareRange({ ...OPEN_PR, state: 'MERGED', mergeCommitSha: MERGE }), `${MERGE}%5E...${HEAD}`);
  assert.equal(compareRange({ ...OPEN_PR, state: 'MERGED', mergeCommitSha: null }), null);
});

test('compareRange: branch names keep their slashes and escape everything else', () => {
  assert.equal(compareRange({ ...OPEN_PR, baseBranch: 'release/1.139' }), `release/1.139...${HEAD}`);
  assert.equal(compareRange({ ...OPEN_PR, baseBranch: 'fix#12?x' }), `fix%2312%3Fx...${HEAD}`);
});

test('compareRange: refuses metadata it cannot trust', () => {
  assert.equal(compareRange(undefined), null);
  assert.equal(compareRange({}), null);
  assert.equal(compareRange({ ...OPEN_PR, headSha: 'main' }), null);
  assert.equal(compareRange({ ...OPEN_PR, headSha: `${HEAD}/../x` }), null);
  assert.equal(compareRange({ ...OPEN_PR, baseBranch: '' }), null);
  assert.equal(compareRange({ ...OPEN_PR, state: 'MERGED', mergeCommitSha: 'not-a-sha' }), null);
});

test('fetchPullDiff: .diff is the only request when it works', async () => {
  const gh = fakeGitHub({ [`${REPO}/pull/2465.diff`]: [200, DIFF] });
  assert.equal(await fetchPullDiff(PR, gh), DIFF);
  assert.deepEqual(gh.urls(), [`${REPO}/pull/2465.diff`]);
  assert.equal(gh.calls[0].init.credentials, 'include', 'private repos need the session cookie');
});

test('fetchPullDiff: a 503 from patch-diff falls back to the compare view', async () => {
  const gh = fakeGitHub({
    [`${REPO}/pull/2465.diff`]: [503, PATCH_DIFF_503],
    [`${REPO}/pull/2465/_layout`]: [200, layout(OPEN_PR), { 'content-type': 'application/json' }],
    [`${REPO}/compare/main...${HEAD}.diff`]: [200, DIFF],
  });
  assert.equal(await fetchPullDiff(PR, gh), DIFF);
  assert.deepEqual(gh.urls(), [
    `${REPO}/pull/2465.diff`,
    `${REPO}/pull/2465/_layout`,
    `${REPO}/compare/main...${HEAD}.diff`,
  ]);
  // Without this header the route serves HTML, not the payload.
  assert.equal(gh.calls[1].init.headers.Accept, 'application/json');
  assert.ok(gh.calls.every((c) => c.init.credentials === 'include'));
});

test('fetchPullDiff: a merged PR falls back to the pre-merge range', async () => {
  const merged = { ...OPEN_PR, state: 'MERGED', mergeCommitSha: MERGE };
  const gh = fakeGitHub({
    [`${REPO}/pull/2465.diff`]: [503, PATCH_DIFF_503],
    [`${REPO}/pull/2465/_layout`]: [200, layout(merged)],
    [`${REPO}/compare/${MERGE}%5E...${HEAD}.diff`]: [200, DIFF],
  });
  assert.equal(await fetchPullDiff(PR, gh), DIFF);
});

test('fetchPullDiff: an unreachable patch-diff host also falls back', async () => {
  const gh = fakeGitHub({
    [`${REPO}/pull/2465.diff`]: new TypeError('Failed to fetch'),
    [`${REPO}/pull/2465/_layout`]: [200, layout(OPEN_PR)],
    [`${REPO}/compare/main...${HEAD}.diff`]: [200, DIFF],
  });
  assert.equal(await fetchPullDiff(PR, gh), DIFF);
});

test('fetchPullDiff: when the fallback fails too, the original error is reported', async () => {
  const cases = {
    'metadata route gone': { [`${REPO}/pull/2465/_layout`]: [404, 'Not Found'] },
    'metadata is HTML': { [`${REPO}/pull/2465/_layout`]: [200, '<!DOCTYPE html><html>'] },
    'metadata reshaped': { [`${REPO}/pull/2465/_layout`]: [200, JSON.stringify({ payload: {} })] },
    'compare also down': {
      [`${REPO}/pull/2465/_layout`]: [200, layout(OPEN_PR)],
      [`${REPO}/compare/main...${HEAD}.diff`]: [503, ''],
    },
  };
  for (const [name, routes] of Object.entries(cases)) {
    const gh = fakeGitHub({ [`${REPO}/pull/2465.diff`]: [503, PATCH_DIFF_503], ...routes });
    await assert.rejects(fetchPullDiff(PR, gh), (e) => {
      assert.equal(e.kind, 'unavailable', name);
      assert.match(e.message, /503/, name);
      return true;
    });
  }
});

test('fetchPullDiff: a diff too large to parse is not fetched twice', async () => {
  const gh = fakeGitHub({ [`${REPO}/pull/2465.diff`]: [200, DIFF, { 'content-length': String(MAX_DIFF_BYTES + 1) }] });
  await assert.rejects(fetchPullDiff(PR, gh), { kind: 'too-large' });
  assert.equal(gh.calls.length, 1);
});

test('fetchPullDiff: an oversized fallback diff reports its size, not the 503', async () => {
  const gh = fakeGitHub({
    [`${REPO}/pull/2465.diff`]: [503, PATCH_DIFF_503],
    [`${REPO}/pull/2465/_layout`]: [200, layout(OPEN_PR)],
    [`${REPO}/compare/main...${HEAD}.diff`]: [200, DIFF, { 'content-length': String(MAX_DIFF_BYTES + 1) }],
  });
  await assert.rejects(fetchPullDiff(PR, gh), { kind: 'too-large' });
});

test('fetchPullDiff: a 404 still explains signing in when nothing else can see the PR', async () => {
  const gh = fakeGitHub({
    [`${REPO}/pull/2465.diff`]: [404, 'Not Found'],
    [`${REPO}/pull/2465/_layout`]: [404, 'Not Found'],
  });
  await assert.rejects(fetchPullDiff(PR, gh), (e) => e.kind === 'not-found' && /signed in/.test(e.message));
});

test('fetchText: optional files that do not exist are null, not errors', async () => {
  const gh = fakeGitHub({ [`${REPO}/raw/HEAD/.gitattributes`]: [404, 'Not Found'] });
  assert.equal(await fetchText(`${REPO}/raw/HEAD/.gitattributes`, { ...gh, optional: true }), null);
  await assert.rejects(fetchText(`${REPO}/raw/HEAD/.gitattributes`, gh), { kind: 'not-found' });
});
