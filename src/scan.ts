// Finds Dataview blocks in note text, converts them, and builds the vault report. Pure: no `obsidian` import.
import { convertQuery, normalizeName } from './convert.ts';
import type { Conversion, ConvertOptions } from './convert.ts';

export interface Block {
  /** 0-based line of the opening fence. */
  start: number;
  /** 0-based line of the closing fence. */
  end: number;
  lang: 'dataview' | 'dataviewjs';
  body: string;
  /** Text before the fence on every line (indent, "> "). */
  prefix: string;
  fence: string;
}

const OPEN = /^(\s*(?:>\s*)*)(`{3,}|~{3,})\s*([^\s`]*)\s*$/;

const CLOSE = /^(\s*(?:>\s*)*)(`{3,}|~{3,})\s*$/;
const depth = (prefix: string) => (prefix.match(/>/g) ?? []).length;

function stripPrefix(line: string, prefix: string): string {
  return line.startsWith(prefix) ? line.slice(prefix.length) : line.replace(/^\s*(?:>\s?)*/, '');
}

export function findBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i]);
    if (!m) continue;
    const [, prefix, fence, langRaw] = m;
    const lang = langRaw.toLowerCase();
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const c = CLOSE.exec(lines[j]);
      if (c && c[2][0] === fence[0] && c[2].length >= fence.length && depth(c[1]) === depth(prefix)) { end = j; break; }
    }
    if (end < 0) break;
    if (lang === 'dataview' || lang === 'dataviewjs') {
      out.push({
        start: i,
        end,
        lang,
        body: lines.slice(i + 1, end).map((l) => stripPrefix(l, prefix)).join('\n'),
        prefix,
        fence,
      });
    }
    i = end;
  }
  return out;
}

/** Counts inline queries (`= …` and `$= …`) outside fenced code. */
export function countInline(text: string): number {
  const blocks: Array<[number, number]> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i]);
    if (!m) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const c = CLOSE.exec(lines[j]);
      if (c && c[2][0] === m[2][0] && c[2].length >= m[2].length && depth(c[1]) === depth(m[1])) { blocks.push([i, j]); i = j; break; }
    }
  }
  let n = 0;
  lines.forEach((line, i) => {
    if (blocks.some(([a, b]) => i >= a && i <= b)) return;
    n += (line.match(/`\$?=[^`]+`/g) ?? []).length;
  });
  return n;
}

export function convertBlock(block: Block, opts?: ConvertOptions): Conversion {
  if (block.lang === 'dataviewjs') {
    return { type: 'DATAVIEWJS', status: 'none', reasons: ['dataviewjs blocks run JavaScript, which Bases cannot express'], warnings: [] };
  }
  return convertQuery(block.body, opts);
}

/** The replacement lines for a converted block. */
export function renderBlock(block: Block, c: Conversion, keepOriginal: boolean): string[] {
  const yaml = (c.yaml ?? '').split('\n');
  const fence = block.fence[0].repeat(Math.max(3, block.fence.length));
  const lines = [`${fence}base`, ...yaml, fence];
  if (keepOriginal) {
    // inside a fence so its #tags and [[links]] do not count for this note; a %% comment hides it
    lines.push('%%', `${fence}dataview-original`, ...block.body.split('\n').map((l) => l.replace(/%%/g, '% %')), fence, '%%');
  }
  return lines.map((l) => block.prefix + l);
}

export interface Edit {
  block: Block;
  conversion: Conversion;
  lines?: string[];
}

export function planEdits(text: string, keepOriginal: boolean, only?: (b: Block) => boolean, opts?: ConvertOptions): Edit[] {
  return findBlocks(text)
    .filter((b) => (only ? only(b) : true))
    .map((block) => {
      const conversion = convertBlock(block, opts);
      return { block, conversion, lines: conversion.status === 'none' ? undefined : renderBlock(block, conversion, keepOriginal) };
    });
}

export interface FileScan {
  path: string;
  entries: Array<{ line: number; type: string; status: Conversion['status']; notes: string[] }>;
  inline: number;
}

export function scanText(path: string, text: string, opts?: ConvertOptions): FileScan | undefined {
  if (!/dataview|`\$?=/i.test(text)) return undefined;
  const entries = findBlocks(text).map((b) => {
    const c = convertBlock(b, opts);
    return { line: b.start + 1, type: c.type, status: c.status, notes: c.status === 'none' ? c.reasons : c.warnings };
  });
  const inline = countInline(text);
  if (!entries.length && !inline) return undefined;
  return { path, entries, inline };
}

const LABEL: Record<Conversion['status'], string> = { full: 'convertible', partly: 'partly', none: 'not convertible' };

export function buildReport(scans: FileScan[], filesChecked: number, date: string): string {
  const all = ([] as FileScan['entries']).concat(...scans.map((s) => s.entries));
  const count = (st: Conversion['status']) => all.filter((e) => e.status === st).length;
  const inline = scans.reduce((n, s) => n + s.inline, 0);
  const out: string[] = [
    '# Dataview to Bases report',
    '',
    `Scanned ${filesChecked} notes on ${date}. This note is rewritten on every scan; no other note was changed.`,
    '',
    `- ${all.length} Dataview queries in ${scans.filter((s) => s.entries.length).length} notes`,
    `- ${count('full')} convertible, ${count('partly')} partly (converted with a difference), ${count('none')} not convertible`,
    `- ${inline} inline queries (\`=\` expressions), which Bases cannot replace`,
    '',
    'To convert a query, open its note and run "Convert Dataview query at cursor to Bases" or "Convert all Dataview queries in this note".',
  ];
  if (!scans.length) return out.concat('', 'No Dataview queries found.', '').join('\n');
  out.push('', '## Notes', '', '| Note | Line | Query | Result | Details |', '| --- | --- | --- | --- | --- |');
  for (const s of scans) {
    for (const e of s.entries) {
      out.push(`| [[${s.path}]] | ${e.line} | ${e.type} | ${LABEL[e.status]} | ${e.notes.join('; ').replace(/\|/g, '/') || ''} |`);
    }
    if (s.inline) out.push(`| [[${s.path}]] | | inline | not convertible | ${s.inline} inline \`=\` ${s.inline === 1 ? 'query' : 'queries'} |`);
  }
  return out.concat('').join('\n');
}

const INLINE_LINE = /^[ \t>]*(?:[-*+]\s+(?:\[.\]\s+)?)?([^\s:[\]()`][^:[\]()`\n]*?)::(?:\s|$)/gm;
const INLINE_BRACKET = /[[(]([^\s:[\]()`][^:[\]()`\n]*?)::\s/g;

/** Names of Dataview inline fields (`key:: value`, `[key:: value]`, `(key:: value)`) in the text, outside code fences. */
export function inlineFieldNames(text: string): Set<string> {
  const names = new Set<string>();
  const lines = text.split('\n');
  const skip = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i]);
    if (!m || skip.has(i)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const c = CLOSE.exec(lines[j]);
      if (c && c[2][0] === m[2][0] && c[2].length >= m[2].length) {
        for (let k = i; k <= j; k++) skip.add(k);
        break;
      }
    }
  }
  const body = lines.map((l, i) => (skip.has(i) ? '' : l)).join('\n');
  for (const re of [INLINE_LINE, INLINE_BRACKET]) {
    re.lastIndex = 0;
    for (let m = re.exec(body); m; m = re.exec(body)) names.add(normalizeName(m[1]));
  }
  return names;
}
