// Maps a parsed Dataview query to the text of a Bases block. Pure: no `obsidian` import.
import { DqlError, parseQuery } from './dql.ts';
import type { Expr, Query, Source } from './dql.ts';
import { dump } from './yaml.ts';
import type { Yaml } from './yaml.ts';

export type Status = 'full' | 'partly' | 'none';

export interface Conversion {
  type: Query['type'] | 'DATAVIEWJS' | 'UNKNOWN';
  status: Status;
  /** The base block body (YAML) when status is not "none". */
  yaml?: string;
  /** Why a query cannot be converted. */
  reasons: string[];
  /** What changes behaviour in a converted query. */
  warnings: string[];
}

const FILE_FIELDS: Record<string, string> = {
  name: 'file.basename',
  path: 'file.path',
  folder: 'file.folder',
  ext: 'file.ext',
  size: 'file.size',
  ctime: 'file.ctime',
  mtime: 'file.mtime',
  tags: 'file.tags',
  etags: 'file.tags',
  outlinks: 'file.links',
  inlinks: 'file.backlinks',
  frontmatter: 'file.properties',
  cday: 'file.ctime.date()',
  mday: 'file.mtime.date()',
  link: 'file.asLink()',
  aliases: 'note.aliases',
};
const FILE_UNSUPPORTED: Record<string, string> = {
  tasks: 'file.tasks has no equivalent in Bases',
  lists: 'file.lists has no equivalent in Bases',
  day: 'file.day (the date in the note title) has no equivalent in Bases',
  starred: 'file.starred has no equivalent in Bases',
};

// method-style functions: dql name -> [bases method, argument count]
const METHODS: Record<string, [string, number]> = {
  lower: ['lower', 0],
  contains: ['contains', 1],
  startswith: ['startsWith', 1],
  endswith: ['endsWith', 1],
  replace: ['replace', 2],
  split: ['split', 1],
  join: ['join', 1],
  reverse: ['reverse', 0],
  flat: ['flat', 0],
  sort: ['sort', 0],
  striptime: ['date', 0],
  floor: ['floor', 0],
  ceil: ['ceil', 0],
  abs: ['abs', 0],
  string: ['toString', 0],
};
const UNSUPPORTED_FN = new Set([
  'extract', 'product', 'containsword', 'meta', 'elink', 'object', 'minby', 'maxby', 'ldefault', 'display', 'firstvalue',
  'embed', 'hash', 'durationformat', 'currencyformat', 'localtime',
]);
/** Why a Dataview function has no Bases equivalent, when the plain "no equivalent" needs a word more. */
const NO_EQUIVALENT: Record<string, string> = {
  upper: 'the function upper() has no equivalent in Bases (it has lower() and title(), but no upper case)',
  product: 'the function product() has no equivalent in Bases',
};

/** The first public Obsidian release with the list functions sum(), min() and max() (1.11.0 to 1.11.3 were early access). */
const LIST_MATH = '1.11.4';

/** Dataview's typeof() names and the matching Bases isType() test (Bases counts a link as text too). */
const TYPE_TEST: Record<string, (x: string) => string> = {
  string: (x) => `(${x}.isType("string") && !${x}.isType("link"))`,
  number: (x) => `${x}.isType("number")`,
  boolean: (x) => `${x}.isType("boolean")`,
  date: (x) => `${x}.isType("date")`,
  duration: (x) => `${x}.isType("duration")`,
  link: (x) => `${x}.isType("link")`,
  array: (x) => `${x}.isType("list")`,
  object: (x) => `${x}.isType("object")`,
  null: (x) => `${x}.isType("null")`,
};

/** -1, 0 or 1 for two dotted version numbers. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** A JavaScript regular expression literal for a Dataview pattern (a string), or undefined when it is not valid. */
export function regexLiteral(pattern: string, flags = ''): string | undefined {
  try {
    new RegExp(pattern, flags);
  } catch {
    return undefined;
  }
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { out += c + (pattern[i + 1] ?? ''); i++; }
    else if (c === '/') out += '\\/';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else out += c;
  }
  return `/${out || '(?:)'}/${flags}`;
}

class Ctx {
  reasons: string[] = [];
  warnings: string[] = [];
  formulas: Record<string, string> = {};
  groupKey?: string;
  grouped = false;
  inline = new Set<string>();
  appVersion?: string;
  /** Names of the lambdas being converted, innermost last; the innermost one is Bases' `value`. */
  lambdas: string[] = [];

  fail(reason: string): string {
    if (!this.reasons.includes(reason)) this.reasons.push(reason);
    return '?';
  }
  warn(w: string): void {
    if (!this.warnings.includes(w)) this.warnings.push(w);
  }
  /** False (with the reason) when the Obsidian in use is older than `min`. */
  needs(min: string, what: string): boolean {
    if (!this.appVersion || compareVersions(this.appVersion, min) >= 0) return true;
    this.fail(`${what} needs Obsidian ${min.split('.').slice(0, 2).join('.')} or newer in Bases`);
    return false;
  }
  addFormula(prefix: string, expr: string): string {
    for (const [k, v] of Object.entries(this.formulas)) if (v === expr) return `formula.${k}`;
    const name = `${prefix}${Object.keys(this.formulas).length + 1}`;
    this.formulas[name] = expr;
    return `formula.${name}`;
  }
}

const SIMPLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PRIMARY = new Set(['id', 'member', 'index', 'call', 'str', 'num', 'bool', 'null', 'list']);
const PREC: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 3, '>': 3, '<=': 3, '>=': 3, '+': 4, '-': 4, '*': 5, '/': 5, '%': 5 };
const q = (s: string) => JSON.stringify(s);

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

function noteRef(name: string): string {
  return SIMPLE.test(name) ? `note.${name}` : `note[${q(name)}]`;
}

function flatten(e: Expr): { root: string; path: string[] } | undefined {
  const path: string[] = [];
  let cur = e;
  while (cur.k === 'member') { path.unshift(cur.name); cur = cur.obj; }
  return cur.k === 'id' ? { root: cur.name, path } : undefined;
}

function wrap(e: Expr, s: string): string {
  return PRIMARY.has(e.k) ? s : `(${s})`;
}

function dateWord(w: string, ctx: Ctx): string {
  switch (w.toLowerCase()) {
    case 'today': return 'today()';
    case 'now': return 'now()';
    case 'tomorrow': return 'today() + "1 day"';
    case 'yesterday': return 'today() - "1 day"';
    default: return ctx.fail(`date(${w}) has no equivalent in Bases`);
  }
}

function field(e: Expr, ctx: Ctx): string | undefined {
  const f = flatten(e);
  if (!f) return undefined;
  const at = ctx.lambdas.lastIndexOf(f.root);
  if (at >= 0) {
    if (at !== ctx.lambdas.length - 1) return ctx.fail('a lambda that uses the item of an outer lambda has no equivalent in Bases');
    if (f.path.length) return ctx.fail(`a field of a list item (${[f.root, ...f.path].join('.')}) has no equivalent in Bases`);
    return 'value';
  }
  return fieldFrom(f.root, f.path, ctx);
}

/** The body of `(x) => body` for Bases' map() and filter(), where the item is `value`. */
function lambdaBody(e: Expr, fn: string, ctx: Ctx): string {
  if (e.k !== 'lambda') return ctx.fail(`${fn}() without a lambda such as (x) => x > 1`);
  if (e.params.length !== 1) return ctx.fail(`${fn}() with a lambda of ${e.params.length} names`);
  ctx.lambdas.push(e.params[0]);
  try {
    return emitExpr(e.body, ctx);
  } finally {
    ctx.lambdas.pop();
  }
}

/** True when the expression reads the rows of a GROUP BY group. */
function readsRows(e: Expr, ctx: Ctx): boolean {
  const f = flatten(e);
  return ctx.grouped && !!f && f.root.toLowerCase() === 'rows';
}

const isNoteRef = (s: string) => /^(this\.)?note[.[]/.test(s);

function fieldFrom(root: string, path: string[], ctx: Ctx): string {
  const low = root.toLowerCase();
  if (low === 'file') {
    if (path.length === 0) return 'file';
    const [first, ...rest] = path;
    if (FILE_UNSUPPORTED[first]) return ctx.fail(FILE_UNSUPPORTED[first]);
    const mapped = FILE_FIELDS[first];
    if (!mapped) return ctx.fail(`file.${first} is not a Dataview field`);
    if (first === 'etags') ctx.warn('file.etags (exact tags) becomes file.tags, which also lists nested parents');
    return rest.length ? `${mapped}.${rest.join('.')}` : mapped;
  }
  if (low === 'this') {
    if (path[0] === 'file') {
      const sub = FILE_FIELDS[path[1] ?? ''];
      if (path.length === 1) return 'this.file';
      if (sub && sub.startsWith('file.')) return `this.${sub}${path.slice(2).length ? '.' + path.slice(2).join('.') : ''}`;
      return ctx.fail(`this.file.${path[1]} is not supported`);
    }
    ctx.warn('Properties of the current page (this.x) should be checked in the result');
    return path.length ? `this.note.${path.join('.')}` : 'this';
  }
  if (ctx.grouped && low === 'key' && path.length === 0) {
    return ctx.groupKey ?? ctx.fail('key refers to a grouping that cannot be converted');
  }
  if (ctx.grouped && low === 'rows') {
    if (path.length === 0) return ctx.fail('rows (the grouped rows) has no equivalent in Bases');
    ctx.warn('After GROUP BY, Bases lists every note under its group heading instead of one row per group');
    return fieldFrom(path[0], path.slice(1), ctx);
  }
  if (ctx.inline.has(normalizeName(root))) {
    ctx.warn(`"${root}" is an inline field (${root}:: …) in your vault, and Bases reads only properties in the frontmatter`);
  }
  if (!SIMPLE.test(root)) {
    ctx.warn(`Dataview also matches "${root}" under other spellings (due-date for Due Date); Bases needs the property name exactly as written`);
  }
  return noteRef(root) + path.map((p) => (SIMPLE.test(p) ? `.${p}` : `[${q(p)}]`)).join('');
}

export function emitExpr(e: Expr, ctx: Ctx, top = true): string {
  const f = field(e, ctx);
  if (f !== undefined) return f;
  switch (e.k) {
    case 'num': return String(e.v);
    case 'str': return q(e.v);
    case 'bool': return String(e.v);
    case 'null': return 'null';
    case 'dur': return q(e.v);
    case 'tag': return q(e.v);
    case 'link': return `link(${q(e.v)})`;
    case 'lambda': return ctx.fail('a lambda (x) => … outside map(), filter(), any(), all() or none()');
    case 'id': return ctx.fail(`unknown name ${e.name}`);
    case 'member': {
      const o = emitExpr(e.obj, ctx, false);
      return `${wrap(e.obj, o)}.${e.name}`;
    }
    case 'index': return `${wrap(e.obj, emitExpr(e.obj, ctx, false))}[${emitExpr(e.idx, ctx)}]`;
    case 'list': return `[${e.items.map((i) => emitExpr(i, ctx)).join(', ')}]`;
    case 'un': {
      const inner = emitExpr(e.e, ctx, false);
      // Bases gives !null = null, so `!x` would drop the notes without x; Dataview counts null as false and lists them
      const plain = e.op !== '!' || e.e.k === 'bool' || (e.e.k === 'bin' && (e.e.op === '==' || e.e.op === '!='));
      const s = plain ? `${e.op}${e.e.k === 'bin' ? `(${inner})` : wrap(e.e, inner)}` : `!${wrap(e.e, inner)}.isTruthy()`;
      return top ? s : `(${s})`;
    }
    case 'bin': {
      if (e.op === '==' || e.op === '!=') {
        const t = typeTest(e.l, e.r, ctx) ?? typeTest(e.r, e.l, ctx);
        if (t !== undefined) return e.op === '==' ? t : `!${t}`;
      }
      if (['<', '<=', '>', '>='].includes(e.op)) {
        const numL = e.l.k === 'num';
        const numR = e.r.k === 'num';
        // only "x < 5" (or "5 > x") lists a note without x in Dataview; "x > 5" leaves it out in both
        const less = (numR && (e.op === '<' || e.op === '<=')) || (numL && (e.op === '>' || e.op === '>='));
        const other = !less ? undefined : numL ? e.r : numR ? e.l : undefined;
        // an item of a lambda, a file field, or length() (0 for a missing value) is never empty
        const root = other ? flatten(other)?.root ?? '' : '';
        const item = other && (ctx.lambdas.includes(root) || root.toLowerCase() === 'file' || (other.k === 'call' && other.fn.toLowerCase() === 'length'));
        if (other && other.k !== 'num' && other.k !== 'un' && !item) {
          ctx.warn('A note without the property: Dataview counts an empty value as smaller than any number (so "x < 5" lists it), while Bases does not match it. Add a check for an empty value if you need that');
        }
      }
      const side = (child: Expr, right: boolean) => {
        const s = emitExpr(child, ctx, true);
        if (child.k !== 'bin') return s;
        const pc = PREC[child.op];
        const pp = PREC[e.op];
        return pc < pp || (pc === pp && right) ? `(${s})` : s;
      };
      return `${side(e.l, false)} ${e.op} ${side(e.r, true)}`;
    }
    case 'call': return emitCall(e, ctx);
  }
}

/** `typeof(x) = "number"` as `x.isType("number")`. */
function typeTest(call: Expr, name: Expr, ctx: Ctx): string | undefined {
  if (call.k !== 'call' || call.fn.toLowerCase() !== 'typeof' || call.args.length !== 1 || name.k !== 'str') return undefined;
  const test = TYPE_TEST[name.v];
  if (!test) return ctx.fail(`typeof() compared with "${name.v}" has no equivalent in Bases`);
  return test(wrap(call.args[0], emitExpr(call.args[0], ctx, false)));
}

/** Numbers written in the query, or undefined. */
const numLit = (e: Expr | undefined) => (e?.k === 'num' ? e.v : e?.k === 'un' && e.op === '-' && e.e.k === 'num' ? -e.e.v : undefined);

function emitCall(e: Extract<Expr, { k: 'call' }>, ctx: Ctx): string {
  const fn = e.fn.toLowerCase();
  const a = e.args;
  const arg = (i: number) => emitExpr(a[i], ctx);
  const recv = (i: number) => wrap(a[i], emitExpr(a[i], ctx, false));
  if (fn === 'date' && a.length === 1) {
    if (a[0].k === 'id' && !flatten(a[0])?.path.length && /^(today|now|tomorrow|yesterday|sow|eow|som|eom|soy|eoy)$/i.test(a[0].name)) {
      return dateWord(a[0].name, ctx);
    }
    return `date(${arg(0)})`;
  }
  if (fn === 'dur' && a.length === 1) {
    const d = a[0];
    if (d.k === 'dur') return q(d.v);
    if (d.k === 'str') return q(d.v);
    return ctx.fail('dur() with a computed value');
  }
  if (fn === 'contains' && a.length === 2) {
    const f = flatten(a[0]);
    if (f && f.root.toLowerCase() === 'file' && f.path.join('.') === 'tags') {
      if (a[1].k === 'str') return `file.hasTag(${q(a[1].v.replace(/^#/, ''))})`;
      return ctx.fail('contains(file.tags, …) with a value that is not a plain string');
    }
    const recvText = recv(0);
    if (isNoteRef(recvText)) {
      ctx.warn('On list properties, Dataview contains() also matches part of an item and Bases only matches whole items');
    }
    caseWarning(recvText, a[1], ctx);
    return `${recvText}.contains(${arg(1)})`;
  }
  if (fn === 'icontains' && a.length === 2) return `${recv(0)}.lower().contains(${wrap(a[1], emitExpr(a[1], ctx, false))}.lower())`;
  if (fn === 'econtains' && a.length === 2) {
    const recvText = recv(0);
    caseWarning(recvText, a[1], ctx);
    return `${recvText}.contains(${arg(1)})`;
  }
  if (fn === 'containsany' || fn === 'containsall') {
    if (a.length >= 2) return `${recv(0)}.${fn === 'containsany' ? 'containsAny' : 'containsAll'}(${a.slice(1).map((_, i) => arg(i + 1)).join(', ')})`;
  }
  if (fn === 'length' && a.length === 1) {
    if (readsRows(a[0], ctx)) return ctx.fail('length() over the rows of a group has no equivalent in Bases');
    const r = recv(0);
    // Dataview gives 0 for a missing value, Bases gives nothing
    return isNoteRef(r) ? `if(${r} == null, 0, ${r}.length)` : `${r}.length`;
  }
  if (fn === 'default' && a.length === 2) {
    const x = emitExpr(a[0], ctx);
    // Dataview replaces only a missing value; `if(x, x, y)` would also replace 0, false and ""
    return `if(${x} == null, ${arg(1)}, ${x})`;
  }
  if (fn === 'choice' && a.length === 3) return `if(${arg(0)}, ${arg(1)}, ${arg(2)})`;
  if (fn === 'number' && a.length === 1) return `number(${arg(0)})`;
  if (fn === 'link' && a.length >= 1 && a.length <= 2) return `link(${a.map((_, i) => arg(i)).join(', ')})`;
  if (fn === 'min' || fn === 'max') {
    if (a.length >= 2) {
      if (a.some((x) => numLit(x) === undefined)) {
        ctx.warn('min() and max(): when one of the values is missing, Dataview uses the others and Bases shows nothing');
      }
      return `${fn}(${a.map((_, i) => arg(i)).join(', ')})`;
    }
    if (a.length === 1) return listMath(fn, fn, a[0], ctx, LIST_MATH);
  }
  if (fn === 'sum' && a.length === 1) return listMath('sum', 'sum', a[0], ctx, LIST_MATH);
  if (fn === 'average' && a.length === 1) return listMath('average', 'mean', a[0], ctx);
  if ((fn === 'map' || fn === 'filter') && a.length === 2) {
    if (readsRows(a[0], ctx)) return ctx.fail(`${fn}() over the rows of a group has no equivalent in Bases`);
    const r = recv(0);
    return `${r}.${fn}(${lambdaBody(a[1], fn, ctx)})`;
  }
  if ((fn === 'any' || fn === 'all' || fn === 'none') && (a.length === 1 || (a.length === 2 && a[1].k === 'lambda'))) {
    if (readsRows(a[0], ctx)) return ctx.fail(`${fn}() over the rows of a group has no equivalent in Bases`);
    const r = recv(0);
    if (isNoteRef(r)) ctx.warn('any(), all() and none() on a note without the list: Dataview still gives an answer for it, Bases leaves the note out');
    const kept = `${r}.filter(${a.length === 2 ? lambdaBody(a[1], fn, ctx) : 'value'}).length`;
    return fn === 'any' ? `${kept} > 0` : fn === 'none' ? `${kept} == 0` : `${kept} == ${r}.length`;
  }
  if (fn === 'nonnull' && a.length === 1) return `${recv(0)}.filter(value != null)`;
  if (fn === 'typeof') return ctx.fail('typeof() is converted only when it is compared with a type name, as in typeof(x) = "number"');
  if (fn === 'regextest' || fn === 'regexmatch') {
    if (a.length !== 2) return ctx.fail(`${e.fn}() with ${a.length} arguments`);
    if (a[0].k !== 'str') return ctx.fail(`${e.fn}() with a pattern that is not written in the query`);
    let p = a[0].v;
    // Dataview's regexmatch() must match the whole text unless the pattern is anchored already
    if (fn === 'regexmatch' && !p.startsWith('^') && !p.endsWith('$')) p = `^${p}$`;
    const re = regexLiteral(p);
    return re ? `${re}.matches(${arg(1)})` : ctx.fail(`"${a[0].v}" is not a valid regular expression`);
  }
  if (fn === 'regexreplace' && a.length === 3) {
    if (a[1].k !== 'str') return ctx.fail('regexreplace() with a pattern that is not written in the query');
    const re = regexLiteral(a[1].v, 'g');
    return re ? `${recv(0)}.replace(${re}, ${arg(2)})` : ctx.fail(`"${a[1].v}" is not a valid regular expression`);
  }
  if (fn === 'split' && (a.length === 2 || a.length === 3)) {
    const r = recv(0);
    let sep: string;
    if (a[1].k === 'str') {
      // Dataview splits on a regular expression; plain text stays plain text, which Bases reads the same
      if (/[\\^$.*+?()[\]{}|]/.test(a[1].v)) {
        const re = regexLiteral(a[1].v);
        if (!re) return ctx.fail(`"${a[1].v}" is not a valid regular expression`);
        if (/\((?!\?)/.test(a[1].v)) ctx.warn('split() with a group in the pattern: Dataview turns an unmatched group into empty text, Bases leaves it empty');
        sep = re;
      } else sep = q(a[1].v);
    } else {
      ctx.warn('split() with a separator that is not written in the query: Dataview reads it as a regular expression, Bases as plain text');
      sep = arg(1);
    }
    return `${r}.split(${sep}${a.length === 3 ? `, ${arg(2)}` : ''})`;
  }
  if (fn === 'substring' && (a.length === 2 || a.length === 3)) {
    const from = numLit(a[1]);
    const to = a.length === 3 ? numLit(a[2]) : Infinity;
    if (from === undefined || to === undefined || from < 0 || to < from) {
      ctx.warn('substring() with positions that are computed, negative or reversed: Bases uses slice(), which counts negative positions from the end and does not swap them');
    }
    return `${recv(0)}.slice(${a.slice(1).map((_, i) => arg(i + 1)).join(', ')})`;
  }
  if (fn === 'truncate' && (a.length === 2 || a.length === 3)) {
    const n = numLit(a[1]);
    const suffix = a.length === 3 ? (a[2].k === 'str' ? a[2].v : undefined) : '...';
    if (n === undefined || suffix === undefined) return ctx.fail('truncate() with a length or an ending that is not written in the query');
    const r = recv(0);
    const keep = n - suffix.length;
    return `if(${r}.length > ${keep}, ${r}.slice(0, ${Math.max(0, keep)}) + ${q(suffix)}, ${r})`;
  }
  if ((fn === 'padleft' || fn === 'padright') && (a.length === 2 || a.length === 3)) {
    const n = numLit(a[1]);
    const pad = a.length === 3 ? (a[2].k === 'str' ? a[2].v : undefined) : ' ';
    if (n === undefined || pad === undefined || !Number.isInteger(n)) return ctx.fail(`${e.fn}() with a length or a padding that is not written in the query`);
    const r = recv(0);
    if (n <= 0 || pad === '') return r;
    const fill = `${q(pad.repeat(Math.ceil(n / pad.length)).slice(0, n))}.slice(0, max(0, ${n} - ${r}.length))`;
    return `if(${r} == null, ${r}, ${fn === 'padleft' ? `${fill} + ${r}` : `${r} + ${fill}`})`;
  }
  if (fn === 'trunc' && a.length === 1) {
    const r = recv(0);
    return `if(${r} < 0, ${r}.ceil(), ${r}.floor())`;
  }
  if (fn === 'round' && a.length === 2) {
    ctx.warn('round() with decimals: for a negative number exactly halfway (-1.25), Dataview rounds away from zero (-1.3) and Bases toward it (-1.2)');
    return `${recv(0)}.round(${arg(1)})`;
  }
  if (fn === 'join' && a.length === 1) return `${recv(0)}.join(", ")`;
  if (fn === 'dateformat' && a.length === 2) {
    if (a[1].k !== 'str') return ctx.fail('dateformat() with a computed format');
    const fmt = luxonToMoment(a[1].v);
    if (fmt === undefined) return ctx.fail(`the date format "${a[1].v}" has no equivalent in Bases`);
    return `${recv(0)}.format(${q(fmt)})`;
  }
  if (fn === 'sort' && a.length === 1) return `${recv(0)}.sort()`;
  if (fn === 'unique' && a.length === 1) return `${recv(0)}.unique()`;
  if (fn === 'slice' && a.length >= 2) return `${recv(0)}.slice(${a.slice(1).map((_, i) => arg(i + 1)).join(', ')})`;
  if (fn === 'round' && a.length === 1) return `${recv(0)}.round()`;
  if (NO_EQUIVALENT[fn]) return ctx.fail(NO_EQUIVALENT[fn]);
  if (fn === 'lower' && a.length === 1) return `${recv(0)}.lower()`;
  const m = METHODS[fn];
  if (m && a.length === m[1] + 1) {
    return `${recv(0)}.${m[0]}(${a.slice(1).map((_, i) => arg(i + 1)).join(', ')})`;
  }
  if (UNSUPPORTED_FN.has(fn)) return ctx.fail(`the function ${e.fn}() has no equivalent in Bases`);
  return ctx.fail(`the function ${e.fn}() is not supported`);
}

/** Dataview's contains() is case-sensitive on text; Bases ignores case there (and on file names, paths and folders). */
function caseWarning(recvText: string, needle: Expr, ctx: Ctx): void {
  if (/^file\.(tags|links|backlinks)$/.test(recvText)) return;
  // no letter that changes with case: both find the same text
  if (needle.k === 'str' && needle.v.toLowerCase() === needle.v.toUpperCase()) return;
  if (needle.k === 'num' || needle.k === 'bool' || needle.k === 'link' || needle.k === 'null') return;
  ctx.warn('On text, Dataview contains() tells upper and lower case apart and Bases contains() does not ("Ann" also finds "ANNA")');
}

/** sum(), average(), min() and max() of one list, with Bases' list methods. */
function listMath(fn: string, method: string, list: Expr, ctx: Ctx, since?: string): string {
  if (readsRows(list, ctx)) return ctx.fail(`${fn}() over the rows of a group has no equivalent in Bases (it shows one row per note)`);
  if (since && !ctx.needs(since, `${fn}() of a list`)) return '?';
  const numbers = list.k === 'list' && list.items.every((x) => numLit(x) !== undefined);
  if (!numbers) {
    ctx.warn(`${fn}() of a list: Bases counts only the numbers in it (Dataview also adds up text and durations and compares dates), and gives nothing for a single value that is not a list`);
  }
  return `${wrap(list, emitExpr(list, ctx, false))}.${method}()`;
}

/** Dataview formats dates with Luxon tokens, Bases with Moment ones. Only the common ones are mapped. */
export function luxonToMoment(fmt: string): string | undefined {
  let out = '';
  for (let i = 0; i < fmt.length; ) {
    const c = fmt[i];
    if (c === "'") {
      const j = fmt.indexOf("'", i + 1);
      if (j < 0) return undefined;
      out += `[${fmt.slice(i + 1, j)}]`;
      i = j + 1;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (fmt[j] === c) j++;
      const run = fmt.slice(i, j);
      const map: Record<string, string> = {
        yyyy: 'YYYY', yy: 'YY', M: 'M', MM: 'MM', MMM: 'MMM', MMMM: 'MMMM', d: 'D', dd: 'DD', H: 'H', HH: 'HH',
        h: 'h', hh: 'hh', m: 'm', mm: 'mm', s: 's', ss: 'ss', a: 'a', ccc: 'ddd', cccc: 'dddd', EEE: 'ddd', EEEE: 'dddd',
      };
      if (!(run in map)) return undefined;
      out += map[run];
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

type Filter = string | { and: Filter[] } | { or: Filter[] } | { not: Filter[] };

function sourceFilter(s: Source, ctx: Ctx): Filter | undefined {
  switch (s.k) {
    case 'folder': {
      if (s.v === '') return undefined;
      if (/\.(md|canvas|base)$/i.test(s.v)) return `file.path == ${q(s.v)}`;
      return `file.inFolder(${q(s.v.replace(/\/+$/, ''))})`;
    }
    case 'tag': return `file.hasTag(${q(s.v)})`;
    case 'link': {
      const target = s.v.split('|')[0].split('#')[0];
      return target === '' ? 'file.hasLink(this.file)' : `file.hasLink(${q(target)})`;
    }
    case 'other': return ctx.fail(`the source ${s.v} has no equivalent in Bases`);
    case 'not': {
      const inner = sourceFilter(s.e, ctx);
      return inner === undefined ? ctx.fail('a negated source that matches every note') : { not: [inner] };
    }
    case 'and':
    case 'or': {
      const l = sourceFilter(s.l, ctx);
      const r = sourceFilter(s.r, ctx);
      // an empty folder ("") is every note: "x and all" is x, "x or all" is all
      if (l === undefined) return s.k === 'and' ? r : undefined;
      if (r === undefined) return s.k === 'and' ? l : undefined;
      return s.k === 'and' ? { and: [l, r] } : { or: [l, r] };
    }
  }
}

export interface ConvertOptions {
  /** Names of inline fields (key:: value) found in the vault, normalised with normalizeName. */
  inlineFields?: Set<string>;
  /** The Obsidian version in use (`apiVersion`): a function its Bases lacks is reported instead of written. Unset: the newest. */
  appVersion?: string;
}

export function convertQuery(src: string, opts: ConvertOptions = {}): Conversion {
  const base: Conversion = { type: 'UNKNOWN', status: 'none', reasons: [], warnings: [] };
  let query: Query;
  try {
    query = parseQuery(src);
  } catch (err) {
    if (err instanceof DqlError) return { ...base, reasons: [`could not read the query: ${err.message}`] };
    throw err;
  }
  base.type = query.type;
  if (query.type === 'TASK') return { ...base, reasons: ['TASK queries list tasks, and Bases lists notes'] };
  if (query.type === 'CALENDAR') return { ...base, reasons: ['CALENDAR queries have no equivalent in Bases'] };

  const ctx = new Ctx();
  if (opts.inlineFields) ctx.inline = opts.inlineFields;
  ctx.appVersion = opts.appVersion;
  if (query.limitFirst) ctx.warn('LIMIT comes before SORT or WHERE in the query: Dataview limits first, Bases always filters, sorts, then limits');
  if (query.flatten.length) ctx.fail(`FLATTEN ${query.flatten[0]} has no equivalent in Bases`);
  if (query.groupBy) {
    ctx.grouped = true;
  }

  if (query.groupBy) ctx.groupKey = emitExpr(query.groupBy.expr, ctx);

  const filters: Filter[] = [];
  if (query.from) {
    const f = sourceFilter(query.from, ctx);
    if (f !== undefined) filters.push(f);
  }
  for (const w of query.where) filters.push(emitExpr(w, ctx));

  const properties: Record<string, Yaml> = {};
  const setName = (prop: string, display: string | undefined) => {
    if (display) properties[prop] = { displayName: display };
  };
  const order: string[] = [];

  const columnProp = (e: Expr, text: string): string => {
    const f = flatten(e);
    if (f && f.root.toLowerCase() === 'file' && f.path.length === 1 && f.path[0] === 'link') return 'file.name';
    const s = emitExpr(e, ctx);
    if (/^note\.[A-Za-z_][A-Za-z0-9_]*$/.test(s) || /^file\.[a-z]+$/.test(s)) return s;
    const prop = ctx.addFormula('c', s);
    if (!properties[prop]) setName(prop, text);
    return prop;
  };

  if (!query.withoutId) {
    order.push('file.name');
    if (query.type === 'TABLE') setName('file.name', 'File');
  }
  const cols = query.columns.length || query.type === 'TABLE' || query.type === 'LIST' ? query.columns : [];
  for (const c of cols) {
    const prop = columnProp(c.expr, c.text);
    if (!order.includes(prop)) order.push(prop);
    if (c.alias) setName(prop, c.alias);
  }
  if (order.length === 0) order.push('file.name');

  const sortProp = (e: Expr): string => {
    const f = flatten(e);
    if (f && f.root.toLowerCase() === 'file' && f.path.length === 1 && f.path[0] === 'link') return 'file.name';
    const s = emitExpr(e, ctx);
    if (/^note\.[A-Za-z_][A-Za-z0-9_]*$/.test(s) || /^file\.[a-z]+$/.test(s)) return s;
    return ctx.addFormula('s', s);
  };

  const view: Record<string, Yaml> = { type: query.type === 'LIST' ? 'list' : 'table', name: query.type === 'LIST' ? 'List' : 'Table' };
  if (query.groupBy) {
    const prop = sortProp(query.groupBy.expr);
    view.groupBy = { property: prop, direction: 'ASC' };
  }
  if (query.limit) {
    if (query.limit.k === 'num') view.limit = query.limit.v;
    else ctx.fail('LIMIT with a computed value');
  }
  if (query.sort.length) {
    view.sort = query.sort.map((s) => ({ property: sortProp(s.expr), direction: s.dir }));
  }
  view.order = order;

  if (ctx.reasons.length) return { ...base, reasons: ctx.reasons };

  const doc: Record<string, Yaml> = {};
  if (filters.length) doc.filters = { and: filters as Yaml[] };
  if (Object.keys(ctx.formulas).length) doc.formulas = ctx.formulas;
  if (Object.keys(properties).length) doc.properties = properties;
  doc.views = [view];
  return {
    type: query.type,
    status: ctx.warnings.length ? 'partly' : 'full',
    yaml: dump(doc).join('\n'),
    reasons: [],
    warnings: ctx.warnings,
  };
}

