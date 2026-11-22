// main.ts is mend, the CLI SPEC.md specifies. It does sections 1 to 10 of SPEC.md: the command line, the
// output and exit codes, safe paths, format detection, matching lines at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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

/* ------------------------------------------------------------------ */
/* Files, lines and matching (SPEC sections 3 and 5)                    */
/* ------------------------------------------------------------------ */

const BYTE = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

const leadingWs = (s: string): string => {
  const m = s.match(/^[ \t]*/);
  return m ? m[0] : '';
};
const trimTrailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');
const tierForm = (l: string, t: number): string => (t === 0 ? l : t === 1 ? trimTrailWs(l) : trimWs(l));

/** Split a file's text into its lines, its line break and whether it ends with one (SPEC section 3). */
function readFileLines(text: string): { lines: string[]; eol: string; finalBreak: boolean } {
  if (text === '') return { lines: [], eol: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(eol);
  const finalBreak = text.endsWith(eol);
  if (finalBreak) parts.pop();
  return { lines: parts, eol, finalBreak };
}

function writeLines(lines: string[], eol: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(eol) + (finalBreak ? eol : '');
}

/** Occurrences of O in lines at/after `from`, at the first tier that has one. */
function findOccurrences(
  lines: string[],
  O: string[],
  from: number,
  strict: boolean
): { tier: number; occs: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const fo = O.map((o) => tierForm(o, t));
    const occs: number[] = [];
    for (let i = from; i + O.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (tierForm(lines[i + j], t) !== fo[j]) {
          ok = false;
          break;
        }
      }
      if (ok) occs.push(i);
    }
    if (occs.length) return { tier: t, occs };
  }
  return null;
}

/** Tier 2 re-indentation of a new line (SPEC section 5). */
function reindent(text: string, fileLines: string[], pos: number, O: string[], tier: number | undefined): string {
  if (tier !== 2) return text;
  if (text === '' || trimWs(text) === '') return text;
  const P = leadingWs(O[0]);
  const F = leadingWs(fileLines[pos]);
  if (text.startsWith(P)) return F + text.slice(P.length);
  return text;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                      */
/* ------------------------------------------------------------------ */

function isSectionStart(lines: string[], i: number): boolean {
  return (
    lines[i].startsWith('diff --git ') ||
    (lines[i].startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))
  );
}

function headerPath(line: string): string {
  let p = line.slice(4).split('\t')[0].trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

interface HunkBodyEntry {
  type: 'ctx' | 'old' | 'new' | 'noeol';
  text: string;
}
interface Hunk {
  A: number;
  body: HunkBodyEntry[];
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  const A = parseInt(m[1]!, 10);
  const body: HunkBodyEntry[] = [];
  let j = i + 1;
  for (; j < lines.length; j++) {
    const l = lines[j];
    if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ '))) break;
    if (l === '') {
      body.push({ type: 'ctx', text: '' });
      continue;
    }
    if (l.startsWith(' ')) {
      body.push({ type: 'ctx', text: l.slice(1) });
      continue;
    }
    if (l.startsWith('-')) {
      body.push({ type: 'old', text: l.slice(1) });
      continue;
    }
    if (l.startsWith('+')) {
      body.push({ type: 'new', text: l.slice(1) });
      continue;
    }
    if (l.startsWith('\\')) {
      body.push({ type: 'noeol', text: '' });
      continue;
    }
    break;
  }
  while (body.length && body[body.length - 1].type === 'ctx' && body[body.length - 1].text === '') body.pop();
  return { hunk: { A, body }, next: j };
}

function parseUniSection(
  lines: string[],
  start: number
): { sec: { o: string | null; n: string | null; isCreate: boolean; isDelete: boolean; hunks: Hunk[] }; next: number } {
  let i = start;
  let oldP: string | null = null,
    newP: string | null = null,
    pair = false;
  let renameFrom: string | null = null,
    renameTo: string | null = null;
  let diffOld: string | null = null,
    diffNew: string | null = null;
  let isCreate = false,
    isDelete = false;
  const startPair = lines[start].startsWith('--- ') && (lines[start + 1] ?? '').startsWith('+++ ');
  for (;;) {
    if (i >= lines.length) break;
    const l = lines[i];
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git') && i !== start) break;
    if ((l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) && i !== start && startPair) break;
    if (l.startsWith('diff --git ')) {
      const m = l.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      diffOld = m[1]!;
      diffNew = m[2]!;
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      const nx = lines[i + 1];
      if (nx === undefined || !nx.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      oldP = headerPath(l);
      newP = headerPath(nx);
      pair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('+++ ')) {
      i++;
      continue;
    }
    if (l.startsWith('rename from ')) {
      renameFrom = stripAB(l.slice(11).trim());
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      renameTo = stripAB(l.slice(9).trim());
      i++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      isCreate = true;
      i++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  let o = oldP,
    n = newP;
  if (!pair) {
    if (renameFrom !== null) {
      o = renameFrom;
      n = renameTo;
    } else {
      o = diffOld;
      n = diffNew;
    }
  }
  if (isCreate) n = n ?? diffNew;
  if (isDelete) o = o ?? diffOld;
  const del = isDelete || n === '/dev/null';
  const hunks: Hunk[] = [];
  if (!del) {
    while (i < lines.length) {
      const l = lines[i];
      if (isSectionStart(lines, i)) break;
      if (l.startsWith('@@')) {
        const h = parseHunk(lines, i);
        hunks.push(h.hunk);
        i = h.next;
        continue;
      }
      i++;
    }
  } else {
    while (i < lines.length && !isSectionStart(lines, i)) i++;
  }
  return { sec: { o, n, isCreate, isDelete, hunks }, next: i };
}

function makeUniEdit(sec: { o: string | null; n: string | null; isCreate: boolean; isDelete: boolean; hunks: Hunk[] }, strict: boolean, moves: [string, string][]): Edit {
  const o = sec.o,
    n = sec.n;
  const create = sec.isCreate || o === '/dev/null';
  const del = sec.isDelete || n === '/dev/null';
  if (create) {
    const p = n === '/dev/null' ? null : n;
    return (tree) => {
      if (p === null) throw new Fail('no-match', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let finalBreak = true;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k].type === 'new') {
            out.push(h.body[k].text);
            finalBreak = !(h.body[k + 1] && h.body[k + 1].type === 'noeol');
          }
        }
      }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (finalBreak ? '\n' : ''));
    };
  }
  if (del) {
    const p = o;
    return (tree) => {
      if (p === null) throw new Fail('no-match', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const moving = o !== n;
  return (tree) => {
    if (o === null) throw new Fail('no-match', '');
    if (!safe(o)) throw new Fail('unsafe', o);
    if (n === null) throw new Fail('no-match', '');
    if (!safe(n)) throw new Fail('unsafe', n);
    if (tree.get(o) === null) throw new Fail('missing', o);
    if (moving && tree.get(n) !== null) throw new Fail('exists', n);
    const t = tree.get(o)!;
    const fl = readFileLines(t);
    let lines = fl.lines;
    let d = 0;
    let finalBreak = fl.finalBreak;
    for (const h of sec.hunks) {
      const O = h.body.filter((e) => e.type === 'ctx' || e.type === 'old').map((e) => e.text);
      const K = h.body.filter((e) => e.type === 'ctx' || e.type === 'old').length;
      const NN = h.body.filter((e) => e.type === 'ctx' || e.type === 'new').length;
      let pos: number,
        k: number,
        tier: number | undefined;
      if (O.length) {
        const found = findOccurrences(lines, O, 0, strict);
        if (!found) throw new Fail('no-match', o);
        const target = h.A - 1 + d;
        let best = found.occs[0]!,
          bd = Infinity;
        for (const pp of found.occs) {
          const dd = Math.abs(pp - target);
          if (dd < bd) {
            best = pp;
            bd = dd;
          }
        }
        pos = best;
        k = K;
        tier = found.tier;
      } else {
        pos = Math.min(h.A + d, lines.length);
        k = 0;
      }
      const out: string[] = [];
      let j = 0;
      for (const e of h.body) {
        if (e.type === 'ctx') {
          out.push(lines[pos + j]);
          j++;
        } else if (e.type === 'old') j++;
        else if (e.type === 'new') out.push(reindent(e.text, lines, pos, O, tier));
      }
      if (pos + k === lines.length) {
        const last = h.body[h.body.length - 1];
        const prev = h.body[h.body.length - 2];
        const bs = !!last && last.type === 'noeol' && !!prev && (prev.type === 'ctx' || prev.type === 'new');
        finalBreak = !bs;
      }
      lines = lines.slice(0, pos).concat(out, lines.slice(pos + k));
      d += NN - K;
    }
    tree.now.set(n, writeLines(lines, fl.eol, finalBreak));
    if (moving) {
      tree.now.set(o, null);
      moves.push([o, n]);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (!isSectionStart(lines, i)) {
      i++;
      continue;
    }
    const r = parseUniSection(lines, i);
    edits.push(makeUniEdit(r.sec, strict, moves));
    i = r.next;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const fl = readFileLines(t);
    const found = findOccurrences(fl.lines, oldLines, 0, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occs.length !== 1) throw new Fail('ambiguous', path);
    const pos = found.occs[0]!;
    const out: string[] = [];
    for (const nl of newLines) out.push(reindent(nl, fl.lines, pos, oldLines, found.tier));
    const lines = fl.lines.slice(0, pos).concat(out, fl.lines.slice(pos + oldLines.length));
    tree.now.set(path, writeLines(lines, fl.eol, fl.finalBreak));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevRep = -1;
  let lastPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLine = i + 1;
    let eq = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k].trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k].trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let k = i - 1; k > prevRep; k--) {
      const c = lines[k];
      if (c.trim() !== '' && !c.trim().startsWith('```')) {
        path = c.trim();
        break;
      }
    }
    if (path === null) path = lastPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    lastPath = path;
    edits.push(makeSREdit(path, oldLines, newLines, strict));
    prevRep = rep;
    i = rep;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: HunkBodyEntry[];
}

function makeV4aUpdate(p: string, np: string | null, chunks: Chunk[], strict: boolean, moves: [string, string][]): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (np !== null && !safe(np)) throw new Fail('unsafe', np);
    if (tree.get(p) === null) throw new Fail('missing', p);
    if (np !== null && tree.get(np) !== null) throw new Fail('exists', np);
    const t = tree.get(p)!;
    const fl = readFileLines(t);
    let lines = fl.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let ai = -1;
        for (const tt of strict ? [0] : [0, 1, 2]) {
          const fa = tierForm(ch.anchor, tt);
          for (let i = cursor; i < lines.length; i++) {
            if (tierForm(lines[i], tt) === fa) {
              ai = i;
              break;
            }
          }
          if (ai >= 0) break;
        }
        if (ai < 0) throw new Fail('no-match', p);
        cursor = ai + 1;
      }
      const O = ch.body.filter((e) => e.type === 'ctx' || e.type === 'old').map((e) => e.text);
      let pos: number,
        k: number,
        tier: number | undefined;
      if (O.length) {
        const found = findOccurrences(lines, O, cursor, strict);
        if (!found) throw new Fail('no-match', p);
        let occs = found.occs;
        if (ch.eof) occs = occs.filter((o) => o + O.length === lines.length);
        if (!occs.length) throw new Fail('no-match', p);
        pos = occs[0]!;
        k = O.length;
        tier = found.tier;
      } else {
        pos = ch.eof ? lines.length : cursor;
        k = 0;
      }
      const out: string[] = [];
      let j = 0;
      for (const e of ch.body) {
        if (e.type === 'ctx') {
          out.push(lines[pos + j]);
          j++;
        } else if (e.type === 'old') j++;
        else out.push(ch.eof ? e.text : reindent(e.text, lines, pos, O, tier));
      }
      lines = lines.slice(0, pos).concat(out, lines.slice(pos + k));
      cursor = pos + out.length;
    }
    tree.now.set(np ?? p, writeLines(lines, fl.eol, fl.finalBreak));
    if (np !== null) {
      tree.now.set(p, null);
      moves.push([p, np]);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let i = 0; i < lines.length; i++) if (!blank(lines[i])) lastNB = i;
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = firstNB + 1;
  const secMarker = (c: string): boolean =>
    c.startsWith('*** Add File: ') || c.startsWith('*** Delete File: ') || c.startsWith('*** Update File: ');
  while (i < lastNB) {
    const l = lines[i];
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice(14).trim();
      i++;
      const ls: string[] = [];
      while (i < lastNB) {
        const c = lines[i];
        if (c.startsWith('+')) {
          ls.push(c.slice(1));
          i++;
          continue;
        }
        if (c === '') {
          ls.push('');
          i++;
          continue;
        }
        break;
      }
      while (ls.length && ls[ls.length - 1] === '') ls.pop();
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice(17).trim();
      i++;
      while (i < lastNB && blank(lines[i])) i++;
      if (i < lastNB && !secMarker(lines[i])) throw new Exit2(`error: parse ${i + 1}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice(16).trim();
      const updateLine = i + 1;
      i++;
      let np: string | null = null;
      if (i < lastNB && lines[i].startsWith('*** Move to: ')) {
        np = lines[i].slice(13).trim();
        i++;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let hadChunk = false;
      while (i < lastNB) {
        const c = lines[i];
        if (blank(c)) {
          if (!cur) cur = { anchor: null, eof: false, body: [] };
          cur.body.push({ type: 'ctx', text: '' });
          i++;
          continue;
        }
        if (secMarker(c)) break;
        if (c.trim() === '*** End Patch') break;
        if (c.trim() === '*** End of File') {
          if (cur) cur.eof = true;
          else cur = { anchor: null, eof: true, body: [] };
          hadChunk = true;
          i++;
          continue;
        }
        if (c.startsWith('@@')) {
          if (cur) {
            chunks.push(cur);
            cur = null;
          }
          cur = { anchor: c.slice(2).trim(), eof: false, body: [] };
          hadChunk = true;
          i++;
          continue;
        }
        if (c.startsWith(' ') || c.startsWith('-') || c.startsWith('+')) {
          if (!cur) cur = { anchor: null, eof: false, body: [] };
          const type = c.startsWith(' ') ? 'ctx' : c.startsWith('-') ? 'old' : 'new';
          cur.body.push({ type, text: c.slice(1) } as HunkBodyEntry);
          hadChunk = true;
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur) chunks.push(cur);
      if (chunks.length) {
        const last = chunks[chunks.length - 1]!;
        while (last.body.length && last.body[last.body.length - 1].type === 'ctx' && last.body[last.body.length - 1].text === '') last.body.pop();
      }
      if (!hadChunk && np === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(makeV4aUpdate(p, np, chunks, strict, moves));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                         */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* The run (SPEC sections 1, 2, 10)                                    */
/* ------------------------------------------------------------------ */

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
  const moves: [string, string][] = [];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict, moves);
    else edits = [];
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
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const [o, n] of moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      covered.add(o);
      covered.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => BYTE(a, b))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => BYTE(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => BYTE(a, b))) {
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
