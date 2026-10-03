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
  round: ['round', 1],
  floor: ['floor', 0],
  ceil: ['ceil', 0],
  abs: ['abs', 0],
  string: ['toString', 0],
};
const UNSUPPORTED_FN = new Set([
  'upper', 'sum', 'average', 'regextest', 'regexmatch', 'regexreplace', 'typeof', 'nonnull', 'extract', 'any', 'all',
  'none', 'map', 'filter', 'product', 'padleft', 'padright', 'substring', 'containsword', 'meta', 'elink', 'object',
  'minby', 'maxby', 'ldefault', 'display',
]);

class Ctx {
  reasons: string[] = [];
  warnings: string[] = [];
  formulas: Record<string, string> = {};
  groupKey?: string;
  grouped = false;
  inline = new Set<string>();

  fail(reason: string): string {
    if (!this.reasons.includes(reason)) this.reasons.push(reason);
    return '?';
  }
  warn(w: string): void {
    if (!this.warnings.includes(w)) this.warnings.push(w);
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
  return fieldFrom(f.root, f.path, ctx);
}

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
    case 'id': return ctx.fail(`unknown name ${e.name}`);
    case 'member': {
      const o = emitExpr(e.obj, ctx, false);
      return `${wrap(e.obj, o)}.${e.name}`;
    }
    case 'index': return `${wrap(e.obj, emitExpr(e.obj, ctx, false))}[${emitExpr(e.idx, ctx)}]`;
    case 'list': return `[${e.items.map((i) => emitExpr(i, ctx)).join(', ')}]`;
    case 'un': {
      const inner = emitExpr(e.e, ctx, false);
      const s = `${e.op}${e.e.k === 'bin' ? `(${inner})` : wrap(e.e, inner)}`;
      return top ? s : `(${s})`;
    }
    case 'bin': {
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
    if (recvText.startsWith('note.') || recvText.startsWith('note[')) {
      ctx.warn('On list properties, Dataview contains() also matches part of an item and Bases only matches whole items');
    }
    return `${recvText}.contains(${arg(1)})`;
  }
  if (fn === 'icontains' && a.length === 2) return `${recv(0)}.lower().contains(${wrap(a[1], emitExpr(a[1], ctx, false))}.lower())`;
  if (fn === 'econtains' && a.length === 2) return `${recv(0)}.contains(${arg(1)})`;
  if (fn === 'containsany' || fn === 'containsall') {
    if (a.length >= 2) return `${recv(0)}.${fn === 'containsany' ? 'containsAny' : 'containsAll'}(${a.slice(1).map((_, i) => arg(i + 1)).join(', ')})`;
  }
  if (fn === 'length' && a.length === 1) return `${recv(0)}.length`;
  if (fn === 'default' && a.length === 2) {
    const x = emitExpr(a[0], ctx);
    // Dataview replaces only a missing value; `if(x, x, y)` would also replace 0, false and ""
    return `if(${x} == null, ${arg(1)}, ${x})`;
  }
  if (fn === 'choice' && a.length === 3) return `if(${arg(0)}, ${arg(1)}, ${arg(2)})`;
  if (fn === 'number' && a.length === 1) return `number(${arg(0)})`;
  if (fn === 'link' && a.length >= 1 && a.length <= 2) return `link(${a.map((_, i) => arg(i)).join(', ')})`;
  if (fn === 'min' || fn === 'max') {
    if (a.length >= 2) return `${fn}(${a.map((_, i) => arg(i)).join(', ')})`;
  }
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
  if (fn === 'lower' && a.length === 1) return `${recv(0)}.lower()`;
  const m = METHODS[fn];
  if (m && a.length === m[1] + 1) {
    return `${recv(0)}.${m[0]}(${a.slice(1).map((_, i) => arg(i + 1)).join(', ')})`;
  }
  if (UNSUPPORTED_FN.has(fn)) return ctx.fail(`the function ${e.fn}() has no equivalent in Bases`);
  return ctx.fail(`the function ${e.fn}() is not supported`);
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

