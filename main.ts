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

/** A file as lines: its line break, its lines, and whether it ends with one (SPEC.md section 3). */
interface FileDoc {
  br: '\r\n' | '\n';
  lines: string[];
  fin: boolean;
}

function parseFile(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], fin: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    fin = true;
    lines.pop();
  }
  return { br, lines, fin };
}

function renderFile(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.fin ? d.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Does O's line match the file's line at this tier (SPEC.md section 5)? */
function lineMatch(o: string, f: string, tier: number): boolean {
  if (tier === 0) return o === f;
  if (tier === 1) return trimEndWs(o) === trimEndWs(f);
  return trimWs(o) === trimWs(f);
}

/** All positions where O occurs in the file's lines at this tier; occurrences may overlap. */
function occurrencesAt(o: string[], lines: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineMatch(o[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with every occurrence there. */
function findTier(o: string[], lines: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(o, lines, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first occurrence of O at or after `from`, at the first tier with one. */
function findTierFrom(o: string[], lines: string[], from: number, strict: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(o, lines, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, pos: pos[0]! };
  }
  return null;
}

/** A new line of N: the patch's text, re-indented at tier 2 (SPEC.md section 5). */
function reindent(text: string, tier: number, fLead: string, pLead: string): string {
  if (tier !== 2) return text;
  if (text === '' || text.trim() === '') return text;
  if (!text.startsWith(pLead)) return text;
  return fLead + text.slice(pLead.length);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made: [old path, new path], for the R output line. */
  readonly moves: [string, string][] = [];
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

/** One unified hunk: its old start line (1-based) and its body lines. */
interface Hunk {
  a: number;
  body: string[];
}

/** One unified section, as parsed (SPEC.md section 6). */
interface Section {
  oldPair: string | null | undefined;
  newPair: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
  inHeader: boolean;
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, trimmed; /dev/null is no file. */
function hdrPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunkHeader(line: string): { a: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) return null;
  return { a: Number(m[1]) };
}

/** A hunk's body: lines after its header until the first line that is not one, trailing empty lines removed. */
function scanBody(lines: string[], start: number): { body: string[]; next: number } {
  const body: string[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      i += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: i };
}

/** Split a hunk body into its old lines O, its new lines N, and whether a `\` line follows its last context or `+` line. */
function hunkParts(body: string[]): { o: string[]; n: { text: string; ctx: boolean }[]; noEol: boolean } {
  const o: string[] = [];
  const n: { text: string; ctx: boolean }[] = [];
  for (const l of body) {
    if (l === '' || l.startsWith(' ')) {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: true });
    } else if (l.startsWith('-')) o.push(l.slice(1));
    else if (l.startsWith('+')) n.push({ text: l.slice(1), ctx: false });
  }
  let noEol = false;
  for (let j = body.length - 1; j >= 0; j -= 1) {
    const l = body[j]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) {
      noEol = j + 1 < body.length && body[j + 1]!.startsWith('\\');
      break;
    }
  }
  return { o, n, noEol };
}

/** Apply one hunk to a file document; d is the line drift of this section's earlier hunks. */
function applyHunk(doc: FileDoc, hunk: Hunk, d: number, strict: boolean, path: string): { doc: FileDoc; delta: number } {
  const { o, n, noEol } = hunkParts(hunk.body);
  if (o.length > 0) {
    const found = findTier(o, doc.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = found.pos[0]!;
    for (const p of found.pos) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const fLead = leadWs(doc.lines[best]!);
    const pLead = leadWs(o[0]!);
    const repl: string[] = [];
    let oi = 0;
    for (const l of hunk.body) {
      if (l === '' || l.startsWith(' ')) {
        repl.push(doc.lines[best + oi]!);
        oi += 1;
      } else if (l.startsWith('-')) oi += 1;
      else if (l.startsWith('+')) repl.push(reindent(l.slice(1), found.tier, fLead, pLead));
    }
    const lines = [...doc.lines.slice(0, best), ...repl, ...doc.lines.slice(best + o.length)];
    const toEof = best + o.length === doc.lines.length;
    return { doc: { br: doc.br, lines, fin: toEof ? !noEol : doc.fin }, delta: n.length - o.length };
  }
  const at = Math.min(Math.max(hunk.a + d, 0), doc.lines.length);
  const repl: string[] = [];
  for (const l of hunk.body) {
    if (l.startsWith('+')) repl.push(l.slice(1));
  }
  const lines = [...doc.lines.slice(0, at), ...repl, ...doc.lines.slice(at)];
  return { doc: { br: doc.br, lines, fin: at === doc.lines.length ? !noEol : doc.fin }, delta: repl.length };
}

/** Apply a section's hunks in order, each to the result of the ones before it. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let doc = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const r = applyHunk(doc, h, d, strict, path);
    doc = r.doc;
    d += r.delta;
  }
  return renderFile(doc);
}

/** One unified section as one edit (SPEC.md section 6). */
function sectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.oldPair !== undefined ? s.oldPair : s.renameFrom !== undefined ? s.renameFrom : s.gitOld !== undefined ? s.gitOld : null;
  const newP = s.newPair !== undefined ? s.newPair : s.renameTo !== undefined ? s.renameTo : s.gitNew !== undefined ? s.gitNew : null;
  const hunks = s.hunks;
  if (s.isNew || oldP === null) {
    const p = newP;
    return (tree) => {
      if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '');
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: { text: string; noeol: boolean }[] = [];
      for (const h of hunks) {
        for (let k = 0; k < h.body.length; k += 1) {
          const l = h.body[k]!;
          if (l.startsWith('+')) plus.push({ text: l.slice(1), noeol: k + 1 < h.body.length && h.body[k + 1]!.startsWith('\\') });
        }
      }
      const content = plus.length === 0 ? '' : plus.map((x) => x.text).join('\n') + (plus[plus.length - 1]!.noeol ? '' : '\n');
      tree.now.set(p, content);
    };
  }
  if (s.isDel || newP === null) {
    const p = oldP;
    return (tree) => {
      if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '');
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (oldP !== newP) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(cur, hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
    };
  }
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(cur, hunks, strict, oldP));
  };
}

/** Parse a unified diff into its sections' edits (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const newSec = (gitOld?: string, gitNew?: string): Section => {
    const s: Section = {
      oldPair: undefined,
      newPair: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      gitOld,
      gitNew,
      isNew: false,
      isDel: false,
      hunks: [],
      inHeader: true,
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSec(m[1], m[2]);
      i += 1;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = newSec();
        cur.oldPair = hdrPath(line);
        cur.newPair = hdrPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (cur.inHeader) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.oldPair = hdrPath(line);
          cur.newPair = hdrPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isNew = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDel = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        const h = parseHunkHeader(line);
        if (h === null) throw new Exit2(`error: parse ${i + 1}`);
        cur.inHeader = false;
        const r = scanBody(lines, i + 1);
        cur.hunks.push({ a: h.a, body: r.body });
        i = r.next;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newSec();
      cur.oldPair = hdrPath(line);
      cur.newPair = hdrPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const h = parseHunkHeader(line);
      if (h === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = scanBody(lines, i + 1);
      cur.hunks.push({ a: h.a, body: r.body });
      i = r.next;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/** One SEARCH/REPLACE block as one edit (SPEC.md section 7). */
function srEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const doc = parseFile(cur);
    const found = findTier(oldLines, doc.lines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.pos.length > 1) throw new Fail('ambiguous', p);
    const at = found.pos[0]!;
    const fLead = leadWs(doc.lines[at]!);
    const pLead = leadWs(oldLines[0]!);
    const repl = newLines.map((t) => reindent(t, found.tier, fLead, pLead));
    const lines = [...doc.lines.slice(0, at), ...repl, ...doc.lines.slice(at + oldLines.length)];
    tree.now.set(p, renderFile({ br: doc.br, lines, fin: doc.fin }));
  };
}

/** Parse SEARCH/REPLACE blocks into edits (SPEC.md section 7). */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevRep = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let eq = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let k = s - 1; k > prevRep; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevRep = rep;
    edits.push(srEdit(path, oldLines, newLines, strict));
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: its anchor (null: none), its body lines, and whether *** End of File closed it. */
interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

/** The first line at or after `from` equal to the anchor, at the first tier with one (single-line matching). */
function findAnchor(anchor: string, lines: string[], from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (lineMatch(anchor, lines[i]!, t)) return i;
    }
  }
  return null;
}

/** A chunk's occurrence of O at or after the cursor, at the first tier with one; an end-of-file chunk takes only one ending at the last line. */
function findChunkOcc(o: string[], lines: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(o, lines, t).filter((p) => p >= from);
    if (pos.length === 0) continue;
    if (eof) {
      const atEnd = pos.find((p) => p + o.length === lines.length);
      if (atEnd === undefined) return null;
      return { tier: t, pos: atEnd };
    }
    return { tier: t, pos: pos[0]! };
  }
  return null;
}

/** One V4A Add File section as one edit (SPEC.md section 8). */
function v4aAddEdit(p: string, addLines: string[]): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, addLines.length === 0 ? '' : `${addLines.join('\n')}\n`);
  };
}

/** One V4A Delete File section as one edit (SPEC.md section 8). */
function v4aDeleteEdit(p: string): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
  };
}

/** One V4A Update File section as one edit (SPEC.md section 8). */
function v4aUpdateEdit(p: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const doc = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const found = findAnchor(ch.anchor, doc.lines, cursor, strict);
        if (found === null) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      const { o, n } = hunkParts(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        const ins = n.map((e) => e.text);
        doc.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const occ = findChunkOcc(o, doc.lines, cursor, strict, ch.eof);
      if (occ === null) throw new Fail('no-match', p);
      const fLead = leadWs(doc.lines[occ.pos]!);
      const pLead = leadWs(o[0]!);
      const repl: string[] = [];
      let oi = 0;
      for (const l of ch.body) {
        if (l === '' || l.startsWith(' ')) {
          repl.push(doc.lines[occ.pos + oi]!);
          oi += 1;
        } else if (l.startsWith('-')) oi += 1;
        else if (l.startsWith('+')) repl.push(reindent(l.slice(1), occ.tier, fLead, pLead));
      }
      doc.lines.splice(occ.pos, o.length, ...repl);
      cursor = occ.pos + repl.length;
    }
    const out = renderFile(doc);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, out);
      tree.moves.push([p, moveTo]);
    } else {
      tree.now.set(p, out);
    }
  };
}

/** Parse a V4A patch into its sections' edits (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const addLines: string[] = [];
      i += 1;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) {
          addLines.push(l.slice(1));
          i += 1;
          continue;
        }
        if (blank(l)) {
          let j = i;
          while (j < last && blank(lines[j]!)) j += 1;
          if (j >= last || isSectionStart(lines[j]!)) {
            i = j;
            break;
          }
          if (l === '') {
            addLines.push('');
            i += 1;
            continue;
          }
          throw new Exit2(`error: parse ${i + 1}`);
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (addLines.length > 0 && addLines[addLines.length - 1] === '') addLines.pop();
      edits.push(v4aAddEdit(p, addLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (blank(l)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(p));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('@@')) {
          closeChunk();
          cur = { anchor: l.slice(2).trim(), body: [], eof: false };
          i += 1;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          closeChunk();
          i += 1;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push(l);
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk();
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0 && blank(lastChunk.body[lastChunk.body.length - 1]!)) lastChunk.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
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
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const moveNew = new Map<string, string>();
  const moveOld = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      moveNew.set(newP, oldP);
      moveOld.add(oldP);
    }
  }
  const rows: { key: string; text: string }[] = [];
  for (const p of changed) {
    if (moveOld.has(p) || moveNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [newP, oldP] of moveNew) rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
