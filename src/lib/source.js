// Where a pull request's diff comes from, and what happens when that fails.
//
// The canonical source is `/pull/{n}.diff`, which redirects to
// patch-diff.githubusercontent.com. That host sheds load with an instant 503
// ("The server is unavailable at this time. Please wait a few minutes before
// you try again.") and does so per pull request, for minutes at a time: retrying
// the same URL straight away almost never helps, while a different PR loads
// fine. Measured against public PRs, one took twelve attempts over nearly a
// minute to come back.
//
// github.com's compare view is served by a different backend and returns the
// same bytes. A three-dot compare diffs the head against its merge base with
// the other side, which is exactly how a pull request's diff is defined, so
// `compare/{base}...{headSha}.diff` reproduces `.diff` byte for byte — checked
// against open, closed, cross-fork, squash-, merge-commit- and rebase-merged
// PRs, a 1,105-file PR, and base branches with slashes in their names.
//
// The fallback needs the head SHA and base branch, which come from the JSON
// GitHub's own client-side navigation fetches for the PR header. That endpoint
// is undocumented, so everything after the first failure is best effort: if the
// fallback can't run, the caller gets the original error, which names the real
// problem.

export const MAX_DIFF_BYTES = 12 * 1024 * 1024;

export class FetchError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'FetchError';
    this.kind = kind;
  }
}

async function get(url, fetchImpl, headers) {
  try {
    return await fetchImpl(url, { credentials: 'include', redirect: 'follow', headers });
  } catch (e) {
    throw new FetchError('network', `Could not reach GitHub (${e.message}).`);
  }
}

function statusError(status) {
  if (status === 404) {
    return new FetchError('not-found',
      "GitHub returned 404 for this pull request's diff. If the repository is private, make sure you're signed in to GitHub in this browser.");
  }
  if (status === 406 || status === 413) {
    return new FetchError('too-large', 'GitHub would not serve a diff this large.');
  }
  if (status >= 500) {
    return new FetchError('unavailable',
      `GitHub's diff service returned ${status} for this pull request. This is usually temporary; reload in a few minutes.`);
  }
  return new FetchError('http', `GitHub returned ${status} for this pull request's diff.`);
}

/**
 * GET a text resource with the user's GitHub session. `optional` turns a 404
 * into `null`, for files a repository may simply not have.
 */
export async function fetchText(url, { fetch: fetchImpl = globalThis.fetch, optional = false } = {}) {
  const res = await get(url, fetchImpl);
  if (res.status === 404 && optional) return null;
  if (!res.ok) throw statusError(res.status);

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_DIFF_BYTES) {
    throw new FetchError('too-large', `This diff is ${(declared / 1e6).toFixed(0)} MB, too large to break down in the browser.`);
  }
  const text = await res.text();
  if (text.length > MAX_DIFF_BYTES) {
    throw new FetchError('too-large', 'This diff is too large to break down in the browser.');
  }
  return text;
}

// SHA-1 today; SHA-256 object format is 64 hex digits.
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

// Refs can't contain "..", so the "..." separator is never ambiguous; only
// characters that mean something in a URL need escaping. Slashes stay, since
// release/1.2 is a path-like ref and GitHub reads it that way.
const encodeRef = (ref) => ref.split('/').map(encodeURIComponent).join('/');

/**
 * The compare range whose three-dot diff equals the pull request's own diff,
 * or null if the metadata can't support one.
 *
 * Open and closed PRs diff against the base branch: its merge base with the
 * head is the PR's fork point, even after the base has moved on. A merged PR
 * can't, because once a merge commit lands the base branch contains the head
 * and the diff comes back empty. The merge commit's first parent is the base
 * as it stood just before the merge, which gives the right merge base for
 * merge commits, squashes and rebases alike.
 */
export function compareRange(pr) {
  if (!pr || !SHA.test(pr.headSha ?? '')) return null;
  if (pr.state === 'MERGED') {
    return SHA.test(pr.mergeCommitSha ?? '') ? `${encodeRef(`${pr.mergeCommitSha}^`)}...${pr.headSha}` : null;
  }
  if (typeof pr.baseBranch !== 'string' || !pr.baseBranch) return null;
  return `${encodeRef(pr.baseBranch)}...${pr.headSha}`;
}

async function pullRange(repoUrl, number, fetchImpl) {
  const res = await get(`${repoUrl}/pull/${number}/_layout`, fetchImpl, { Accept: 'application/json' });
  if (!res.ok) return null;
  const body = await res.json();
  return compareRange(body?.payload?.pullRequestsLayoutRoute?.pullRequest);
}

/** The pull request's unified diff, from `.diff` or, failing that, the compare view. */
export async function fetchPullDiff({ owner, repo, number }, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const repoUrl = `https://github.com/${owner}/${repo}`;
  try {
    return await fetchText(`${repoUrl}/pull/${number}.diff`, { fetch: fetchImpl });
  } catch (primary) {
    // The compare view would serve the same oversized diff.
    if (primary.kind === 'too-large') throw primary;
    const range = await pullRange(repoUrl, number, fetchImpl).catch(() => null);
    if (!range) throw primary;
    try {
      return await fetchText(`${repoUrl}/compare/${range}.diff`, { fetch: fetchImpl });
    } catch (secondary) {
      // A diff that arrived but is too big is the real reason; anything else
      // is the fallback failing, and the original error says more.
      throw secondary.kind === 'too-large' ? secondary : primary;
    }
  }
}
