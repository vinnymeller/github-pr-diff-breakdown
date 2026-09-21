// Schema validation for bucket rules, shared by the repo file and the options
// page. The repo file is untrusted input — it arrives from whatever is checked
// into a repository someone linked you to — so everything is bounded: no regex,
// capped pattern counts and lengths, labels rendered as text, colors restricted
// to a named palette or a plain hex.

import { parseYaml } from './yaml.js';
import { compileGlob } from './glob.js';
import { ICON_PATHS } from './icons.js';

export const CONFIG_PATHS = ['.github/pr-diff-breakdown.yml', '.github/pr-diff-breakdown.yaml'];

export const NUMBER_FORMATS = new Set(['abbreviated', 'full']);
const TOP_LEVEL_KEYS = new Set(['version', 'buckets', 'numbers']);
const BUCKET_KEYS = new Set(['label', 'patterns', 'color', 'icon', 'scope']);
const SCOPE_ENTRY = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/;
const MAX_ICON_DATA_LENGTH = 8192;
const DATA_ICON = /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i;

const MAX_BUCKETS = 100;
const MAX_PATTERNS = 500;
const MAX_LABEL_LENGTH = 24;

export const PALETTE = {
  blue: '#4493f8',
  purple: '#ab7df8',
  green: '#2da44e',
  yellow: '#d4a72c',
  red: '#f0533f',
  teal: '#1eafc0',
  orange: '#e8830d',
  gray: '#7d8590',
  pink: '#ec6cb9',
};

/**
 * Where a rule applies: `owner` for a whole organisation, `owner/repo` for one
 * repository. `owner/*` is accepted as a more explicit spelling of `owner`.
 * Stored lower-cased, since GitHub treats these case-insensitively.
 *
 * Mainly for local overrides — a repo's own config file already knows which
 * repository it is in — but allowed in both so there is one rule to explain.
 */
function validScope(value, where, errors) {
  if (value == null) return null;
  const raw = Array.isArray(value) ? value : [value];
  const scope = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') { errors.push(`${where}: scope entries must be text`); continue; }
    const trimmed = entry.trim().replace(/\/\*$/, '');
    if (!SCOPE_ENTRY.test(trimmed)) {
      errors.push(`${where}: scope ${JSON.stringify(entry)} must be "owner" or "owner/repo"`);
      continue;
    }
    scope.push(trimmed.toLowerCase());
  }
  return scope.length ? scope : null;
}

/** Does a rule's scope cover this repository? */
export function matchesScope(scope, owner, repo) {
  if (!scope) return true;            // unscoped rules apply everywhere
  if (!owner || !repo) return false;  // scoped rule, unknown repo: don't guess
  const o = String(owner).toLowerCase();
  return scope.includes(o) || scope.includes(`${o}/${String(repo).toLowerCase()}`);
}

/**
 * An icon is a bundled name or a self-contained data: URI. Remote URLs are
 * rejected outright: GitHub's Content-Security-Policy restricts img-src to
 * data:, blob: and its own hosts, so they could never render — and a repo
 * config pointing at a third-party URL would beacon every reviewer who opened
 * the pull request.
 */
function validIcon(value, where, errors) {
  if (value == null) return null;
  if (typeof value !== 'string') { errors.push(`${where}: icon must be a string`); return null; }
  const icon = value.trim();
  if (icon in ICON_PATHS) return { kind: 'builtin', name: icon };
  if (/^[a-z][a-z0-9+.-]*:/i.test(icon) && !DATA_ICON.test(icon)) {
    errors.push(`${where}: icon must be a bundled name or a data: URI — GitHub's Content-Security-Policy blocks images from other hosts, so a remote URL cannot render`);
    return null;
  }
  if (DATA_ICON.test(icon)) {
    if (icon.length > MAX_ICON_DATA_LENGTH) {
      errors.push(`${where}: data: icon is too large (${icon.length} characters, max ${MAX_ICON_DATA_LENGTH})`);
      return null;
    }
    return { kind: 'data', url: icon };
  }
  errors.push(`${where}: unknown icon ${JSON.stringify(icon)} — use a bundled name such as python or markdown, or a data: URI`);
  return null;
}

function validColor(value, where, errors) {
  if (value == null) return null;
  if (typeof value !== 'string') { errors.push(`${where}: color must be a string`); return null; }
  if (value in PALETTE) return PALETTE[value];
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  errors.push(`${where}: color must be a hex value like #4493f8 or one of ${Object.keys(PALETTE).join(', ')}`);
  return null;
}

/**
 * Turn a parsed config object into compiled rules.
 * A rule with a null label is a deliberate "no match, keep falling through",
 * which is how a local override undoes a repo rule without redefining it.
 *
 * @returns {{rules: Array<{label: string|null, color: string|null, re: RegExp[]}>, errors: string[]}}
 */
export function validateConfig(data, source = 'config') {
  const errors = [];
  const rules = [];
  if (data == null) return { rules, errors, settings: {} };
  if (typeof data !== 'object' || Array.isArray(data)) {
    return { rules, errors: [`${source}: expected a mapping at the top level`], settings: {} };
  }
  if (data.version !== undefined && data.version !== 1) {
    errors.push(`${source}: unsupported version ${JSON.stringify(data.version)} (this extension understands version 1)`);
    return { rules, errors, settings: {} };
  }
  for (const key of Object.keys(data)) {
    // A typo like "bucket:" would otherwise parse fine and quietly do nothing.
    if (!TOP_LEVEL_KEYS.has(key)) {
      errors.push(`${source}: unknown key ${JSON.stringify(key)} (expected ${[...TOP_LEVEL_KEYS].join(', ')})`);
    }
  }

  const settings = {};
  if (data.numbers !== undefined && data.numbers !== null) {
    if (NUMBER_FORMATS.has(data.numbers)) settings.numbers = data.numbers;
    else errors.push(`${source}: "numbers" must be ${[...NUMBER_FORMATS].map((f) => JSON.stringify(f)).join(' or ')}`);
  }

  const buckets = data.buckets;
  if (buckets === undefined || buckets === null) return { rules, errors, settings };
  if (!Array.isArray(buckets)) return { rules, errors: [`${source}: "buckets" must be a list`], settings };
  if (buckets.length > MAX_BUCKETS) {
    errors.push(`${source}: too many buckets (${buckets.length}, max ${MAX_BUCKETS})`);
    return { rules, errors, settings };
  }

  let patternCount = 0;
  buckets.forEach((bucket, idx) => {
    const where = `${source}: buckets[${idx}]`;
    if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) {
      errors.push(`${where}: expected a mapping with "label" and "patterns"`);
      return;
    }
    for (const key of Object.keys(bucket)) {
      // Catches "scopes:" and friends, which would otherwise be ignored in silence.
      if (!BUCKET_KEYS.has(key)) errors.push(`${where}: unknown key ${JSON.stringify(key)} (expected ${[...BUCKET_KEYS].join(', ')})`);
    }

    let label = bucket.label;
    if (label === undefined) { errors.push(`${where}: missing "label" (use "label: ~" to mean "ignore these files")`); return; }
    if (label === null || label === false) label = null;
    else if (typeof label === 'number') label = String(label);
    else if (typeof label !== 'string') { errors.push(`${where}: label must be text, or ~ to fall through`); return; }
    if (typeof label === 'string') {
      label = label.trim();
      if (label === '') { errors.push(`${where}: label is empty`); return; }
      if (label.length > MAX_LABEL_LENGTH) label = label.slice(0, MAX_LABEL_LENGTH);
    }

    const patterns = bucket.patterns;
    if (!Array.isArray(patterns) || patterns.length === 0) { errors.push(`${where}: "patterns" must be a non-empty list`); return; }
    patternCount += patterns.length;
    if (patternCount > MAX_PATTERNS) { errors.push(`${source}: too many patterns (max ${MAX_PATTERNS})`); return; }

    const re = [];
    for (const pattern of patterns) {
      if (typeof pattern !== 'string') { errors.push(`${where}: pattern ${JSON.stringify(pattern)} is not text`); continue; }
      try { re.push(compileGlob(pattern)); }
      catch (e) { errors.push(`${where}: ${JSON.stringify(pattern)} — ${e.message}`); }
    }
    if (re.length) {
      rules.push({
        label,
        color: validColor(bucket.color, where, errors),
        icon: validIcon(bucket.icon, where, errors),
        scope: validScope(bucket.scope, where, errors),
        re,
      });
    }
  });

  return { rules, errors, settings };
}

/** Parse + validate a config file's text. Never throws. */
export function parseConfigFile(text, source) {
  let data;
  try {
    data = parseYaml(text);
  } catch (e) {
    return { rules: [], errors: [`${source}: ${e.message}`], settings: {} };
  }
  return validateConfig(data, source);
}
