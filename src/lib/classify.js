// Turns parsed files into display buckets by walking the precedence chain:
//
//   local rules  ->  repo rules  ->  .gitattributes  ->  file extension
//
// Resolution is per file, not per layer: adding one local rule reclassifies the
// files it names and leaves everything else on the team's config. A rule with a
// null label short-circuits the remaining rules and drops the file to the
// default layer, so you can undo a repo rule without restating it.

import { attributesFor } from './gitattributes.js';
import { PALETTE, matchesScope } from './config.js';
import { ICON_PATHS, ICON_COLORS, iconForExtension } from './icons.js';

/**
 * Buckets that sink below the rest: what you are not being asked to read.
 * These are plain label names, so a config rule with `label: generated` merges
 * into the generated bucket and inherits its striped treatment.
 */
export const DEMOTED = new Set(['generated', 'vendored', 'binary']);

/** Colors are per-theme so brand colors stay legible in light and dark. */
const normalizeColor = (color) => (typeof color === 'string' ? { light: color, dark: color } : color);

const AUTO_COLORS = [PALETTE.blue, PALETTE.purple, PALETTE.green, PALETTE.yellow, PALETTE.teal, PALETTE.orange, PALETTE.pink, PALETTE.red];
const NEUTRAL = PALETTE.gray;
const MAX_PATHS_PER_BUCKET = 100;

/**
 * The label a file gets from its own name when nothing else claimed it.
 * Extensionless files and dotfiles keep their basename, because "Dockerfile"
 * and ".gitignore" are more useful labels than "no extension".
 */
export function extensionOf(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return base || 'other';
  return base.slice(dot + 1).toLowerCase();
}

function defaultLabel(file, attrs) {
  if (attrs.generated) return 'generated';
  if (attrs.vendored) return 'vendored';
  if (attrs.documentation) return 'docs';
  if (attrs.binary || file.binary) return 'binary';
  return extensionOf(file.path);
}

/**
 * @param {object} args
 * @param {Array} args.files            parsed diff files
 * @param {Array} args.localRules       compiled rules from the options page
 * @param {Array} args.repoRules        compiled rules from .github/pr-diff-breakdown.yml
 * @param {Array} args.gitattributes    compiled .gitattributes rules
 * @param {{owner: string, name: string}} [args.repo]  which repository this PR is in
 */
export function classify({ files, localRules = [], repoRules = [], gitattributes = [], repo = null }) {
  // Scoped rules drop out before the precedence walk, so everything downstream
  // sees a plain ordered list and the first-match-wins logic is untouched.
  const rules = [...localRules, ...repoRules]
    .filter((rule) => matchesScope(rule.scope, repo?.owner, repo?.name));
  const byLabel = new Map();
  let additions = 0;
  let deletions = 0;

  for (const file of files) {
    const attrs = attributesFor(gitattributes, file.path);

    let label = null;
    let color = null;
    let icon = null;
    let matched = false;
    for (const rule of rules) {
      if (!rule.re.some((re) => re.test(file.path))) continue;
      matched = true;
      label = rule.label;      // null => fall through to the default layer
      color = rule.color;
      icon = rule.icon;
      break;
    }
    if (!matched || label === null) {
      label = defaultLabel(file, attrs);
      color = null;
      icon = null;
    }

    let bucket = byLabel.get(label);
    if (!bucket) {
      bucket = { label, color, icon, files: 0, additions: 0, deletions: 0, byExt: new Map(), paths: [] };
      byLabel.set(label, bucket);
    }
    if (!bucket.color && color) bucket.color = color;
    if (!bucket.icon && icon) bucket.icon = icon;

    bucket.files++;
    bucket.additions += file.additions;
    bucket.deletions += file.deletions;
    additions += file.additions;
    deletions += file.deletions;

    const ext = extensionOf(file.path);
    const seen = bucket.byExt.get(ext) || { ext, files: 0, additions: 0, deletions: 0 };
    seen.files++;
    seen.additions += file.additions;
    seen.deletions += file.deletions;
    bucket.byExt.set(ext, seen);

    if (bucket.paths.length < MAX_PATHS_PER_BUCKET) {
      bucket.paths.push({ path: file.path, additions: file.additions, deletions: file.deletions, status: file.status });
    }
  }

  const total = (b) => b.additions + b.deletions;
  const buckets = [...byLabel.values()].sort((a, b) => {
    const demoted = Number(DEMOTED.has(a.label)) - Number(DEMOTED.has(b.label));
    if (demoted !== 0) return demoted;
    if (total(b) !== total(a)) return total(b) - total(a);
    if (b.files !== a.files) return b.files - a.files;
    return a.label.localeCompare(b.label);
  });

  // Icons and colors are resolved after sorting so the busiest bucket always
  // gets the first palette entry and the picture stays stable across PRs.
  let next = 0;
  for (const bucket of buckets) {
    bucket.demoted = DEMOTED.has(bucket.label);

    // Default buckets are named after their extension, so the label itself says
    // which glyph to use. Custom buckets get one only if the config set it.
    if (!bucket.icon) {
      const slug = iconForExtension(bucket.label);
      if (slug) bucket.icon = { kind: 'builtin', name: slug };
    }
    if (bucket.icon?.kind === 'builtin') {
      // Copy, so we never write the resolved path back onto the shared rule,
      // and carry the path data itself: the content script has no imports.
      bucket.icon = { kind: 'builtin', name: bucket.icon.name, path: ICON_PATHS[bucket.icon.name] };
    }

    if (!bucket.color) {
      const brand = bucket.icon?.kind === 'builtin' ? ICON_COLORS[bucket.icon.name] : null;
      if (brand) bucket.color = brand;
      else if (bucket.demoted) bucket.color = NEUTRAL;
      else bucket.color = AUTO_COLORS[next++ % AUTO_COLORS.length];
    }
    bucket.color = normalizeColor(bucket.color);

    bucket.byExt = [...bucket.byExt.values()].sort((a, b) => total(b) - total(a));
  }

  return { buckets, totals: { additions, deletions, files: files.length } };
}
