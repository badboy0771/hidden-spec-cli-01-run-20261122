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

/** A file's text as lines, its line break and whether it ends with one (SPEC.md section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** A line as a tier of SPEC.md section 5 reads it. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where oldLines occur in fileLines at one tier. */
function occurrencesAt(fileLines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const k = oldLines.length;
  if (k === 0) return out;
  for (let i = Math.max(0, from); i + k <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < k; j += 1) {
      if (normLine(fileLines[i + j]!, tier) !== normLine(oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 with --strict) at which oldLines occur, and where. */
function findTier(fileLines: string[], oldLines: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrencesAt(fileLines, oldLines, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/**
 * The replacement lines for a matched block: a context line (ctx[j] is its index in the old lines) is the file's own
 * matched line; any other line is re-indented at tier 2 (SPEC.md section 5), written as it is at tiers 0 and 1.
 */
function buildNew(
  newLines: string[],
  ctx: Array<number | null>,
  fileLines: string[],
  at: number,
  tier: number,
  oldLines: string[],
): string[] {
  const out: string[] = [];
  for (let j = 0; j < newLines.length; j += 1) {
    const c = ctx[j]!;
    if (c !== null) {
      out.push(fileLines[at + c]!);
      continue;
    }
    let line = newLines[j]!;
    if (tier === 2 && oldLines.length > 0 && line !== '' && !/^[ \t]+$/.test(line)) {
      const f = leadingWs(fileLines[at]!);
      const p = leadingWs(oldLines[0]!);
      if (line.startsWith(p)) line = f + line.slice(p.length);
    }
    out.push(line);
  }
  return out;
}

/** One body line of a unified hunk or a V4A chunk: ' ' and '' are context, '-' old, '+' new, '\\' a marker. */
interface BodyLine {
  kind: string;
  text: string;
}

/** Old and new lines of a hunk or chunk, with each new line's old-line index when it is a context line. */
function bodyLines(body: BodyLine[]): { O: string[]; N: string[]; ctx: Array<number | null> } {
  const O: string[] = [];
  const N: string[] = [];
  const ctx: Array<number | null> = [];
  for (const b of body) {
    if (b.kind === ' ' || b.kind === '') {
      O.push(b.text);
      N.push(b.text);
      ctx.push(O.length - 1);
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      N.push(b.text);
      ctx.push(null);
    }
  }
  return { O, N, ctx };
}

/** Whether a `\` line follows the hunk or chunk's last context or `+` line (SPEC.md section 6). */
function backslashAfterLast(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const kind = body[k]!.kind;
    if (kind === ' ' || kind === '' || kind === '+') {
      return body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
    }
  }
  return false;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, in patch order: used to print `R <old> -> <new>` lines. */
  readonly moves: Array<{ old: string; new: string }> = [];
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

/** SPEC.md section 6: unified diffs. */
interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UnifiedSection {
  oldPath: string;
  newPath: string;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}

function hunkHeaderA(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  return m === null ? null : Number(m[1]);
}

/** The path after `--- ` or `+++ `: up to the first tab, trimmed, without a leading `a/` or `b/`. */
function unifiedPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  interface Raw {
    pairOld: string | null;
    pairNew: string | null;
    renameFrom: string | null;
    renameTo: string | null;
    diffOld: string | null;
    diffNew: string | null;
    createFlag: boolean;
    deleteFlag: boolean;
    hunks: Hunk[];
    inHeader: boolean;
  }
  const raw: Raw[] = [];
  let cur: Raw | null = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        pairOld: null,
        pairNew: null,
        renameFrom: null,
        renameTo: null,
        diffOld: m[1]!,
        diffNew: m[2]!,
        createFlag: false,
        deleteFlag: false,
        hunks: [],
        inHeader: true,
      };
      raw.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.inHeader && cur.pairOld === null) {
        cur.pairOld = unifiedPath(line);
        cur.pairNew = unifiedPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      cur = {
        pairOld: unifiedPath(line),
        pairNew: unifiedPath(lines[i + 1]!),
        renameFrom: null,
        renameTo: null,
        diffOld: null,
        diffNew: null,
        createFlag: false,
        deleteFlag: false,
        hunks: [],
        inHeader: true,
      };
      raw.push(cur);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const a = hunkHeaderA(line);
      if (a === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.inHeader = false;
      i += 1;
      const body: BodyLine[] = [];
      while (i < n) {
        const b = lines[i]!;
        // The body ends at a `--- ` line followed by a `+++ ` line (a new section starts there).
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          body.push({ kind: '', text: '' });
          i += 1;
          continue;
        }
        const c = b[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push({ kind: c, text: b.slice(1) });
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === '') body.pop();
      cur.hunks.push({ a, body });
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.inHeader) throw new Exit2(`error: parse ${i + 2}`);
    if (cur !== null && cur.inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.createFlag = true;
      else if (line.startsWith('deleted file mode')) cur.deleteFlag = true;
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:` and any other line: ignored.
      i += 1;
      continue;
    }
    i += 1;
  }
  return raw.map((r) => {
    const sec: UnifiedSection = {
      oldPath: r.pairOld ?? r.renameFrom ?? r.diffOld ?? '',
      newPath: r.pairNew ?? r.renameTo ?? r.diffNew ?? '',
      createFlag: r.createFlag,
      deleteFlag: r.deleteFlag,
      hunks: r.hunks,
    };
    return unifiedSectionEdit(sec, strict);
  });
}

function unifiedSectionEdit(sec: UnifiedSection, strict: boolean): Edit {
  const isCreate = sec.oldPath === '/dev/null' || sec.createFlag;
  const isDelete = !isCreate && (sec.newPath === '/dev/null' || sec.deleteFlag);
  const isMove = !isCreate && !isDelete && sec.oldPath !== sec.newPath;
  return (tree) => {
    if (isCreate) {
      if (!safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);
      if (tree.get(sec.newPath) !== null) throw new Fail('exists', sec.newPath);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      let final = plus.length > 0;
      if (plus.length > 0) {
        outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
          const body = sec.hunks[hi]!.body;
          for (let k = body.length - 1; k >= 0; k -= 1) {
            if (body[k]!.kind === '+') {
              final = !(body[k + 1] !== undefined && body[k + 1]!.kind === '\\');
              break outer;
            }
          }
        }
      }
      tree.now.set(sec.newPath, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (!safe(sec.oldPath)) throw new Fail('unsafe', sec.oldPath);
      if (tree.get(sec.oldPath) === null) throw new Fail('missing', sec.oldPath);
      tree.now.set(sec.oldPath, null);
      return;
    }
    if (!safe(sec.oldPath)) throw new Fail('unsafe', sec.oldPath);
    if (isMove && !safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);
    const before = tree.get(sec.oldPath);
    if (before === null) throw new Fail('missing', sec.oldPath);
    if (isMove && tree.get(sec.newPath) !== null) throw new Fail('exists', sec.newPath);
    let { lines, br, final } = splitFile(before);
    let d = 0;
    for (const hunk of sec.hunks) {
      const { O, N, ctx } = bodyLines(hunk.body);
      const backslash = backslashAfterLast(hunk.body);
      if (O.length === 0) {
        const at = Math.min(hunk.a + d, lines.length);
        const atEnd = at === lines.length;
        lines.splice(at, 0, ...N);
        if (atEnd) final = !backslash;
      } else {
        const found = findTier(lines, O, strict);
        if (found === null) throw new Fail('no-match', sec.oldPath);
        const target = hunk.a - 1 + d;
        let best = found.at[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.at) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const endsAtEnd = best + O.length === lines.length;
        lines.splice(best, O.length, ...buildNew(N, ctx, lines, best, found.tier, O));
        if (endsAtEnd) final = !backslash;
      }
      d += N.length - O.length;
    }
    const out = joinFile(lines, br, final);
    if (isMove) {
      tree.now.set(sec.oldPath, null);
      tree.now.set(sec.newPath, out);
      tree.moves.push({ old: sec.oldPath, new: sec.newPath });
    } else {
      tree.now.set(sec.oldPath, out);
    }
  };
}

/** SPEC.md section 7: SEARCH/REPLACE blocks. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let j = i + 1;
    let eq = -1;
    while (j < n) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      j += 1;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let k = eq + 1;
    let rep = -1;
    while (k < n) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      k += 1;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let m = searchIdx - 1; m > prevReplaceEnd; m -= 1) {
      const t = lines[m]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srBlockEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const { lines, br, final } = splitFile(before);
    const found = findTier(lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const at = found.at[0]!;
    lines.splice(at, oldLines.length, ...buildNew(newLines, newLines.map(() => null), lines, at, found.tier, oldLines));
    tree.now.set(path, joinFile(lines, br, final));
  };
}

/** SPEC.md section 8: V4A patches. */
interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const sectionKind = (l: string): string | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const sectionPath = (l: string): string => l.slice(l.indexOf(': ') + 2).trim();
  /** True when every line from `at` to the next section start or `*** End Patch` is blank. */
  const trailingBlanks = (at: number): boolean => {
    for (let j = at; j < last; j += 1) {
      if (sectionKind(lines[j]!) !== null) return true;
      if (!blank(lines[j]!)) return false;
    }
    return true;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = sectionKind(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = sectionPath(line);
    const headerLine = i + 1;
    i += 1;
    if (kind === 'add') {
      const fileLines: Array<{ text: string; fromPlus: boolean }> = [];
      while (i < last) {
        const l = lines[i]!;
        if (sectionKind(l) !== null) break;
        if (l.startsWith('+')) {
          fileLines.push({ text: l.slice(1), fromPlus: true });
          i += 1;
          continue;
        }
        if (l === '') {
          fileLines.push({ text: '', fromPlus: false });
          i += 1;
          continue;
        }
        if (blank(l) && trailingBlanks(i)) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && !fileLines[fileLines.length - 1]!.fromPlus) fileLines.pop();
      const text = fileLines.map((f) => f.text);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, text.length === 0 ? '' : text.join('\n') + '\n');
      });
      continue;
    }
    if (kind === 'delete') {
      while (i < last) {
        const l = lines[i]!;
        if (sectionKind(l) !== null) break;
        if (blank(l)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    let moveTo: string | null = null;
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i += 1;
    }
    const chunks: V4aChunk[] = [];
    let chunk: V4aChunk | null = null;
    let seenChunk = false;
    while (i < last) {
      const l = lines[i]!;
      if (sectionKind(l) !== null) break;
      if (l === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
        chunk.eof = true;
        chunks.push(chunk);
        chunk = null;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        if (chunk !== null) {
          chunks.push(chunk);
          chunk = null;
        }
        const anchor = l.slice(2).trim();
        chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
        seenChunk = true;
        i += 1;
        continue;
      }
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
        if (chunk === null) {
          if (seenChunk) throw new Exit2(`error: parse ${i + 1}`);
          chunk = { anchor: null, eof: false, body: [] };
          seenChunk = true;
        }
        if (blank(l) && trailingBlanks(i)) break;
        chunk.body.push(l === '' ? { kind: '', text: '' } : { kind: l[0]!, text: l.slice(1) });
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (chunk !== null) {
      chunks.push(chunk);
      chunk = null;
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
    edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let { lines, br, final } = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findTier(lines, [chunk.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.at[0]! + 1;
      }
      const { O, N, ctx } = bodyLines(chunk.body);
      if (O.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        lines.splice(at, 0, ...N);
        cursor = at + N.length;
        continue;
      }
      // An end-of-file chunk takes only an occurrence ending at the file's last line, so its tier is the first tier
      // with such an occurrence; any other chunk takes the first occurrence at or after the cursor.
      const tiers = strict ? [0] : [0, 1, 2];
      let found: { tier: number; at: number } | null = null;
      for (const tier of tiers) {
        const at = occurrencesAt(lines, O, tier, cursor).find((p) => !chunk.eof || p + O.length === lines.length);
        if (at !== undefined) {
          found = { tier, at };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const at = found.at;
      lines.splice(at, O.length, ...buildNew(N, ctx, lines, at, found.tier, O));
      cursor = at + N.length;
    }
    const out = joinFile(lines, br, final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
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
  const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.now.get(m.old) === null && tree.original(m.new) === null && tree.now.get(m.new) !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const out = rows.map((r) => r.line);
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
