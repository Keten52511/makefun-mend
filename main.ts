// mend: applies an edit an AI model wrote (unified diff, SEARCH/REPLACE blocks,
// V4A patch, or JSON text-editor tool calls) to a tree of text files, per SPEC.md.
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
// In a trial the grader runs this file with MAKEFUN_ENV_URL set; the last lines
// hand over to runner.ts then, and that hand-over is kept as the kit requires.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  constructor(line) {
    this.line = line;
  }
}
class Fail {
  constructor(code, path) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s) => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p) {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  constructor() {
    this.orig = new Map();
    this.now = new Map();
    this.moves = []; // [oldPath, newPath] of move edits that succeeded, in order
  }
  original(p) {
    if (!this.orig.has(p)) {
      let v = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p);
  }
  get(p) {
    return this.now.has(p) ? this.now.get(p) : this.original(p);
  }
}

/** A file's lines and line break (SPEC.md section 3). */
function splitFile(text) {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { br, lines: parts, final };
}
function joinFile(f) {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------- Section 5: matching lines ----------

const trimTrail = (s) => s.replace(/[ \t]+$/, '');
const trimBoth = (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s) => /^[ \t]*/.exec(s)[0];

function lineMatch(fileLine, patLine, tier) {
  if (tier === 0) return fileLine === patLine;
  if (tier === 1) return trimTrail(fileLine) === trimTrail(patLine);
  return trimBoth(fileLine) === trimBoth(patLine);
}

/** All start positions where O matches fileLines at the given tier, at or after `from`. */
function occurrencesAt(fl, O, tier, from) {
  const pos = [];
  for (let i = from; i + O.length <= fl.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (!lineMatch(fl[i + k], O[k], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier (of `tiers`) at which O occurs at or after `from`, with its positions; null when none. */
function findTier(fl, O, tiers, from) {
  for (const t of tiers) {
    const pos = occurrencesAt(fl, O, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/**
 * Build the lines that replace a match: items are {ctx: fileIndex} for context lines
 * (written as the file's own line) or {text} for new lines (re-indented at tier 2).
 */
function buildReplacement(items, fl, at, O, tier) {
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadWs(fl[at]);
    P = leadWs(O[0]);
  }
  const out = [];
  for (const it of items) {
    if (it.ctx !== undefined) {
      out.push(fl[it.ctx]);
    } else if (tier === 2) {
      const s = it.text;
      if (s !== '' && s.trim() !== '' && s.startsWith(P)) out.push(F + s.slice(P.length));
      else out.push(s);
    } else {
      out.push(it.text);
    }
  }
  return out;
}

// ---------- Section 4: detecting the format ----------

function detect(lines) {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- shared edit helpers ----------

function checkSafe(p) {
  if (!safe(p)) throw new Fail('unsafe', p);
}
function mustExist(tree, p) {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}
function mustNotExist(tree, p) {
  if (tree.get(p) !== null) throw new Fail('exists', p);
}

// ---------- Section 6: unified diffs ----------

function headerPath(s) {
  // text after the four characters, up to the first tab, surrounding spaces removed
  let t = s.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseUnified(lines) {
  const sections = [];
  let sec = null; // {gitOld, gitNew, hdrOld, hdrNew, pairSeen, renameFrom, renameTo, newFile, delFile, hunks: []}
  let i = 0;
  const isGit = (l) => l === 'diff --git' || l.startsWith('diff --git ');
  const startsPair = (idx) => lines[idx].startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ');
  const newSection = () => {
    sec = { gitOld: undefined, gitNew: undefined, hdrOld: undefined, hdrNew: undefined, pairSeen: false, renameFrom: undefined, renameTo: undefined, newFile: false, delFile: false, hunks: [] };
    sections.push(sec);
  };
  while (i < lines.length) {
    const l = lines[i];
    if (isGit(l)) {
      const rest = l.slice('diff --git '.length);
      const m = /^a\/(.+) b\/(.+)$/.exec(rest);
      if (l === 'diff --git' || m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection();
      sec.gitOld = m[1];
      sec.gitNew = m[2];
      i += 1;
      continue;
    }
    if (startsPair(i) && (sec === null || sec.hunks.length > 0 || sec.pairSeen)) {
      // a --- / +++ pair that is not part of a current section's header starts a section
      newSection();
      sec.hdrOld = headerPath(lines[i]);
      sec.hdrNew = headerPath(lines[i + 1]);
      sec.pairSeen = true;
      i += 2;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      // inside a section's header, before its first hunk
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        sec.hdrOld = headerPath(l);
        sec.hdrNew = headerPath(lines[i + 1]);
        sec.pairSeen = true;
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) {
        sec.renameFrom = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renameTo = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.newFile = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.delFile = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        i = parseHunk(lines, i, sec);
        continue;
      }
      i += 1; // any other header line is ignored
      continue;
    }
    if (sec !== null && l.startsWith('@@')) {
      i = parseHunk(lines, i, sec);
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`); // a hunk before any section
    i += 1; // prose and other lines outside bodies are ignored
  }
  return sections.map(unifiedEdit);
}

function parseHunk(lines, i, sec) {
  const head = lines[i];
  if (!/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(head)) throw new Exit2(`error: parse ${i + 1}`);
  const A = Number(/@@ -(\d+)/.exec(head)[1]);
  const body = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j];
    if (l === 'diff --git' || l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    const c = l[0];
    if (l === '') body.push({ kind: 'ctx', text: '', empty: true });
    else if (c === ' ') body.push({ kind: 'ctx', text: l.slice(1) });
    else if (c === '-') body.push({ kind: 'old', text: l.slice(1) });
    else if (c === '+') body.push({ kind: 'new', text: l.slice(1) });
    else if (c === '\\') body.push({ kind: 'bs' });
    else break;
    j += 1;
  }
  while (body.length > 0) {
    const last = body[body.length - 1];
    if (last.kind === 'ctx' && last.empty) body.pop();
    else break;
  }
  sec.hunks.push({ A, body });
  return j;
}

/** Whether a \ line follows the hunk's last context or + line. */
function backslashAfterLastCtxPlus(body) {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k].kind === 'ctx' || body[k].kind === 'new') {
      return k + 1 < body.length && body[k + 1].kind === 'bs';
    }
  }
  return false;
}

function unifiedEdit(sec) {
  return (tree, strict) => {
    const tiers = strict ? [0] : [0, 1, 2];
    const oldP = sec.hdrOld !== undefined ? sec.hdrOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
    const newP = sec.hdrNew !== undefined ? sec.hdrNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
    const isCreate = oldP === null || sec.newFile;
    const isDelete = newP === null || sec.delFile;
    if (isCreate) {
      const p = newP !== undefined && newP !== null ? newP : oldP;
      checkSafe(p);
      mustNotExist(tree, p);
      const out = [];
      for (const h of sec.hunks) {
        for (const it of h.body) if (it.kind === 'new') out.push(it.text);
      }
      // the created file ends with a line break unless a \ line follows its last + line
      let final = true;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const b = sec.hunks[hi].body;
        for (let k = b.length - 1; k >= 0; k -= 1) {
          if (b[k].kind === 'new') {
            final = !(k + 1 < b.length && b[k + 1].kind === 'bs');
            break outer;
          }
        }
      }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = oldP;
      checkSafe(p);
      mustExist(tree, p);
      tree.now.set(p, null);
      return;
    }
    const isMove = oldP !== newP;
    checkSafe(oldP);
    if (isMove) checkSafe(newP);
    const before = mustExist(tree, oldP);
    if (isMove) mustNotExist(tree, newP);
    const f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const O = [];
      const items = [];
      for (const it of h.body) {
        if (it.kind === 'ctx') {
          items.push({ ctx: O.length });
          O.push(it.text);
        } else if (it.kind === 'old') O.push(it.text);
        else if (it.kind === 'new') items.push({ text: it.text });
      }
      const nLen = items.length;
      if (O.length === 0) {
        const pos = Math.max(0, Math.min(h.A + d, f.lines.length));
        const atEnd = pos === f.lines.length;
        const add = buildReplacement(items, f.lines, pos, O, 0);
        f.lines.splice(pos, 0, ...add);
        if (atEnd) f.final = !backslashAfterLastCtxPlus(h.body);
        d += nLen;
        continue;
      }
      const found = findTier(f.lines, O, tiers, 0);
      if (found === null) throw new Fail('no-match', oldP);
      const target = h.A - 1 + d;
      let at = found.positions[0];
      for (const p0 of found.positions) {
        if (Math.abs(p0 - target) < Math.abs(at - target)) at = p0;
      }
      const repl = buildReplacement(
        items.map((it) => (it.ctx !== undefined ? { ctx: at + it.ctx } : it)),
        f.lines,
        at,
        O,
        found.tier,
      );
      const runsToEnd = at + O.length === f.lines.length;
      f.lines.splice(at, O.length, ...repl);
      if (runsToEnd) f.final = !backslashAfterLastCtxPlus(h.body);
      d += nLen - O.length;
    }
    tree.now.set(newP, joinFile(f));
    if (isMove) {
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    }
  };
}

// ---------- Section 7: SEARCH/REPLACE blocks ----------

function parseSearchReplace(lines) {
  const blocks = [];
  let prevEnd = 0; // index just after the previous block's REPLACE line
  let prevPath;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // path: nearest line before the SEARCH line, after the previous block, not blank, not a code fence
    let path;
    for (let k = searchIdx - 1; k >= prevEnd; k -= 1) {
      const l = lines[k];
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === undefined) {
      if (prevPath !== undefined) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let eq = -1;
    for (let k = searchIdx + 1; k < lines.length; k += 1) {
      if (lines[k].trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      if (lines[k].trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => (tree, strict) => {
    const tiers = strict ? [0] : [0, 1, 2];
    checkSafe(b.path);
    if (b.oldLines.length === 0) {
      mustNotExist(tree, b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = mustExist(tree, b.path);
    const f = splitFile(before);
    const found = findTier(f.lines, b.oldLines, tiers, 0);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.positions[0];
    const items = b.newLines.map((t) => ({ text: t }));
    const repl = buildReplacement(items, f.lines, at, b.oldLines, found.tier);
    f.lines.splice(at, b.oldLines.length, ...repl);
    tree.now.set(b.path, joinFile(f));
  });
}

// ---------- Section 8: V4A patches ----------

function parseV4a(lines) {
  const fb = lines.findIndex((l) => !blank(l));
  if (fb < 0) throw new Exit2('error: parse 1');
  if (lines[fb].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fb + 1}`);
  let lb = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k])) {
      lb = k;
      break;
    }
  }
  if (lines[lb].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections = [];
  let i = fb + 1;
  const secStart = (l) => {
    if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice('*** Add File: '.length).trim() };
    if (l.startsWith('*** Delete File: ')) return { kind: 'del', path: l.slice('*** Delete File: '.length).trim() };
    if (l.startsWith('*** Update File: ')) return { kind: 'upd', path: l.slice('*** Update File: '.length).trim() };
    return null;
  };
  while (i < lb) {
    if (blank(lines[i])) {
      i += 1;
      continue;
    }
    const st = secStart(lines[i]);
    if (st === null) throw new Exit2(`error: parse ${i + 1}`);
    const headIdx = i;
    i += 1;
    const raw = [];
    while (i < lb && secStart(lines[i]) === null) {
      raw.push({ text: lines[i], no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1].text)) raw.pop(); // blank lines at the end of a section are not part of it
    sections.push(v4aSection(st, raw, headIdx + 1));
  }
  return sections;
}

function v4aSection(st, raw, headNo) {
  if (st.kind === 'add') {
    const fileLines = [];
    for (const r of raw) {
      if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
      else if (r.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${r.no}`);
    }
    return (tree) => {
      checkSafe(st.path);
      mustNotExist(tree, st.path);
      tree.now.set(st.path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (st.kind === 'del') {
    if (raw.length > 0) throw new Exit2(`error: parse ${raw[0].no}`);
    return (tree) => {
      checkSafe(st.path);
      mustExist(tree, st.path);
      tree.now.set(st.path, null);
    };
  }
  // update
  let moveTo;
  let body = raw;
  if (body.length > 0 && body[0].text.startsWith('*** Move to: ')) {
    moveTo = body[0].text.slice('*** Move to: '.length).trim();
    body = body.slice(1);
  }
  const chunks = [];
  let cur = null;
  const flush = () => {
    if (cur !== null) chunks.push(cur);
    cur = null;
  };
  for (const r of body) {
    const l = r.text;
    if (l.startsWith('@@')) {
      flush();
      const anchorText = l.slice(2).trim();
      cur = { anchor: anchorText === '' ? undefined : anchorText, eof: false, items: [] };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) cur = { anchor: undefined, eof: false, items: [] };
      cur.eof = true;
      flush();
      // a body line after this (without @@) is handled below as an error via cur === null && !firstChunkOk
      cur = null;
      chunks.eofSeen = true;
      continue;
    }
    const c = l[0];
    const isBody = l === '' || c === ' ' || c === '-' || c === '+';
    if (!isBody) throw new Exit2(`error: parse ${r.no}`);
    if (cur === null) {
      if (chunks.length > 0 || chunks.eofSeen) throw new Exit2(`error: parse ${r.no}`);
      cur = { anchor: undefined, eof: false, items: [] };
    }
    if (l === '') cur.items.push({ kind: 'ctx', text: '' });
    else if (c === ' ') cur.items.push({ kind: 'ctx', text: l.slice(1) });
    else if (c === '-') cur.items.push({ kind: 'old', text: l.slice(1) });
    else cur.items.push({ kind: 'new', text: l.slice(1) });
  }
  flush();
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${headNo}`);
  return (tree, strict) => {
    const tiers = strict ? [0] : [0, 1, 2];
    checkSafe(st.path);
    if (moveTo !== undefined) checkSafe(moveTo);
    const before = mustExist(tree, st.path);
    if (moveTo !== undefined) mustNotExist(tree, moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== undefined) {
        let at = -1;
        for (const t of tiers) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (lineMatch(f.lines[k], ch.anchor, t)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', st.path);
        cursor = at + 1;
      }
      const O = [];
      const items = [];
      for (const it of ch.items) {
        if (it.kind === 'ctx') {
          items.push({ ctx: O.length });
          O.push(it.text);
        } else if (it.kind === 'old') O.push(it.text);
        else items.push({ text: it.text });
      }
      if (O.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const add = items.map((it) => ({ text: it.text }));
        const repl = buildReplacement(add, f.lines, pos, O, 0);
        f.lines.splice(pos, 0, ...repl);
        cursor = pos + repl.length;
        continue;
      }
      const found = findTier(f.lines, O, tiers, cursor);
      let positions = found === null ? [] : found.positions;
      if (ch.eof) positions = positions.filter((p0) => p0 + O.length === f.lines.length);
      if (found === null || positions.length === 0) throw new Fail('no-match', st.path);
      const at = positions[0];
      const repl = buildReplacement(
        items.map((it) => (it.ctx !== undefined ? { ctx: at + it.ctx } : it)),
        f.lines,
        at,
        O,
        found.tier,
      );
      f.lines.splice(at, O.length, ...repl);
      cursor = at + repl.length;
    }
    const dest = moveTo !== undefined ? moveTo : st.path;
    tree.now.set(dest, joinFile(f));
    if (moveTo !== undefined) {
      tree.now.set(st.path, null);
      tree.moves.push([st.path, moveTo]);
    }
  };
}

// ---------- Section 9: JSON edits ----------

function jsonEdit(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree) => {
    checkSafe(p);
    return mustExist(tree, p);
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      checkSafe(p);
      mustNotExist(tree, p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = o.new_str ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s) => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function parseJson(text, lines) {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits = [];
  if (lines[first].trimStart().startsWith('[')) {
    let v;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- Sections 1, 2 and 10: the command line, output, atomicity ----------

function run(args) {
  let format = null;
  let check = false;
  let strict = false;
  const pos = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits;
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Changed paths, with R lines for successful moves (section 2).
  const rows = [];
  const usedOld = new Set();
  const usedNew = new Set();
  for (const [o, n] of tree.moves) {
    if (usedOld.has(o) || usedNew.has(n)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      usedOld.add(o);
      usedNew.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p);
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
