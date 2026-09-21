// gitignore-style glob matching, shared by .gitattributes and the repo/local
// config. Deliberately NOT regex: patterns come from a checked-in repo file we
// do not control, and user-supplied regex is a ReDoS footgun.

const MAX_PATTERN_LENGTH = 512;

/**
 * Compile one gitignore-style pattern to an anchored RegExp over a full,
 * slash-separated repo path (no leading slash).
 *
 * Supported: `*` (within a segment), `?`, `[abc]` / `[!abc]`, `**`, a leading
 * `/` anchor, and a trailing `/` meaning "everything under this directory".
 * A pattern with no slash in it matches the basename at any depth, which is
 * what makes a bare `*.py` behave the way everyone expects.
 */
export function compileGlob(pattern) {
  if (typeof pattern !== 'string') throw new TypeError('glob pattern must be a string');
  if (pattern.length > MAX_PATTERN_LENGTH) throw new RangeError(`glob pattern exceeds ${MAX_PATTERN_LENGTH} characters`);
  if (pattern.startsWith('!')) throw new SyntaxError('negated globs (!) are not supported');

  let p = pattern.trim();
  if (p === '') throw new SyntaxError('empty glob pattern');

  // Trailing slash means "the directory and all of its contents".
  if (p.endsWith('/')) p += '**';

  // gitignore: a slash anywhere but the very end anchors to the repo root.
  const anchored = p.slice(0, -1).includes('/');
  if (p.startsWith('/')) p = p.slice(1);

  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      const doubled = p[i + 1] === '*';
      if (doubled) {
        i++;
        if (p[i + 1] === '/') {
          i++;
          re += '(?:[^/]+/)*'; // `**/` spans zero or more directories
        } else {
          re += '.*'; // trailing `**`
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const end = p.indexOf(']', i + 1);
      if (end === -1) { re += '\\['; continue; }
      let cls = p.slice(i + 1, end);
      if (cls.startsWith('!')) cls = '^' + cls.slice(1);
      re += '[' + cls.replace(/\\/g, '\\\\') + ']';
      i = end;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  return new RegExp('^' + (anchored ? '' : '(?:.*/)?') + re + '$');
}

/** Compile a list of patterns once; returns a `(path) => boolean` matcher. */
export function compileGlobs(patterns) {
  const compiled = patterns.map(compileGlob);
  return (path) => compiled.some((re) => re.test(path));
}
