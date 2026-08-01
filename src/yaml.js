/**
 * A focused parser for the YAML subset that pnpm actually emits in pnpm-lock.yaml.
 *
 * Why not a YAML library: this project has zero runtime dependencies on purpose. A lockfile
 * diff Action that pulls in a transitive dependency tree to read lockfiles is a slightly
 * absurd object, and the audience for this tool is people who care about that. pnpm writes
 * its lockfile with js-yaml in a deliberately narrow style, so the accepted grammar is small
 * and can be enumerated:
 *
 *   - block mappings with 2-space indentation
 *   - bare, single-quoted and double-quoted scalar keys and values
 *   - block sequences (`- item`)
 *   - inline flow mappings and sequences on one line: `{a: b, c: d}`, `[a, b]`
 *   - blank lines and whole-line `#` comments
 *
 * Everything outside that grammar throws. Anchors, aliases, block scalars (`|`, `>`),
 * multi-document markers, tabs and complex keys are all rejected rather than guessed at,
 * because a lockfile parser that guesses produces a diff that is quietly wrong.
 *
 * The parser is deliberately not a general YAML implementation and should not be used as one.
 */
import { LockfileError } from './errors.js';

const REJECTED_PREFIXES = [
  ['---', 'multi-document YAML'],
  ['...', 'multi-document YAML'],
  ['? ', 'complex mapping keys'],
  ['&', 'YAML anchors'],
  ['*', 'YAML aliases'],
  ['!', 'YAML tags'],
];

/** Tokenise into {indent, text, line} for non-blank, non-comment lines. */
function tokenise(text, file) {
  const tokens = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].replace(/\r$/, '');
    if (raw.trim() === '' || /^\s*#/.test(raw)) continue;
    if (/^ *\t/.test(raw) || /^\t/.test(raw)) {
      throw new LockfileError('tab used for indentation', { file, line: i + 1 });
    }
    const indent = raw.length - raw.replace(/^ +/, '').length;
    if (indent % 2 !== 0) {
      throw new LockfileError(`odd indentation of ${indent} spaces`, { file, line: i + 1 });
    }
    const body = raw.slice(indent);
    for (const [prefix, why] of REJECTED_PREFIXES) {
      if (body === prefix.trim() || body.startsWith(prefix)) {
        throw new LockfileError(`${why} are not supported by this parser`, { file, line: i + 1 });
      }
    }
    tokens.push({ indent, text: body, line: i + 1 });
  }
  return tokens;
}

/** Read a quoted scalar starting at s[0]. Returns [value, charsConsumed]. */
function readQuoted(s, quote, file, line) {
  let out = '';
  let i = 1;
  while (i < s.length) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") { out += "'"; i += 2; continue; }
        return [out, i + 1];
      }
      out += c;
      i += 1;
    } else {
      if (c === '\\') {
        const next = s[i + 1];
        if (next === undefined) break;
        out += ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' })[next] ?? next;
        i += 2;
        continue;
      }
      if (c === '"') return [out, i + 1];
      out += c;
      i += 1;
    }
  }
  throw new LockfileError('unterminated quoted string', { file, line });
}

/** Parse an inline flow collection starting at index 0 of s. Returns [value, charsConsumed]. */
function readFlow(s, file, line) {
  const open = s[0];
  const close = open === '{' ? '}' : ']';
  const isMap = open === '{';
  const container = isMap ? {} : [];
  let i = 1;
  const skipSpace = () => { while (s[i] === ' ') i += 1; };
  skipSpace();
  if (s[i] === close) return [container, i + 1];
  while (i < s.length) {
    skipSpace();
    let key = null;
    if (isMap) {
      [key, i] = readFlowToken(s, i, file, line, true);
      skipSpace();
      if (s[i] !== ':') {
        throw new LockfileError(`expected ':' in flow mapping near "${s.slice(i, i + 20)}"`, { file, line });
      }
      i += 1;
      skipSpace();
    }
    let value;
    [value, i] = readFlowToken(s, i, file, line, false);
    if (isMap) container[key] = value; else container.push(value);
    skipSpace();
    if (s[i] === ',') { i += 1; continue; }
    if (s[i] === close) return [container, i + 1];
    throw new LockfileError(`unterminated flow collection near "${s.slice(i, i + 20)}"`, { file, line });
  }
  throw new LockfileError('unterminated flow collection', { file, line });
}

/** One scalar or nested collection inside a flow collection. Returns [value, nextIndex]. */
function readFlowToken(s, start, file, line, isKey) {
  let i = start;
  const c = s[i];
  if (c === "'" || c === '"') {
    const [value, used] = readQuoted(s.slice(i), c, file, line);
    return [value, i + used];
  }
  if (c === '{' || c === '[') {
    const [value, used] = readFlow(s.slice(i), file, line);
    return [value, i + used];
  }
  // Bare scalar: runs until a comma or the closing bracket at this nesting level. A colon
  // only terminates a key, so `tarball: https://host/x` keeps its scheme intact.
  let out = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === ',' || ch === '}' || ch === ']') break;
    if (isKey && ch === ':') break;
    out += ch;
    i += 1;
  }
  return [coerce(out.trim()), i];
}

/** YAML-ish scalar coercion, restricted to what pnpm emits. */
function coerce(raw) {
  if (raw === '') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === '~') return null;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** Parse the scalar (or inline collection) that follows `key: ` on one line. */
function parseInlineValue(text, file, line) {
  const s = text.trim();
  if (s === '') return null;
  if (s === '|' || s === '>' || s.startsWith('|') || s.startsWith('>')) {
    throw new LockfileError('block scalars are not supported by this parser', { file, line });
  }
  if (s.startsWith('&') || s.startsWith('*')) {
    throw new LockfileError('YAML anchors and aliases are not supported by this parser', { file, line });
  }
  if (s[0] === '{' || s[0] === '[') {
    const [value, used] = readFlow(s, file, line);
    const rest = s.slice(used).trim();
    if (rest !== '' && !rest.startsWith('#')) {
      throw new LockfileError(`trailing content after flow collection: "${rest}"`, { file, line });
    }
    return value;
  }
  if (s[0] === "'" || s[0] === '"') {
    const [value, used] = readQuoted(s, s[0], file, line);
    const rest = s.slice(used).trim();
    if (rest !== '' && !rest.startsWith('#')) {
      throw new LockfileError(`trailing content after quoted scalar: "${rest}"`, { file, line });
    }
    return value;
  }
  return coerce(s);
}

/** Split `key: value` at the key boundary. Returns {key, rest, hasColon}. */
function splitKey(text, file, line) {
  if (text[0] === "'" || text[0] === '"') {
    const [key, used] = readQuoted(text, text[0], file, line);
    const after = text.slice(used);
    if (!after.startsWith(':')) {
      throw new LockfileError('quoted key is not followed by ":"', { file, line });
    }
    return { key, rest: after.slice(1) };
  }
  // Bare key: ends at the first ":" that is followed by a space or end of line. This is what
  // lets `foo@1.0.0: {}` and `https://host/x: y` both work.
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== ':') continue;
    const next = text[i + 1];
    if (next === undefined || next === ' ') {
      return { key: text.slice(0, i), rest: text.slice(i + 1) };
    }
  }
  throw new LockfileError(`line is neither "key:" nor "- item": "${text.slice(0, 60)}"`, { file, line });
}

function parseBlock(tokens, state, indent, file) {
  const first = tokens[state.i];
  if (first.text.startsWith('- ') || first.text === '-') {
    const list = [];
    while (state.i < tokens.length && tokens[state.i].indent === indent) {
      const token = tokens[state.i];
      if (!token.text.startsWith('- ') && token.text !== '-') break;
      const inline = token.text === '-' ? '' : token.text.slice(2);
      state.i += 1;
      if (inline.trim() === '') {
        if (state.i < tokens.length && tokens[state.i].indent > indent) {
          list.push(parseBlock(tokens, state, tokens[state.i].indent, file));
        } else {
          list.push(null);
        }
      } else {
        list.push(parseInlineValue(inline, file, token.line));
      }
    }
    return list;
  }

  const map = {};
  while (state.i < tokens.length && tokens[state.i].indent === indent) {
    const token = tokens[state.i];
    if (token.text.startsWith('- ')) {
      throw new LockfileError('sequence item where a mapping key was expected', { file, line: token.line });
    }
    const { key, rest } = splitKey(token.text, file, token.line);
    state.i += 1;
    if (rest.trim() === '') {
      if (state.i < tokens.length && tokens[state.i].indent > indent) {
        map[key] = parseBlock(tokens, state, tokens[state.i].indent, file);
      } else {
        map[key] = null;
      }
    } else {
      map[key] = parseInlineValue(rest, file, token.line);
      if (state.i < tokens.length && tokens[state.i].indent > indent) {
        throw new LockfileError(
          `key "${key}" has both an inline value and an indented block`,
          { file, line: tokens[state.i].line },
        );
      }
    }
  }
  return map;
}

/**
 * Parse the pnpm-lock subset of YAML. Throws LockfileError on anything unrecognised.
 * @returns {object}
 */
export function parseYamlSubset(text, file = 'pnpm-lock.yaml') {
  const tokens = tokenise(text, file);
  if (tokens.length === 0) throw new LockfileError('file is empty', { file });
  if (tokens[0].indent !== 0) {
    throw new LockfileError('file starts with an indented line', { file, line: tokens[0].line });
  }
  const state = { i: 0 };
  const value = parseBlock(tokens, state, 0, file);
  if (state.i !== tokens.length) {
    throw new LockfileError(
      `unexpected indentation, ${tokens.length - state.i} line(s) could not be attached`,
      { file, line: tokens[state.i].line },
    );
  }
  return value;
}
