// Unified-diff parser for GitHub's `/pull/N.diff` payload.
//
// The counts this produces are the same ones GitHub reports (both are just
// added/removed lines in the diff), so the breakdown always sums to the number
// already in the page header. That matters: a widget whose parts disagree with
// the total it sits next to is worse than no widget.

/** Undo git's C-style path quoting: "a/caf\303\251.txt" -> a/café.txt */
function unquotePath(raw) {
  if (!raw.startsWith('"')) return raw;
  const body = raw.slice(1, raw.endsWith('"') ? -1 : undefined);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { bytes.push(body.charCodeAt(i)); continue; }
    const n = body[++i];
    const simple = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
    if (n in simple) { bytes.push(simple[n]); continue; }
    if (n >= '0' && n <= '7') { bytes.push(parseInt(body.slice(i, i + 3), 8)); i += 2; continue; }
    bytes.push(body.charCodeAt(i));
  }
  try {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  } catch {
    return body;
  }
}

/** Strip the a/ or b/ prefix git puts on diff paths. */
function stripPrefix(path) {
  return /^[ab]\//.test(path) ? path.slice(2) : path;
}

/**
 * The path out of a `---`/`+++` header.
 *
 * When a path contains a space, git appends a literal tab to these lines to
 * mark where the name ends. A tab *inside* a name is always C-escaped, so an
 * unescaped one is unambiguously that separator — without this, a file called
 * `docs/architecture docs/ADR-INDEX.md` lands in a phantom `md\t` bucket of its
 * own, next to the real `md` one.
 */
function headerPath(raw) {
  if (raw.startsWith('"')) return stripPrefix(unquotePath(raw));
  const tab = raw.indexOf('\t');
  return stripPrefix(tab === -1 ? raw : raw.slice(0, tab));
}

/**
 * Recover both paths from a `diff --git a/X b/Y` line. Git only quotes paths
 * containing control characters or quotes, so a plain space stays unescaped and
 * the line is genuinely ambiguous. For the overwhelmingly common same-path case
 * we split down the middle; otherwise we fall back to the first ` b/`. Either
 * way the ---/+++ and rename headers below correct us when they exist.
 */
function parseDiffGitLine(rest) {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ', 1);
    if (end !== -1) {
      return {
        oldPath: stripPrefix(unquotePath(rest.slice(0, end + 1))),
        newPath: stripPrefix(unquotePath(rest.slice(end + 2))),
      };
    }
  }
  if (rest.length % 2 === 1) {
    const half = (rest.length - 1) / 2;
    if (rest[half] === ' ' && rest.slice(0, half).slice(2) === rest.slice(half + 1).slice(2)) {
      const p = stripPrefix(rest.slice(0, half));
      return { oldPath: p, newPath: p };
    }
  }
  const at = rest.indexOf(' b/');
  if (at === -1) return { oldPath: stripPrefix(rest), newPath: stripPrefix(rest) };
  return { oldPath: stripPrefix(rest.slice(0, at)), newPath: stripPrefix(rest.slice(at + 1)) };
}

const HUNK = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * @param {string} text raw unified diff
 * @returns {{files: Array<{path,oldPath,additions,deletions,binary,status}>}}
 */
export function parseDiff(text) {
  const lines = text.split('\n');
  const files = [];
  let f = null;

  // Hunk state. We consume exactly the number of lines the @@ header promises,
  // which is what stops a diff *of a diff* (content lines starting with `---`,
  // `+++` or `diff --git`) from being misread as file headers.
  let oldRem = 0;
  let newRem = 0;

  const push = () => { if (f) files.push(f); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (oldRem > 0 || newRem > 0) {
      const c = line[0];
      if (c === '+') { f.additions++; newRem--; }
      else if (c === '-') { f.deletions++; oldRem--; }
      else if (c === '\\') { /* "\ No newline at end of file" belongs to no side */ }
      else if (c === ' ' || line === '') { oldRem--; newRem--; }
      else { oldRem = 0; newRem = 0; i--; } // malformed: fall back to header scanning
      continue;
    }

    if (line.startsWith('diff --git ')) {
      push();
      const { oldPath, newPath } = parseDiffGitLine(line.slice('diff --git '.length));
      f = { path: newPath, oldPath, additions: 0, deletions: 0, binary: false, status: 'modified' };
      continue;
    }
    if (!f) continue;

    const m = HUNK.exec(line);
    if (m) {
      oldRem = m[2] === undefined ? 1 : Number(m[2]);
      newRem = m[4] === undefined ? 1 : Number(m[4]);
      continue;
    }

    if (line.startsWith('--- ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') f.oldPath = headerPath(p);
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') f.path = headerPath(p);
    } else if (line.startsWith('rename from ')) {
      f.oldPath = unquotePath(line.slice('rename from '.length));
      f.status = 'renamed';
    } else if (line.startsWith('rename to ')) {
      f.path = unquotePath(line.slice('rename to '.length));
      f.status = 'renamed';
    } else if (line.startsWith('new file mode')) {
      f.status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      f.status = 'deleted';
    } else if (line.startsWith('GIT binary patch') || /^Binary files? .* differ$/.test(line)) {
      f.binary = true;
      // A literal binary patch is base85 blocks we neither can nor want to
      // count; skip to the next file header.
      while (i + 1 < lines.length && !lines[i + 1].startsWith('diff --git ')) i++;
    }
  }
  push();

  // A deleted file's surviving path is its old one.
  for (const file of files) if (!file.path && file.oldPath) file.path = file.oldPath;
  return { files };
}
