// Number presentation. Lives here rather than in the content script so it can
// be tested directly: the content script cannot use ES imports, so the service
// worker formats and ships the strings.

/**
 * 1,296 -> "1.3k". Numbers below 1000 stay exact, where every digit still
 * carries information; above that the precision is noise on a glanceable chip.
 */
export function abbreviate(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}m`;
}

/** @param {'abbreviated'|'full'} mode */
export function formatCount(n, mode) {
  return mode === 'full' ? n.toLocaleString('en-US') : abbreviate(n);
}
