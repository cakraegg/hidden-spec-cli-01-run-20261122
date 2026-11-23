// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in patch order, for the `R old -> new` output lines. */
  readonly moves: { from: string; to: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
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
    let e: Edit | null = null;
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

/* ---- SPEC.md sections 5 to 8, written fresh in this session ---- */

/** A file as lines plus its break style and whether it ends with a break. */
interface FileState {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where old matches lines at the given tier (occurrences may overlap). */
function findOcc(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > lines.length) return out;
  for (let i = 0; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < old.length; k++) {
      if (tierKey(lines[i + k]!, tier) !== tierKey(old[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, 1, 2) at which old occurs at least once, -1 when none. */
function firstTier(lines: string[], old: string[], strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    if (findOcc(lines, old, t).length > 0) return t;
  }
  return -1;
}

/** Re-indent one non-context new line at tier 2 (section 5). */
function reindentLine(line: string, tier: number, f: string, p: string): string {
  if (tier !== 2) return line;
  if (line === '' || line.trim() === '') return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

/**
 * Replacement lines for a match at position `at`: context lines are the file's
 * own matched lines, other lines are re-indented at tier 2. `link[j]` is the
 * index into O of N[j] when N[j] is a context line, else -1.
 */
function buildNew(lines: string[], at: number, nLines: string[], link: number[], tier: number, oldFirst: string): string[] {
  const f = leadWs(lines[at] ?? '');
  const p = leadWs(oldFirst);
  return nLines.map((l, j) => {
    const oi = link[j]!;
    if (oi >= 0) return lines[at + oi]!;
    return reindentLine(l, tier, f, p);
  });
}

/* ---- Section 6: unified diffs ---- */

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** Path after `--- ` or `+++ `: text after four chars, to first tab, trimmed, with a leading `a/` or `b/` removed. */
function headerPath(line: string): string {
  const p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m ? Number(m[1]) : null;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const startSection = (): UniSection => {
    const s: UniSection = {
      oldPath: null,
      newPath: null,
      renameFrom: null,
      renameTo: null,
      diffOld: null,
      diffNew: null,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) {
        const s = startSection();
        s.oldPath = headerPath(line);
        s.newPath = headerPath(lines[i + 1]!);
      } else {
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader && line.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a, body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('+++ ')) cur.newPath = headerPath(line);
      else if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ') || line.startsWith('new file mode\t')) cur.newFile = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ') || line.startsWith('deleted file mode\t')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => uniSectionEdit(s, strict));
}

/** The `+` lines of a creation's hunks, with its final line break. */
function createText(hunks: Hunk[]): string {
  const made: string[] = [];
  let lastPlus: { hunk: Hunk; idx: number } | null = null;
  for (const h of hunks) {
    for (let k = 0; k < h.body.length; k++) {
      const bl = h.body[k]!;
      if (bl.startsWith('+')) {
        made.push(bl.slice(1));
        lastPlus = { hunk: h, idx: k };
      }
    }
  }
  if (made.length === 0) return '';
  let final = true;
  if (lastPlus !== null) {
    const next = lastPlus.hunk.body[lastPlus.idx + 1];
    if (next !== undefined && next.startsWith('\\')) final = false;
  }
  return made.join('\n') + (final ? '\n' : '');
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const st = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const oLines: string[] = [];
    const nLines: string[] = [];
    const link: number[] = [];
    let lastCtxPlus = -1;
    for (let k = 0; k < h.body.length; k++) {
      const bl = h.body[k]!;
      if (bl.startsWith('\\')) continue;
      if (bl === '' || bl.startsWith(' ')) {
        const t = bl === '' ? '' : bl.slice(1);
        link.push(oLines.length);
        oLines.push(t);
        nLines.push(t);
        lastCtxPlus = k;
      } else if (bl.startsWith('-')) {
        oLines.push(bl.slice(1));
      } else if (bl.startsWith('+')) {
        link.push(-1);
        nLines.push(bl.slice(1));
        lastCtxPlus = k;
      }
    }
    const noEol =
      lastCtxPlus >= 0 && lastCtxPlus + 1 < h.body.length && h.body[lastCtxPlus + 1]!.startsWith('\\');
    if (oLines.length > 0) {
      const tier = firstTier(st.lines, oLines, strict);
      if (tier < 0) throw new Fail('no-match', path);
      const occs = findOcc(st.lines, oLines, tier);
      const target = h.a - 1 + d;
      let best = occs[0]!;
      for (const p of occs) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + oLines.length === st.lines.length;
      const repl = buildNew(st.lines, best, nLines, link, tier, oLines[0]!);
      st.lines.splice(best, oLines.length, ...repl);
      if (atEnd) st.final = !noEol;
      d += nLines.length - oLines.length;
    } else {
      const ins = Math.min(Math.max(h.a + d, 0), st.lines.length);
      const atEnd = ins === st.lines.length;
      st.lines.splice(ins, 0, ...nLines);
      if (atEnd && nLines.length > 0) st.final = !noEol;
      d += nLines.length;
    }
  }
  return joinFile(st);
}

function uniSectionEdit(s: UniSection, strict: boolean): Edit {
  const oldPath = s.oldPath ?? s.renameFrom ?? s.diffOld;
  const newPath = s.newPath ?? s.renameTo ?? s.diffNew;
  const isCreate = oldPath === '/dev/null' || s.newFile;
  const isDelete = newPath === '/dev/null' || s.deletedFile;
  if (isCreate) {
    const np = newPath ?? '';
    return (tree) => {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      tree.now.set(np, createText(s.hunks));
    };
  }
  if (isDelete) {
    const op = oldPath ?? '';
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  const op = oldPath ?? '';
  const np = newPath ?? '';
  if (op !== np) {
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const text = tree.get(op);
      if (text === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(text, s.hunks, strict, op);
      tree.now.set(np, out);
      tree.now.set(op, null);
      tree.moves.push({ from: op, to: np });
    };
  }
  return (tree) => {
    if (!safe(op)) throw new Fail('unsafe', op);
    const text = tree.get(op);
    if (text === null) throw new Fail('missing', op);
    tree.now.set(op, applyHunks(text, s.hunks, strict, op));
  };
}

/* ---- Section 7: SEARCH/REPLACE blocks ---- */

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let afterPrev = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sIdx = i;
    let path: string | null = null;
    for (let j = sIdx - 1; j >= afterPrev; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${sIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep === -1) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    afterPrev = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const st = splitFile(text);
    const tier = firstTier(st.lines, oldLines, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occs = findOcc(st.lines, oldLines, tier);
    if (occs.length !== 1) throw new Fail('ambiguous', path);
    const pos = occs[0]!;
    const repl = buildNew(st.lines, pos, newLines, newLines.map(() => -1), tier, oldLines[0]!);
    st.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(st));
  };
}

/* ---- Section 8: V4A patches ---- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  addRaw: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function parseVChunkBody(body: string[]): { o: string[]; n: string[]; link: number[] } {
  const o: string[] = [];
  const n: string[] = [];
  const link: number[] = [];
  for (const bl of body) {
    if (blank(bl)) {
      link.push(o.length);
      o.push('');
      n.push('');
    } else if (bl.startsWith(' ')) {
      const t = bl.slice(1);
      link.push(o.length);
      o.push(t);
      n.push(t);
    } else if (bl.startsWith('-')) {
      o.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      link.push(-1);
      n.push(bl.slice(1));
    }
  }
  return { o, n, link };
}

function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (tierKey(lines[i]!, t) === tierKey(anchor, t)) return i;
    }
  }
  return -1;
}

function occFrom(lines: string[], old: string[], tier: number, from: number, eof: boolean): number[] {
  return findOcc(lines, old, tier).filter((p) => p >= from && (!eof || p + old.length === lines.length));
}

function firstTierFrom(lines: string[], old: string[], from: number, strict: boolean, eof: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    if (occFrom(lines, old, t, from, eof).length > 0) return t;
  }
  return -1;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let curChunk: VChunk | null = null;
  let seenChunk = false;
  let moveSeen = false;
  const finishSection = (): void => {
    if (cur === null) return;
    if (cur.kind === 'add') {
      while (cur.addRaw.length > 0 && blank(cur.addRaw[cur.addRaw.length - 1]!)) cur.addRaw.pop();
    }
    if (cur.kind === 'update') {
      if (cur.chunks.length === 0 && curChunk === null && cur.moveTo === null) {
        throw new Exit2(`error: parse ${cur.lineNo}`);
      }
      if (curChunk !== null) {
        while (curChunk.body.length > 0 && blank(curChunk.body[curChunk.body.length - 1]!)) curChunk.body.pop();
        cur.chunks.push(curChunk);
        curChunk = null;
      }
    }
    cur = null;
    seenChunk = false;
    moveSeen = false;
  };
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    const isBlank = blank(line);
    if (
      !isBlank &&
      (line.startsWith('*** Add File:') || line.startsWith('*** Delete File:') || line.startsWith('*** Update File:'))
    ) {
      finishSection();
      const kind = line.startsWith('*** Add') ? 'add' : line.startsWith('*** Delete') ? 'delete' : 'update';
      cur = {
        kind,
        path: line.slice(line.indexOf(':') + 1).trim(),
        lineNo: i + 1,
        addRaw: [],
        moveTo: null,
        chunks: [],
      };
      sections.push(cur);
      i++;
      continue;
    }
    if (cur === null) {
      if (isBlank) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'delete') {
      if (isBlank) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (isBlank || line.startsWith('+')) {
        cur.addRaw.push(line);
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (isBlank) {
      if (curChunk !== null) {
        curChunk.body.push(line);
        i++;
        continue;
      }
      if (!seenChunk) {
        curChunk = { anchor: null, eof: false, body: [] };
        seenChunk = true;
        curChunk.body.push(line);
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('*** Move to:')) {
      if (cur.chunks.length > 0 || curChunk !== null || moveSeen) throw new Exit2(`error: parse ${i + 1}`);
      cur.moveTo = line.slice('*** Move to:'.length).trim();
      moveSeen = true;
      i++;
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
      curChunk.eof = true;
      cur.chunks.push(curChunk);
      curChunk = null;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (curChunk !== null) cur.chunks.push(curChunk);
      curChunk = { anchor: line.slice(2).trim(), eof: false, body: [] };
      seenChunk = true;
      i++;
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      if (curChunk === null) {
        if (seenChunk) throw new Exit2(`error: parse ${i + 1}`);
        curChunk = { anchor: null, eof: false, body: [] };
        seenChunk = true;
      }
      curChunk.body.push(line);
      i++;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  finishSection();
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function v4aSectionEdit(s: VSection, strict: boolean): Edit {
  if (s.kind === 'add') {
    const fileLines = s.addRaw.map((l) => (blank(l) ? '' : l.slice(1)));
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
    };
  }
  const chunks = s.chunks.map((c) => ({ anchor: c.anchor, eof: c.eof, ...parseVChunkBody(c.body) }));
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    const text = tree.get(s.path);
    if (text === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null) {
      if (!safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      if (tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    }
    const st = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const pos = findAnchor(st.lines, ch.anchor, cursor, strict);
        if (pos < 0) throw new Fail('no-match', s.path);
        cursor = pos + 1;
      }
      if (ch.o.length === 0) {
        const ins = ch.eof ? st.lines.length : cursor;
        st.lines.splice(ins, 0, ...ch.n);
        cursor = ins + ch.n.length;
      } else {
        const tier = firstTierFrom(st.lines, ch.o, cursor, strict, ch.eof);
        if (tier < 0) throw new Fail('no-match', s.path);
        const pos = occFrom(st.lines, ch.o, tier, cursor, ch.eof)[0]!;
        const repl = buildNew(st.lines, pos, ch.n, ch.link, tier, ch.o[0]!);
        st.lines.splice(pos, ch.o.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const out = joinFile(st);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, out);
      tree.now.set(s.path, null);
      tree.moves.push({ from: s.path, to: s.moveTo });
    } else {
      tree.now.set(s.path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
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
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const entries: { key: string; line: string }[] = [];
  const moved = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.from);
    const nowOld = tree.get(m.from);
    const wasNew = tree.original(m.to);
    const nowNew = tree.get(m.to);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      entries.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      moved.add(m.from);
      moved.add(m.to);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
