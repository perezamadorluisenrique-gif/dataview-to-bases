// Finds Dataview inline fields (`key:: value`) in note text and plans moving them into properties.
// Pure: no `obsidian` import.

/** A value as it is written into the front matter. */
export type PropValue = string | number | boolean | Array<string | number | boolean>;

export interface Field {
  /** 0-based line. */
  line: number;
  /** `line`: the whole line is the field. `bracket`: `[key:: value]` or `(key:: value)` inside prose. */
  kind: 'line' | 'bracket';
  /** The key as written. */
  key: string;
  /** The value as written, trimmed. */
  raw: string;
  /** The text of the line the field was found on (without a trailing CR). */
  source: string;
}

export interface Skipped {
  field: Field;
  reason: string;
}

export interface Parsed {
  fields: Field[];
  skipped: Skipped[];
}

const FENCE_OPEN = /^(\s*(?:>\s*)*)(`{3,}|~{3,})/;
const FENCE_CLOSE = /^(\s*(?:>\s*)*)(`{3,}|~{3,})\s*$/;
// A key: no colon, brackets, backticks or markdown emphasis, and no leading space.
const KEY = String.raw`[^\s:[\]()` + '`' + String.raw`*~=|#][^:[\]()` + '`' + String.raw`*\n]*?`;
const LIST_ITEM = /^\s*(?:[-+*]|\d+[.)])\s/;
const LIST_OR_QUOTE = /^(?:\s*(?:[-+*]|\d+[.)])\s|\s*>|[ \t]+)/;
const LINE_FIELD = new RegExp(String.raw`^(${KEY})::(?:[ \t]+(.*))?$`);
const BRACKET_START = new RegExp(String.raw`^(${KEY})::[ \t]+`);

/** Index of the first line after the front matter (0 when there is none). */
export function frontMatterEnd(lines: string[]): number {
  if (!lines.length || lines[0].replace(/\r$/, '') !== '---') return 0;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');
    if (l === '---' || l === '...') return i + 1;
  }
  return 0;
}

/** Ranges [from, to) of the inline code spans on a line. */
function codeSpans(line: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') { i++; continue; }
    let n = 0;
    while (line[i + n] === '`') n++;
    let j = i + n;
    let close = -1;
    while (j < line.length) {
      if (line[j] !== '`') { j++; continue; }
      let m = 0;
      while (line[j + m] === '`') m++;
      if (m === n) { close = j; break; }
      j += m;
    }
    if (close < 0) { i += n; continue; }
    out.push([i, close + n]);
    i = close + n;
  }
  return out;
}

/** Bracketed fields `[key:: value]` / `(key:: value)` on one line, outside inline code. */
function bracketFields(line: string): Array<{ key: string; raw: string }> {
  const spans = codeSpans(line);
  const inCode = (p: number) => spans.some(([a, b]) => p >= a && p < b);
  const out: Array<{ key: string; raw: string }> = [];
  let i = 0;
  while (i < line.length) {
    const open = line[i];
    if ((open !== '[' && open !== '(') || inCode(i) || line[i - 1] === '[' || line[i + 1] === '[') { i++; continue; }
    const m = BRACKET_START.exec(line.slice(i + 1));
    if (!m) { i++; continue; }
    const close = open === '[' ? ']' : ')';
    const start = i + 1 + m[0].length;
    let depth = 1;
    let j = start;
    for (; j < line.length; j++) {
      if (inCode(j)) continue;
      if (line[j] === open) depth++;
      else if (line[j] === close && --depth === 0) break;
    }
    if (depth !== 0) { i++; continue; }
    out.push({ key: m[1].trim(), raw: line.slice(start, j).trim() });
    i = j + 1;
  }
  return out;
}

/**
 * The inline fields of a note, in order. Front matter, fenced code, math blocks,
 * `%%` comments and inline code are skipped. Fields in list items or quotes are
 * only found when they are bracketed.
 */
export function parseFields(text: string): Parsed {
  const lines = text.split('\n');
  const fields: Field[] = [];
  const skipped: Skipped[] = [];
  let fence: { char: string; len: number; depth: number } | undefined;
  let math = false;
  let comment = false;
  for (let i = frontMatterEnd(lines); i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (fence) {
      const c = FENCE_CLOSE.exec(line);
      if (c && c[2][0] === fence.char && c[2].length >= fence.len && (c[1].match(/>/g) ?? []).length === fence.depth) fence = undefined;
      continue;
    }
    const o = FENCE_OPEN.exec(line);
    if (o && !(o[2][0] === '`' && line.slice(o[0].length).includes('`'))) {
      fence = { char: o[2][0], len: o[2].length, depth: (o[1].match(/>/g) ?? []).length };
      continue;
    }
    const trimmed = line.trim();
    if (math) { if (trimmed.endsWith('$$')) math = false; continue; }
    if (trimmed.startsWith('$$') && !(trimmed.length > 2 && trimmed.endsWith('$$'))) { math = true; continue; }
    if (comment) { if (trimmed.endsWith('%%')) comment = false; continue; }
    if (trimmed.startsWith('%%') && !(trimmed.length > 2 && trimmed.endsWith('%%'))) { comment = true; continue; }
    if (trimmed.startsWith('%%')) continue; // a one-line comment
    if (/^( {4}|\t)/.test(line) && !LIST_ITEM.test(line)) continue; // indented code

    const lf = LIST_OR_QUOTE.test(line) ? null : LINE_FIELD.exec(line.replace(/\s+$/, ''));
    if (lf) {
      const field: Field = { line: i, kind: 'line', key: lf[1].trim(), raw: (lf[2] ?? '').trim(), source: line };
      if (field.raw === '') skipped.push({ field, reason: 'empty value' });
      else fields.push(field);
      continue;
    }
    if (!line.includes('::')) continue;
    for (const b of bracketFields(line)) {
      const field: Field = { line: i, kind: 'bracket', key: b.key, raw: b.raw, source: line };
      if (field.raw === '') skipped.push({ field, reason: 'empty value' });
      else fields.push(field);
    }
  }
  return { fields, skipped };
}

/** Whether a key can be used as a property name exactly as written. */
export function isValidPropertyName(key: string): boolean {
  return /^[\p{L}\p{N}_-]+$/u.test(key);
}

/** The property a key becomes: kept as written when valid, else normalised like Dataview. */
export function propertyName(key: string): string {
  const k = key.trim();
  if (isValidPropertyName(k)) return k;
  return k.toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').replace(/^-+|-+$/g, '');
}

type Scalar = string | number | boolean;

/** Splits on commas that are not inside `[[…]]`. */
function splitCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith('[[', i)) { depth++; cur += '[['; i++; continue; }
    if (s.startsWith(']]', i) && depth > 0) { depth--; cur += ']]'; i++; continue; }
    if (s[i] === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

const WIKILINK = /^\[\[[^[\]]+\]\]$/;

function scalar(raw: string): Scalar {
  const s = raw.trim();
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    // keep "007", "1.50" and numbers too long for a double as the text they are
    if (Number.isFinite(n) && String(n) === s) return n;
    return s;
  }
  // ISO dates and datetimes (2026-10-10, 2026-10-10T09:30) stay the text they were written as:
  // that is how Obsidian stores a date property, and the value is not reformatted.
  return s;
}

/** Converts a written value to what the property holds. Links stay as `[[link]]` strings. */
export function typedValue(key: string, raw: string): PropValue {
  const name = propertyName(key).toLowerCase();
  if (name === 'tags' || name === 'aliases' || name === 'cssclasses') {
    const parts = splitCommas(raw).map((p) => (name === 'tags' ? p.replace(/^#/, '').replace(/\s+/g, '-') : p)).filter((p) => p !== '');
    return parts;
  }
  const parts = splitCommas(raw);
  if (parts.length > 1 && parts.every((p) => WIKILINK.test(p))) return parts;
  return scalar(raw);
}

export interface Move {
  /** The property to write. */
  property: string;
  value: PropValue;
  fields: Field[];
}

export interface Conflict {
  property: string;
  /** What the note already has. */
  existing: unknown;
  value: PropValue;
  fields: Field[];
}

export interface Plan {
  /** Properties to add. */
  moves: Move[];
  /** Properties the note already has with the same value: nothing to write, the text can go. */
  same: Move[];
  /** Properties the note already has with a different value: nothing changes. */
  conflicts: Conflict[];
  skipped: Skipped[];
}

function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v) ?? '';
}

function flat(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(text);
  if (v === null || v === undefined) return [];
  return [text(v)];
}

/** Whether a property already holds this value. A one-item list equals its item. */
export function sameValue(existing: unknown, value: PropValue): boolean {
  const a = flat(existing);
  const b = flat(value);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Looks a property up ignoring case, like Obsidian's property list does. */
export function findKey(existing: Record<string, unknown>, property: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(existing, property)) return property;
  const lower = property.toLowerCase();
  return Object.keys(existing).find((k) => k.toLowerCase() === lower);
}

/**
 * Decides what each field becomes. Repeated keys make one list. A property the
 * note already has is never overwritten.
 */
export function planFields(parsed: Parsed, existing: Record<string, unknown>): Plan {
  const skipped = parsed.skipped.slice();
  const groups = new Map<string, { property: string; fields: Field[] }>();
  for (const f of parsed.fields) {
    const property = propertyName(f.key);
    if (!property) { skipped.push({ field: f, reason: 'not a usable property name' }); continue; }
    const id = property.toLowerCase();
    const g = groups.get(id);
    if (g) g.fields.push(f);
    else groups.set(id, { property, fields: [f] });
  }
  const plan: Plan = { moves: [], same: [], conflicts: [], skipped };
  groups.forEach((g) => {
    const values = g.fields.map((f) => typedValue(f.key, f.raw));
    const value: PropValue = values.length === 1 ? values[0] : ([] as Scalar[]).concat(...values);
    const have = findKey(existing, g.property);
    if (have === undefined) plan.moves.push({ property: g.property, value, fields: g.fields });
    else if (sameValue(existing[have], value)) plan.same.push({ property: have, value, fields: g.fields });
    else plan.conflicts.push({ property: have, existing: existing[have], value, fields: g.fields });
  });
  return plan;
}

/** A line-kind field is removed from the text; bracketed ones are prose and stay. */
export function removableLines(plan: Plan): number[] {
  const lines: number[] = [];
  for (const m of plan.moves.concat(plan.same)) {
    for (const f of m.fields) if (f.kind === 'line') lines.push(f.line);
  }
  return lines.sort((a, b) => a - b);
}

/** The text without the given lines. Does nothing to a line that is not a field line any more. */
export function removeLines(text: string, lines: number[]): string {
  const drop = new Set(lines);
  return text.split('\n').filter((_, i) => !drop.has(i)).join('\n');
}

/** A short label for a value in the preview. */
export function showValue(v: unknown): string {
  return Array.isArray(v) ? `[${v.map(text).join(', ')}]` : text(v);
}

/**
 * Removes the field lines whose text is exactly `sources` (each source once).
 * Returns `undefined`, and removes nothing, when the text no longer has all of
 * them as field lines: the note changed since it was read.
 */
export function removeFieldLines(text: string, sources: string[]): string | undefined {
  const left = new Map<string, number>();
  for (const s of sources) left.set(s, (left.get(s) ?? 0) + 1);
  const drop: number[] = [];
  for (const f of parseFields(text).fields) {
    if (f.kind !== 'line') continue;
    const n = left.get(f.source) ?? 0;
    if (n > 0) { left.set(f.source, n - 1); drop.push(f.line); }
  }
  if (drop.length !== sources.length) return undefined;
  return removeLines(text, drop);
}

/** The text of the field lines the plan removes. */
export function removableSources(plan: Plan): string[] {
  const out: string[] = [];
  for (const m of plan.moves.concat(plan.same)) {
    for (const f of m.fields) if (f.kind === 'line') out.push(f.source);
  }
  return out;
}
