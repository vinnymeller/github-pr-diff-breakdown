// Rendering only. Everything that needs the network lives in the service worker,
// which also resolves icon path data so this file needs no imports.
//
// Anchoring note: GitHub's PR header is React with hashed CSS module class names
// (PullRequestHeader-module__rightContentWrapper__MrqTF) that change on every
// deploy. We anchor on the screen-reader text instead — "Lines changed: 764
// additions & 10 deletions" — which is semantic, stable, and present on both the
// current header and the legacy diffstat.
//
// Injection note: the manifest matches all of github.com, not just /pull/ URLs.
// Opening a PR from the pull request list, a notification or a search result is
// client-side navigation — the document is still /pulls — and Chrome only
// injects content scripts on real document loads. Matching PR URLs alone meant
// the chips appeared only after a reload. On any other page this script does
// nothing beyond checking the URL when the DOM changes.

const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#]|$)/;
const ROOT_ID = 'pdb-root';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_CHIPS = 3;
const MAX_ROWS = 6;
const MAX_PATHS_SHOWN = 8;
/** Below this, the overflow chip doesn't bother quoting a share. */
const NOTABLE_HIDDEN_SHARE = 0.1;

let current = null;
let state = { status: 'idle' };
let popover = null;

function parseLocation() {
  const m = PR_PATH.exec(location.pathname);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

/** GitHub renamed this tab's route from /files to /changes, so read it off the
 *  live tab rather than hardcoding either spelling. */
function filesTabHref() {
  const tab = document.getElementById('prs-files-anchor-tab') ?? document.querySelector('a[href$="/changes"], a[href$="/files"]');
  return tab?.getAttribute('href') ?? `/${current.owner}/${current.repo}/pull/${current.number}/files`;
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text; // never innerHTML: labels come from a repo file
  return node;
};

// -------------------------------------------------------------------- numbers

// Chips show whatever the service worker formatted (abbreviated by default,
// `numbers: full` in config for exact). Everything in the detail popover is
// exact: there is room for it there, and that is why you opened it.
const exact = (n) => n.toLocaleString();

// ------------------------------------------------------------------- anchoring

/**
 * Find GitHub's diffstat: the group holding "+1,346 −2,371" and its squares.
 * Strategy 1 is the current React header, strategy 2 the legacy /files markup.
 */
function findAnchor() {
  for (const sr of document.querySelectorAll('span.sr-only, span.visually-hidden')) {
    if (!/^Lines changed:/.test(sr.textContent || '')) continue;
    if (sr.parentElement) return sr.parentElement;
  }
  return document.querySelector('#diffstat, span.diffstat');
}

/**
 * Hide everything GitHub drew in that group — the totals and the five squares —
 * since the chips replace all of it. The screen-reader text stays: it is already
 * invisible, and it keeps the totals available to assistive tech.
 *
 * Primer's utilities are `!important` (`.d-flex { display: flex !important }`)
 * and a content-script stylesheet is injected before GitHub's, so an equally
 * specific rule loses the tie on source order. An inline !important is the only
 * thing that reliably wins.
 */
function hideNativeStat(group, root) {
  for (const child of group.children) {
    if (child === root) continue;
    if (child.classList.contains('sr-only') || child.classList.contains('visually-hidden')) continue;
    child.classList.add('pdb-hidden');
    child.style.setProperty('display', 'none', 'important');
  }
}

/** Undo hideNativeStat: when there is no breakdown, GitHub's totals are the next best thing. */
function showNativeStat(group) {
  for (const child of group.querySelectorAll(':scope > .pdb-hidden')) {
    child.classList.remove('pdb-hidden');
    child.style.removeProperty('display');
  }
}

/** Enough for the "+N more" chip alone, which is the smallest useful state. */
const MIN_CHIPS_WIDTH = 72;
const CHIPS_GUTTER = 16;

/**
 * Give the tab bar first claim on the header row, and let the chips scroll.
 *
 * The row is `display: block` with the stat wrapper floated right, so there is
 * no flex negotiation to win here — the float simply reserves its own width and
 * the tab list (which has its own overflow-x) absorbs whatever is left. Left
 * alone, 326px of chips push the tabs into a scrollbar at around 900px of row.
 * So we measure what the tabs actually want and cap ourselves to the remainder.
 *
 * The tabs' natural width has to come from summing the links: `scrollWidth` on
 * the list is its *container* width whenever it isn't overflowing, which feeds
 * our own cap back into the measurement and never settles. Each link carries
 * `flex-shrink-0`, so the sum is constant and one pass is enough.
 */
function naturalTabsWidth(tabs) {
  const gap = parseFloat(getComputedStyle(tabs).columnGap) || 0;
  const links = [...tabs.children];
  return links.reduce((sum, link) => sum + link.getBoundingClientRect().width, 0)
    + gap * Math.max(0, links.length - 1);
}

function headerRow(group) {
  return group.closest('[data-component="PH_Navigation"]') ?? group.parentElement?.parentElement;
}

/**
 * How much room the chips may take before the tab bar would start scrolling.
 *
 * The stat group is floated, and the tab list establishes its own block
 * formatting context, so the list shrinks by exactly the float's width. That
 * float is our chips *plus* whatever else is still in the group, so measure the
 * difference rather than assuming everything else is hidden.
 */
function capFor(group, root) {
  const row = headerRow(group);
  const tabs = row?.querySelector('nav')?.firstElementChild;
  if (!row || !tabs || !tabs.children.length) return null; // legacy markup: no competition

  const overhead = group.getBoundingClientRect().width - root.getBoundingClientRect().width;
  const available = row.clientWidth - naturalTabsWidth(tabs) - Math.max(0, overhead) - CHIPS_GUTTER;
  return Math.max(MIN_CHIPS_WIDTH, Math.floor(available));
}

/**
 * Drop chips until what's left fits, rather than letting them scroll.
 *
 * A horizontally scrolling strip inside the header is undiscoverable — it hides
 * whole buckets behind a gesture nobody would think to try, and the bucket most
 * worth seeing (the generated one, often the bulk of the PR) is the one that
 * falls off the end. A visible "+N more" chip says the same thing and is
 * obviously clickable.
 *
 * Only a handful of chips are ever drawn, so the fit loop runs at most a few
 * passes, and it re-runs only when the available width actually changes.
 */
function fitChips(root, group, { force = false } = {}) {
  const cap = capFor(group, root);
  if (cap == null) return;
  if (!force && root.dataset.cap === String(cap)) return;
  root.dataset.cap = String(cap);
  root.style.maxWidth = `${cap}px`;
  if (state.status !== 'ready') return;

  let count = Math.min(MAX_CHIPS, state.result.buckets.length);
  paintChips(root, count);
  while (count > 0 && root.scrollWidth > cap + 1) {
    count -= 1;
    paintChips(root, count);
  }
}

/**
 * Remeasure whenever the room available actually changes, not just on window
 * resize. The header can be widened by other extensions (Wide GitHub and
 * friends) whose CSS lands after we first measure, and a one-shot calculation
 * would leave the chips needlessly capped for the rest of the session.
 */
let fitObserver = null;
function observeFit(root, group) {
  const row = headerRow(group);
  const tabs = row?.querySelector('nav')?.firstElementChild;
  if (!row) return;
  fitObserver?.disconnect();
  fitObserver = new ResizeObserver(() => fitChips(root, group));
  fitObserver.observe(row);
  if (tabs) fitObserver.observe(tabs);
}

// ---------------------------------------------------------------------- chips

function iconNode(bucket, className) {
  if (bucket.icon?.kind === 'builtin' && bucket.icon.path) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', bucket.icon.path);
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }
  if (bucket.icon?.kind === 'data') {
    const img = el('img', className);
    img.src = bucket.icon.url; // the config schema allows only data: URIs here
    img.alt = '';
    return img;
  }
  // No icon: fall back to the colored square, striped when demoted.
  const swatch = el('span', `${className} pdb-swatch`);
  if (bucket.demoted) swatch.classList.add('pdb-striped');
  return swatch;
}

function applyColor(node, bucket) {
  node.style.setProperty('--pdb-color-light', bucket.color.light);
  node.style.setProperty('--pdb-color-dark', bucket.color.dark);
}

function buildChip(bucket) {
  const chip = el('button', 'pdb-chip');
  chip.type = 'button';
  applyColor(chip, bucket);

  chip.title = `${bucket.label} — ${exact(bucket.files)} ${bucket.files === 1 ? 'file' : 'files'}, `
    + `+${exact(bucket.additions)} −${exact(bucket.deletions)}. Click for the file list.`;
  chip.setAttribute('aria-label',
    `${bucket.label}: ${exact(bucket.additions)} added, ${exact(bucket.deletions)} removed across ${exact(bucket.files)} files`);

  chip.append(
    iconNode(bucket, 'pdb-icon'),
    el('span', 'pdb-chip-label', bucket.label),
    el('span', 'pdb-add', bucket.additions ? `+${bucket.display.additions}` : '—'),
    el('span', 'pdb-del', bucket.deletions ? `−${bucket.display.deletions}` : '—'),
  );
  chip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPopover(bucket.label);
  });
  return chip;
}

/**
 * How much of the diff is behind the "+N more" chip, 0-1.
 *
 * Buckets are shown biggest-first with generated/vendored/binary last, so what
 * overflows is whatever matters least — but on a mostly-generated PR that can
 * still be most of the lines. Since GitHub's own total is hidden, a bare
 * "+1 more" would let the header understate a 3,400-line PR as 1,800. Quoting
 * the share keeps the chips honest about the size without costing a slot.
 */
function hiddenShare(hidden) {
  const { additions, deletions } = state.result.totals;
  const span = additions + deletions;
  if (span <= 0) return 0;
  return hidden.reduce((sum, b) => sum + b.additions + b.deletions, 0) / span;
}

/** Draw the first `count` buckets, plus a "+N more" chip for the rest. */
function paintChips(root, count) {
  const { buckets } = state.result;
  root.replaceChildren();

  for (const bucket of buckets.slice(0, count)) root.appendChild(buildChip(bucket));

  const hidden = buckets.slice(count);
  if (hidden.length === 0) return;

  const share = hiddenShare(hidden);
  const label = share >= NOTABLE_HIDDEN_SHARE
    ? `+${hidden.length} more · ${Math.round(share * 100)}%`
    : `+${hidden.length} more`;

  const more = el('button', 'pdb-chip pdb-chip-more', label);
  more.type = 'button';
  if (hidden.some((b) => b.demoted)) more.classList.add('pdb-chip-more-demoted');
  more.title = hidden.map((b) => `${b.label}  +${exact(b.additions)} −${exact(b.deletions)}`).join('\n');
  more.setAttribute('aria-label',
    `Show ${hidden.length} more file types, ${Math.round(share * 100)}% of the diff: ${hidden.map((b) => b.label).join(', ')}`);
  more.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openPopover(); });
  root.appendChild(more);
}

// ---------------------------------------------------------------- error badge

// When the breakdown can't be built, GitHub's own totals come back and a small
// badge sits beside them to say why. A sentence of error text in the header
// would crowd the tabs and read as broken; silently showing GitHub's totals
// would leave you wondering whether the extension is running at all.

/** A circled "!", drawn here rather than borrowed so it needs no attribution. */
function statusIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'pdb-status-icon');
  const circle = document.createElementNS(SVG_NS, 'circle');
  for (const [k, v] of Object.entries({ cx: 8, cy: 8, r: 6.75, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 })) {
    circle.setAttribute(k, v);
  }
  const mark = document.createElementNS(SVG_NS, 'path');
  mark.setAttribute('d', 'M8 4.25v4.5');
  mark.setAttribute('stroke', 'currentColor');
  mark.setAttribute('stroke-width', '1.5');
  mark.setAttribute('stroke-linecap', 'round');
  const dot = document.createElementNS(SVG_NS, 'circle');
  for (const [k, v] of Object.entries({ cx: 8, cy: 11.25, r: 1, fill: 'currentColor' })) dot.setAttribute(k, v);
  svg.append(circle, mark, dot);
  return svg;
}

function buildStatusBadge(message) {
  const badge = el('button', 'pdb-status');
  badge.type = 'button';
  badge.setAttribute('aria-label', `File type breakdown unavailable. ${message}`);
  badge.appendChild(statusIcon());
  const show = () => openTooltip(badge, message);
  badge.addEventListener('mouseenter', show);
  badge.addEventListener('focus', show);
  badge.addEventListener('mouseleave', closeTooltip);
  badge.addEventListener('blur', closeTooltip);
  // Touch has no hover; a tap should explain rather than do nothing.
  badge.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); show(); });
  return badge;
}

let tooltip = null;

function openTooltip(anchor, message) {
  closeTooltip();
  tooltip = el('div', 'pdb-tooltip');
  tooltip.setAttribute('role', 'tooltip');
  tooltip.append(
    el('div', 'pdb-tooltip-title', 'File type breakdown unavailable'),
    el('div', 'pdb-tooltip-body', message),
    el('div', 'pdb-tooltip-foot', "Showing GitHub's totals instead."),
  );
  document.body.appendChild(tooltip);
  placeBelow(tooltip, anchor);
}

function closeTooltip() {
  tooltip?.remove();
  tooltip = null;
}

/** Non-ready states: loading skeleton, an error, or a PR with nothing in it. */
function paintState(root) {
  root.replaceChildren();
  closeTooltip();
  if (state.status !== 'ready') closePopover();
  if (state.status === 'error') {
    root.appendChild(buildStatusBadge(state.error));
  } else if (state.status !== 'ready') {
    for (let i = 0; i < 2; i++) root.appendChild(el('span', 'pdb-chip pdb-chip-skeleton'));
  } else if (state.result.buckets.length === 0) {
    root.appendChild(el('span', 'pdb-note', 'No changed lines'));
  }
}

// -------------------------------------------------------------- detail popover

function buildRow(bucket, totalSpan, startOpen) {
  const row = el('div', 'pdb-row');
  const head = el('button', 'pdb-row-head');
  head.type = 'button';
  applyColor(head, bucket);

  const caret = el('span', 'pdb-caret', startOpen ? '▾' : '▸');
  head.append(
    caret,
    iconNode(bucket, 'pdb-icon'),
    el('span', 'pdb-label', bucket.label),
    el('span', 'pdb-files', `${exact(bucket.files)} ${bucket.files === 1 ? 'file' : 'files'}`),
    el('span', 'pdb-add', bucket.additions ? `+${exact(bucket.additions)}` : '—'),
    el('span', 'pdb-del', bucket.deletions ? `−${exact(bucket.deletions)}` : '—'),
    el('span', 'pdb-pct', totalSpan ? `${Math.round(((bucket.additions + bucket.deletions) / totalSpan) * 100)}%` : ''),
  );
  row.appendChild(head);

  // Every bucket expands. Multi-extension buckets show their extension mix;
  // a bucket that is already one extension shows the files instead.
  const detail = el('div', 'pdb-detail');
  detail.hidden = !startOpen;
  if (bucket.byExt.length > 1) {
    for (const ext of bucket.byExt) {
      const line = el('div', 'pdb-sub');
      line.append(
        el('span', 'pdb-sub-name', ext.ext),
        el('span', 'pdb-files', `${exact(ext.files)} ${ext.files === 1 ? 'file' : 'files'}`),
        el('span', 'pdb-add', ext.additions ? `+${exact(ext.additions)}` : '—'),
        el('span', 'pdb-del', ext.deletions ? `−${exact(ext.deletions)}` : '—'),
      );
      detail.appendChild(line);
    }
  } else {
    for (const file of bucket.paths.slice(0, MAX_PATHS_SHOWN)) {
      // `#diff-<sha256 of the path>` is how GitHub anchors a file on that tab.
      const line = file.anchor ? el('a', 'pdb-sub pdb-sub-link') : el('div', 'pdb-sub');
      if (file.anchor) {
        line.href = `${filesTabHref()}#diff-${file.anchor}`;
        line.title = `${file.path} — open this file's diff`;
      }
      line.append(
        el('span', 'pdb-sub-name', file.path),
        el('span', 'pdb-add', file.additions ? `+${exact(file.additions)}` : '—'),
        el('span', 'pdb-del', file.deletions ? `−${exact(file.deletions)}` : '—'),
      );
      detail.appendChild(line);
    }
    if (bucket.files > MAX_PATHS_SHOWN) {
      detail.appendChild(el('div', 'pdb-sub pdb-more', `and ${exact(bucket.files - MAX_PATHS_SHOWN)} more`));
    }
  }
  row.appendChild(detail);

  head.addEventListener('click', () => {
    detail.hidden = !detail.hidden;
    caret.textContent = detail.hidden ? '▸' : '▾';
  });
  return row;
}

function buildPopover(focusLabel) {
  const box = el('div', 'pdb-popover');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Changed lines by file type');

  const { buckets, totals, warnings, configPath } = state.result;
  const span = totals.additions + totals.deletions;

  // The detail view always shows exact numbers: there is room for them here, and
  // this is where you come when the rounded figure was not enough.
  const header = el('div', 'pdb-head');
  header.append(
    el('span', 'pdb-head-total', `${exact(span)} lines`),
    el('span', 'pdb-head-sep', '·'),
    el('span', 'pdb-add', `+${exact(totals.additions)}`),
    el('span', 'pdb-del', `−${exact(totals.deletions)}`),
    el('span', 'pdb-head-sep', '·'),
    el('span', 'pdb-head-files', `${exact(totals.files)} ${totals.files === 1 ? 'file' : 'files'}`),
  );
  box.appendChild(header);

  if (buckets.length === 0) box.appendChild(el('div', 'pdb-empty', 'No changed lines to break down.'));

  const shown = buckets.slice(0, MAX_ROWS);
  for (const bucket of shown) box.appendChild(buildRow(bucket, span, bucket.label === focusLabel));

  if (buckets.length > shown.length) {
    const rest = buckets.slice(MAX_ROWS);
    const more = el('button', 'pdb-showmore', `Show ${rest.length} more`);
    more.type = 'button';
    more.addEventListener('click', () => {
      more.remove();
      for (const bucket of rest) box.appendChild(buildRow(bucket, span, bucket.label === focusLabel));
    });
    box.appendChild(more);
  }

  if (configPath) box.appendChild(el('div', 'pdb-foot', `Buckets from ${configPath}`));
  for (const warning of warnings ?? []) box.appendChild(el('div', 'pdb-warn', warning));
  return box;
}

function closePopover() {
  popover?.remove();
  popover = null;
}

/** Pin a floating box under `anchor`, right-aligned to it and kept on screen. */
function placeBelow(node, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = node.offsetWidth;
  node.style.top = `${rect.bottom + 6}px`;
  node.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
}

function positionPopover() {
  const anchor = document.getElementById(ROOT_ID);
  if (popover && anchor) placeBelow(popover, anchor);
}

function openPopover(focusLabel) {
  if (state.status !== 'ready') return;
  closePopover();
  popover = buildPopover(focusLabel);
  document.body.appendChild(popover);
  positionPopover();
}

document.addEventListener('click', (e) => {
  if (popover && !popover.contains(e.target) && !e.target.closest?.(`#${ROOT_ID}`)) closePopover();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePopover(); closeTooltip(); } });
window.addEventListener('resize', positionPopover);
window.addEventListener('scroll', () => { positionPopover(); closeTooltip(); }, true);

// ------------------------------------------------------------------- lifecycle

/** Inject or refresh the chips. Safe to call repeatedly; React re-renders drop
 *  our node and the observer below calls us again. */
function render() {
  if (!current) return;
  const group = findAnchor();
  if (!group) return;

  let root = document.getElementById(ROOT_ID);
  if (!root || !group.contains(root)) {
    root?.remove();
    root = el('span', 'pdb-root');
    root.id = ROOT_ID;
    group.appendChild(root);
    observeFit(root, group);
  }

  // Cheap, idempotent, and React re-renders wipe it, so redo it every pass.
  // With no breakdown to show, GitHub's own totals stay; the badge says why.
  if (state.status === 'error') showNativeStat(group);
  else hideNativeStat(group, root);

  // Repainting on every mutation tick would fight the browser and flicker the
  // chips, so skip when nothing we draw has actually changed.
  const signature = JSON.stringify([
    state.status,
    state.status === 'ready'
      ? [state.result.numbers, state.result.buckets.map((b) => [b.label, b.additions, b.deletions, b.color, b.icon?.name])]
      : state.error ?? null,
  ]);
  const changed = root.dataset.signature !== signature;
  if (changed) {
    root.dataset.signature = signature;
    paintState(root);
  }
  // Chips are painted by the fit pass, which decides how many of them there is
  // room for. Forced on a data change; otherwise it no-ops unless width moved.
  if (state.status === 'ready' && state.result.buckets.length) fitChips(root, group, { force: changed });
}

const samePr = (a, b) => !!a && !!b && a.owner === b.owner && a.repo === b.repo && a.number === b.number;

const RELOAD_MESSAGE = 'The extension was updated or reloaded since this page was opened. Reload the page to see the breakdown.';

/** Apply an answer, unless it's for a PR we've since navigated away from. */
function settle(target, next) {
  if (!samePr(current, target)) return;
  state = next;
  render();
}

function request() {
  const target = current;
  // Updating or reloading the extension orphans the copies of this script
  // already running in open tabs: every extension API throws from then on, and
  // the new version isn't injected until the page reloads. Now that the script
  // lives on every GitHub page, that is most open tabs after an update.
  if (!chrome.runtime?.id) {
    settle(target, { status: 'error', error: RELOAD_MESSAGE });
    return;
  }
  try {
    chrome.runtime.sendMessage({ type: 'pr-diff-breakdown:analyze', ...target }, (response) => {
      const failure = chrome.runtime.lastError;
      if (failure) {
        settle(target, {
          status: 'error',
          error: chrome.runtime?.id
            ? `Couldn't reach the extension's background worker (${failure.message}). Reload the page to try again.`
            : RELOAD_MESSAGE,
        });
      } else if (!response?.ok) {
        settle(target, { status: 'error', error: response?.error?.message ?? 'Could not read this diff.' });
      } else {
        settle(target, { status: 'ready', result: response.result });
      }
    });
  } catch {
    settle(target, { status: 'error', error: RELOAD_MESSAGE });
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'pr-diff-breakdown:update') return;
  settle(message, { status: 'ready', result: message.result });
});

chrome.storage.onChanged.addListener((changes, area) => {
  // Editing your overrides should re-bucket open tabs without a reload.
  if (area === 'sync' && changes.localConfig && current) request();
});

function sync() {
  const next = parseLocation();
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  current = next;
  if (!current) { closePopover(); return; }
  if (changed) {
    state = { status: 'loading' };
    closePopover();
    render();     // paint skeleton chips first so the header never shifts
    request();
  } else {
    render();
  }
}

for (const event of ['turbo:load', 'turbo:render', 'pjax:end', 'soft-nav:end', 'popstate']) {
  document.addEventListener(event, sync);
}

// React can re-render the header at any time, taking our chips with it.
// Re-check on a debounced mutation tick rather than fighting it.
let pending = 0;
new MutationObserver(() => {
  if (pending) return;
  pending = requestAnimationFrame(() => { pending = 0; sync(); });
}).observe(document.documentElement, { childList: true, subtree: true });

sync();
