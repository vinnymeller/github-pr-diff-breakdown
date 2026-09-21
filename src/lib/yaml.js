// A deliberately small YAML subset, enough for the config schema and nothing
// more. Bundling js-yaml would mean adopting a build step for a file that is
// three keys deep; instead we support block maps, block sequences, flow
// sequences and plain scalars, and throw a pointed error with a line number on
// anything else. Failing loudly beats a silent misparse of a team's config.

class YamlError extends SyntaxError {
  constructor(message, lineNo) {
    super(`line ${lineNo}: ${message}`);
    this.lineNo = lineNo;
  }
}

/** Strip an unquoted trailing `# comment`. */
function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

function parseScalar(raw, lineNo) {
  const s = raw.trim();
  if (s === '') return null;
  if (s[0] === '"' || s[0] === "'") {
    const q = s[0];
    if (s.length < 2 || s[s.length - 1] !== q) throw new YamlError('unterminated quoted string', lineNo);
    const body = s.slice(1, -1);
    return q === '"' ? body.replace(/\\(.)/g, '$1') : body.replace(/''/g, "'");
  }
  if (s[0] === '{') throw new YamlError('flow mappings ({...}) are not supported', lineNo);
  if (s[0] === '|' || s[0] === '>') throw new YamlError('block scalars (| and >) are not supported', lineNo);
  if (s[0] === '&' || s[0] === '*') throw new YamlError('anchors and aliases are not supported', lineNo);

  if (s[0] === '[') {
    if (!s.endsWith(']')) throw new YamlError('unterminated flow sequence', lineNo);
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    const items = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (quote) {
        if (c === '\\' && quote === '"') i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '[') depth++;
      else if (c === ']') depth--;
      else if (c === ',' && depth === 0) { items.push(parseScalar(inner.slice(start, i), lineNo)); start = i + 1; }
    }
    items.push(parseScalar(inner.slice(start), lineNo));
    return items;
  }

  if (s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE' || s === 'no' || s === 'off') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}

/** Split `key: value`, respecting quotes. Returns null if the line is not a mapping entry. */
function splitKey(content, lineNo) {
  let quote = null;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ':' && (i + 1 === content.length || /\s/.test(content[i + 1]))) {
      const key = content.slice(0, i).trim();
      if (key === '') return null; // ": value" is not a mapping entry; let the caller report it
      return { key: String(parseScalar(key, lineNo)), rest: content.slice(i + 1).trim() };
    }
  }
  return null;
}

export function parseYaml(text) {
  if (text.includes('\t')) {
    const lineNo = text.slice(0, text.indexOf('\t')).split('\n').length;
    throw new YamlError('tabs are not valid YAML indentation; use spaces', lineNo);
  }

  const lines = [];
  text.split('\n').forEach((raw, idx) => {
    const content = stripComment(raw).replace(/\s+$/, '');
    if (content.trim() === '' || content.trim() === '---') return;
    lines.push({ indent: content.length - content.trimStart().length, content: content.trim(), lineNo: idx + 1 });
  });
  if (lines.length === 0) return null;

  let i = 0;

  function parseBlock(indent) {
    return lines[i].content.startsWith('-') ? parseSeq(indent) : parseMap(indent);
  }

  function parseMap(indent) {
    const out = {};
    while (i < lines.length && lines[i].indent >= indent) {
      if (lines[i].indent > indent) throw new YamlError('unexpected indentation', lines[i].lineNo);
      const { content, lineNo } = lines[i];
      const split = splitKey(content, lineNo);
      if (!split) throw new YamlError(`expected "key: value", got ${JSON.stringify(content)}`, lineNo);
      i++;
      if (split.rest === '') {
        // Value is a nested block, or an explicit empty (null).
        out[split.key] = i < lines.length && lines[i].indent > indent ? parseBlock(lines[i].indent) : null;
      } else {
        out[split.key] = parseScalar(split.rest, lineNo);
      }
    }
    return out;
  }

  function parseSeq(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].content.startsWith('-')) {
      const { content, lineNo } = lines[i];
      if (content !== '-' && content[1] !== ' ') throw new YamlError('expected a space after "-"', lineNo);
      const rest = content.slice(1).trim();
      if (rest === '') {
        i++;
        out.push(i < lines.length && lines[i].indent > indent ? parseBlock(lines[i].indent) : null);
        continue;
      }
      // `- key: value` opens a map whose keys align with the value's column.
      const restCol = indent + content.slice(1).indexOf(rest) + 1;
      if (splitKey(rest, lineNo)) {
        lines[i] = { indent: restCol, content: rest, lineNo };
        out.push(parseMap(restCol));
      } else {
        i++;
        out.push(parseScalar(rest, lineNo));
      }
    }
    return out;
  }

  const value = parseBlock(lines[0].indent);
  if (i < lines.length) throw new YamlError('unexpected content after end of document', lines[i].lineNo);
  return value;
}
