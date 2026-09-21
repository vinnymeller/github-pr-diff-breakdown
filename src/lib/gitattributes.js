// Root .gitattributes reader. We only care about the handful of attributes that
// say "a human did not write this": the linguist-* family GitHub already uses to
// collapse diffs, plus the binary markers.
//
// v1 reads the repository-root file only. Nested .gitattributes are scoped to
// their directory and would need a tree walk to find; they cover a small enough
// slice of real repos that the extra request isn't worth it yet.

import { compileGlob } from './glob.js';

const INTERESTING = new Set([
  'linguist-generated',
  'linguist-vendored',
  'linguist-documentation',
  'diff',
  'binary',
]);

function parseAttr(token) {
  if (token.startsWith('-')) return [token.slice(1), false];
  if (token.startsWith('!')) return [token.slice(1), undefined];
  const eq = token.indexOf('=');
  if (eq === -1) return [token, true];
  const value = token.slice(eq + 1);
  if (value === 'true') return [token.slice(0, eq), true];
  if (value === 'false') return [token.slice(0, eq), false];
  return [token.slice(0, eq), value];
}

/** @returns {Array<{re: RegExp, attrs: Record<string, any>}>} in file order */
export function parseGitattributes(text) {
  const rules = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('[attr]')) continue;

    let pattern;
    let rest;
    if (line.startsWith('"')) {
      const end = line.indexOf('"', 1);
      if (end === -1) continue;
      pattern = line.slice(1, end);
      rest = line.slice(end + 1);
    } else {
      const sp = line.search(/\s/);
      if (sp === -1) continue; // a pattern with no attributes does nothing
      pattern = line.slice(0, sp);
      rest = line.slice(sp);
    }

    const attrs = {};
    for (const token of rest.trim().split(/\s+/)) {
      if (!token) continue;
      const [name, value] = parseAttr(token);
      if (INTERESTING.has(name)) attrs[name] = value;
    }
    if (Object.keys(attrs).length === 0) continue;

    try {
      rules.push({ re: compileGlob(pattern), attrs });
    } catch {
      // A pattern we can't compile is one rule lost, not a broken extension.
    }
  }
  return rules;
}

/**
 * Resolve attributes for one path. Git semantics: later lines win, so we apply
 * every matching rule in order rather than stopping at the first.
 */
export function attributesFor(rules, path) {
  const resolved = {};
  for (const rule of rules) {
    if (rule.re.test(path)) Object.assign(resolved, rule.attrs);
  }
  const on = (name) => resolved[name] === true || resolved[name] === 'true';
  return {
    generated: on('linguist-generated'),
    vendored: on('linguist-vendored'),
    documentation: on('linguist-documentation'),
    // `binary` is a git macro for `-diff -merge -text`; either spelling means
    // there are no countable lines.
    binary: on('binary') || resolved.diff === false,
  };
}
