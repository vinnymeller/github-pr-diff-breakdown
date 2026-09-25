// All fetching, parsing and classification happens here. The content script is
// pure rendering, which keeps every cross-origin request in the one place that
// has host permissions and avoids asking a page context to do CORS gymnastics.

import { parseDiff } from './lib/diff.js';
import { parseGitattributes } from './lib/gitattributes.js';
import { parseConfigFile, CONFIG_PATHS } from './lib/config.js';
import { classify } from './lib/classify.js';
import { formatCount } from './lib/format.js';
import { attachAnchors } from './lib/anchor.js';
import { fetchText, fetchPullDiff } from './lib/source.js';

const FRESH_MS = 60 * 1000;          // skip revalidation entirely below this age
const REPO_TTL_MS = 10 * 60 * 1000;  // .gitattributes / config change rarely
const MAX_CACHED_PRS = 60;

const prKey = (o, r, n) => `pr:${o}/${r}#${n}`;
const repoKey = (o, r) => `repo:${o}/${r}`;

async function getStored(key) {
  const bag = await chrome.storage.local.get(key);
  return bag[key];
}

/** Keep the cache from growing without bound; evict the least recently fetched. */
async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const prs = Object.entries(all).filter(([k]) => k.startsWith('pr:'));
  if (prs.length <= MAX_CACHED_PRS) return;
  prs.sort((a, b) => (a[1]?.fetchedAt ?? 0) - (b[1]?.fetchedAt ?? 0));
  await chrome.storage.local.remove(prs.slice(0, prs.length - MAX_CACHED_PRS).map(([k]) => k));
}

/**
 * Repo-level inputs, read from the default branch (HEAD) rather than the PR's
 * head. A pull request therefore cannot rewrite how its own size is displayed,
 * and we need no extra request to discover the base ref.
 */
async function loadRepoConfig(owner, repo) {
  const cached = await getStored(repoKey(owner, repo));
  if (cached && Date.now() - cached.fetchedAt < REPO_TTL_MS) return cached;

  const base = `https://github.com/${owner}/${repo}/raw/HEAD/`;
  const [attrText, ...configTexts] = await Promise.all([
    fetchText(base + '.gitattributes', { optional: true }).catch(() => null),
    ...CONFIG_PATHS.map((p) => fetchText(base + p, { optional: true }).catch(() => null)),
  ]);

  const idx = configTexts.findIndex((t) => t !== null);
  const record = {
    attrText: attrText ?? '',
    configText: idx === -1 ? '' : configTexts[idx],
    configPath: idx === -1 ? null : CONFIG_PATHS[idx],
    fetchedAt: Date.now(),
  };
  await chrome.storage.local.set({ [repoKey(owner, repo)]: record });
  return record;
}

let localRulesMemo = null;
async function loadLocalRules() {
  if (localRulesMemo) return localRulesMemo;
  const { localConfig = '' } = await chrome.storage.sync.get('localConfig');
  localRulesMemo = localConfig.trim()
    ? parseConfigFile(localConfig, 'your local overrides')
    : { rules: [], errors: [], settings: {} };
  return localRulesMemo;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.localConfig) localRulesMemo = null;
});

/** Fetch + parse the diff, caching the per-file rows (not the classification,
 *  so changing your local rules re-buckets instantly without a refetch). */
async function loadFiles(owner, repo, number, { allowCache = true } = {}) {
  const key = prKey(owner, repo, number);
  if (allowCache) {
    const cached = await getStored(key);
    if (cached) return { files: cached.files, fetchedAt: cached.fetchedAt };
  }
  const text = await fetchPullDiff({ owner, repo, number });
  const { files } = parseDiff(text);
  const record = { files, fetchedAt: Date.now() };
  await chrome.storage.local.set({ [key]: record });
  pruneCache();
  return record;
}

async function buildResult(owner, repo, number, { allowCache }) {
  const [fileData, repoConfig, local] = await Promise.all([
    loadFiles(owner, repo, number, { allowCache }),
    loadRepoConfig(owner, repo).catch(() => ({ attrText: '', configText: '', configPath: null })),
    loadLocalRules(),
  ]);

  const repoParsed = repoConfig.configText
    ? parseConfigFile(repoConfig.configText, repoConfig.configPath)
    : { rules: [], errors: [], settings: {} };

  const result = classify({
    repo: { owner, name: repo },
    files: fileData.files,
    localRules: local.rules,
    repoRules: repoParsed.rules,
    gitattributes: parseGitattributes(repoConfig.attrText),
  });

  // Anchors let the popover link straight to a file's diff. Only the paths we
  // actually kept are hashed, not every file in the PR.
  await attachAnchors(result.buckets);

  // Display settings follow the same precedence as the rules: yours first.
  const numbers = local.settings?.numbers ?? repoParsed.settings?.numbers ?? 'abbreviated';
  for (const bucket of result.buckets) {
    bucket.display = {
      additions: formatCount(bucket.additions, numbers),
      deletions: formatCount(bucket.deletions, numbers),
    };
  }

  return {
    ...result,
    numbers,
    warnings: [...local.errors, ...repoParsed.errors],
    configPath: repoConfig.configPath,
    fetchedAt: fileData.fetchedAt,
  };
}

/** Stale-while-revalidate: answer instantly from cache, then quietly correct it. */
async function analyze({ owner, repo, number }, tabId) {
  const cached = await getStored(prKey(owner, repo, number));
  const fresh = cached && Date.now() - cached.fetchedAt < FRESH_MS;

  if (cached) {
    const result = await buildResult(owner, repo, number, { allowCache: true });
    if (!fresh) revalidate(owner, repo, number, tabId, result);
    return { ok: true, result };
  }
  return { ok: true, result: await buildResult(owner, repo, number, { allowCache: false }) };
}

async function revalidate(owner, repo, number, tabId, previous) {
  try {
    const result = await buildResult(owner, repo, number, { allowCache: false });
    const changed = JSON.stringify(result.totals) !== JSON.stringify(previous.totals) ||
      JSON.stringify(result.buckets.map((b) => [b.label, b.additions, b.deletions])) !==
      JSON.stringify(previous.buckets.map((b) => [b.label, b.additions, b.deletions]));
    if (changed && tabId != null) {
      chrome.tabs.sendMessage(tabId, { type: 'pr-diff-breakdown:update', owner, repo, number, result })
        .catch(() => {}); // the tab navigated away; nothing to correct
    }
  } catch {
    // A failed background refresh leaves the cached answer in place on purpose.
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'pr-diff-breakdown:analyze') return undefined;
  analyze(message, sender.tab?.id)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: { kind: e.kind ?? 'unknown', message: e.message } }));
  return true; // keep the channel open for the async response
});
