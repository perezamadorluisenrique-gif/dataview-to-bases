// Tokenizer and parser for the Dataview query language (DQL). Pure: no `obsidian` import.

export type Expr =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'dur'; v: string }
  | { k: 'tag'; v: string }
  | { k: 'link'; v: string }
  | { k: 'id'; name: string }
  | { k: 'member'; obj: Expr; name: string }
  | { k: 'index'; obj: Expr; idx: Expr }
  | { k: 'call'; fn: string; args: Expr[] }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'un'; op: string; e: Expr }
  | { k: 'list'; items: Expr[] };

export type Source =
  | { k: 'folder'; v: string }
  | { k: 'tag'; v: string }
  | { k: 'link'; v: string }
  | { k: 'other'; v: string }
  | { k: 'not'; e: Source }
  | { k: 'and' | 'or'; l: Source; r: Source };

export interface Column {
  expr: Expr;
  alias?: string;
  text: string;
}

export interface SortKey {
  expr: Expr;
  dir: 'ASC' | 'DESC';
}

export interface Query {
  type: 'TABLE' | 'LIST' | 'TASK' | 'CALENDAR';
  withoutId: boolean;
  columns: Column[];
  from?: Source;
  where: Expr[];
  sort: SortKey[];
  limit?: Expr;
  groupBy?: { expr: Expr; alias?: string };
  flatten: string[];
}

export class DqlError extends Error {}

type Tok = { t: 'num' | 'str' | 'id' | 'op' | 'tag' | 'link' | 'dur' | 'end'; v: string; s: number; e: number };

const DUR_UNITS = '(?:years?|yrs?|y|months?|mo|weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)';
const DUR_RE = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(${DUR_UNITS})(?![\\w-])`, 'i');
const UNIT_NAME: Record<string, string> = {
  y: 'year', yr: 'year', year: 'year', mo: 'month', month: 'month', w: 'week', wk: 'week', week: 'week',
  d: 'day', day: 'day', h: 'hour', hr: 'hour', hour: 'hour', m: 'minute', min: 'minute', minute: 'minute',
  s: 'second', sec: 'second', second: 'second',
};

export function normalizeDuration(n: string, unit: string): string {
  const name = UNIT_NAME[unit.toLowerCase().replace(/s$/, '')] ?? unit;
  return `${n} ${name}${Number(n) === 1 ? '' : 's'}`;
}

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) { v += src[j + 1]; j += 2; } else v += src[j++];
      }
      if (j >= n) throw new DqlError('Unterminated string');
      out.push({ t: 'str', v, s: i, e: j + 1 });
      i = j + 1;
      continue;
    }
    if (c === '[' && src[i + 1] === '[') {
      const j = src.indexOf(']]', i);
      if (j < 0) throw new DqlError('Unterminated link');
      out.push({ t: 'link', v: src.slice(i + 2, j), s: i, e: j + 2 });
      i = j + 2;
      continue;
    }
    if (c === '#' && /[\p{L}\p{N}_/-]/u.test(src[i + 1] ?? '')) {
      const m = /^#[\p{L}\p{N}_/-]+/u.exec(src.slice(i));
      if (m) { out.push({ t: 'tag', v: m[0].slice(1), s: i, e: i + m[0].length }); i += m[0].length; continue; }
    }
    if (/[0-9]/.test(c)) {
      const rest = src.slice(i);
      const d = DUR_RE.exec(rest);
      if (d) { out.push({ t: 'dur', v: normalizeDuration(d[1], d[2]), s: i, e: i + d[0].length }); i += d[0].length; continue; }
      const m = /^\d+(?:\.\d+)?/.exec(rest) as RegExpExecArray;
      out.push({ t: 'num', v: m[0], s: i, e: i + m[0].length });
      i += m[0].length;
      continue;
    }
    if (/[\p{L}_]/u.test(c)) {
      let j = i + 1;
      while (j < n) {
        if (/[\p{L}\p{N}_]/u.test(src[j])) j++;
        // a hyphen between letters belongs to the name (due-date); "a - b" does not
        else if (src[j] === '-' && /[\p{L}_]/u.test(src[j + 1] ?? '')) j++;
        else break;
      }
      out.push({ t: 'id', v: src.slice(i, j), s: i, e: j });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '!=', '==', '&&', '||', '=>'].includes(two)) {
      out.push({ t: 'op', v: two, s: i, e: i + 2 });
      i += 2;
      continue;
    }
    if ('+-*/%<>=!()[]{},.:'.includes(c)) {
      out.push({ t: 'op', v: c, s: i, e: i + 1 });
      i++;
      continue;
    }
    throw new DqlError(`Unexpected character "${c}"`);
  }
  out.push({ t: 'end', v: '', s: n, e: n });
  return out;
}

const CLAUSES = new Set(['from', 'where', 'sort', 'limit', 'group', 'flatten']);

class Parser {
  i = 0;
  readonly toks: Tok[];
  readonly src: string;
  constructor(toks: Tok[], src: string) {
    this.toks = toks;
    this.src = src;
  }
  get cur(): Tok { return this.toks[this.i]; }
  isKw(w: string, t: Tok = this.cur): boolean { return t.t === 'id' && t.v.toLowerCase() === w; }
  isOp(v: string): boolean { return this.cur.t === 'op' && this.cur.v === v; }
  atClause(): boolean { return this.cur.t === 'end' || (this.cur.t === 'id' && CLAUSES.has(this.cur.v.toLowerCase())); }
  expectOp(v: string): void {
    if (!this.isOp(v)) throw new DqlError(`Expected "${v}"`);
    this.i++;
  }

  // ---- expressions ----
  expr(): Expr { return this.or(); }
  or(): Expr {
    let l = this.and();
    while (this.isKw('or') || this.isOp('||')) { this.i++; l = { k: 'bin', op: '||', l, r: this.and() }; }
    return l;
  }
  and(): Expr {
    let l = this.cmp();
    while (this.isKw('and') || this.isOp('&&')) { this.i++; l = { k: 'bin', op: '&&', l, r: this.cmp() }; }
    return l;
  }
  cmp(): Expr {
    let l = this.add();
    while (this.cur.t === 'op' && ['=', '==', '!=', '<', '>', '<=', '>='].includes(this.cur.v)) {
      const op = this.cur.v === '=' ? '==' : this.cur.v;
      this.i++;
      l = { k: 'bin', op, l, r: this.add() };
    }
    return l;
  }
  add(): Expr {
    let l = this.mul();
    while (this.cur.t === 'op' && (this.cur.v === '+' || this.cur.v === '-')) {
      const op = this.cur.v;
      this.i++;
      l = { k: 'bin', op, l, r: this.mul() };
    }
    return l;
  }
  mul(): Expr {
    let l = this.unary();
    while (this.cur.t === 'op' && ['*', '/', '%'].includes(this.cur.v)) {
      const op = this.cur.v;
      this.i++;
      l = { k: 'bin', op, l, r: this.unary() };
    }
    return l;
  }
  unary(): Expr {
    if (this.isOp('!') || this.isOp('-')) {
      const op = this.cur.v;
      this.i++;
      return { k: 'un', op, e: this.unary() };
    }
    return this.postfix();
  }
  postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.isOp('.')) {
        this.i++;
        if (this.cur.t !== 'id') throw new DqlError('Expected a name after "."');
        e = { k: 'member', obj: e, name: this.cur.v };
        this.i++;
      } else if (this.isOp('[')) {
        this.i++;
        const idx = this.expr();
        this.expectOp(']');
        e = { k: 'index', obj: e, idx };
      } else break;
    }
    return e;
  }
  primary(): Expr {
    const t = this.cur;
    if (t.t === 'num') { this.i++; return { k: 'num', v: Number(t.v) }; }
    if (t.t === 'str') { this.i++; return { k: 'str', v: t.v }; }
    if (t.t === 'dur') { this.i++; return { k: 'dur', v: t.v }; }
    if (t.t === 'tag') { this.i++; return { k: 'tag', v: t.v }; }
    if (t.t === 'link') { this.i++; return { k: 'link', v: t.v }; }
    if (t.t === 'op' && t.v === '(') {
      this.i++;
      const e = this.expr();
      this.expectOp(')');
      return e;
    }
    if (t.t === 'op' && t.v === '[') {
      this.i++;
      const items: Expr[] = [];
      while (!this.isOp(']')) {
        items.push(this.expr());
        if (this.isOp(',')) this.i++;
        else break;
      }
      this.expectOp(']');
      return { k: 'list', items };
    }
    if (t.t === 'op' && t.v === '{') throw new DqlError('Object literals are not supported');
    if (t.t === 'id') {
      const low = t.v.toLowerCase();
      if (low === 'true' || low === 'false') { this.i++; return { k: 'bool', v: low === 'true' }; }
      if (low === 'null') { this.i++; return { k: 'null' }; }
      this.i++;
      if (this.isOp('(')) {
        this.i++;
        const args: Expr[] = [];
        while (!this.isOp(')')) {
          args.push(this.expr());
          if (this.isOp(',')) this.i++;
          else break;
        }
        this.expectOp(')');
        return { k: 'call', fn: t.v, args };
      }
      if (this.isOp('=>')) throw new DqlError('Lambda expressions are not supported');
      return { k: 'id', name: t.v };
    }
    throw new DqlError(t.t === 'end' ? 'The query ends too soon' : `Unexpected "${t.v}"`);
  }

  // ---- sources (FROM) ----
  srcOr(): Source {
    let l = this.srcAnd();
    while (this.isKw('or') || this.isOp('||')) { this.i++; l = { k: 'or', l, r: this.srcAnd() }; }
    return l;
  }
  srcAnd(): Source {
    let l = this.srcUnary();
    while (this.isKw('and') || this.isOp('&&')) { this.i++; l = { k: 'and', l, r: this.srcUnary() }; }
    return l;
  }
  srcUnary(): Source {
    if (this.isOp('-') || this.isOp('!')) { this.i++; return { k: 'not', e: this.srcUnary() }; }
    return this.srcAtom();
  }
  srcAtom(): Source {
    const t = this.cur;
    if (t.t === 'op' && t.v === '(') {
      this.i++;
      const e = this.srcOr();
      this.expectOp(')');
      return e;
    }
    if (t.t === 'str') { this.i++; return { k: 'folder', v: t.v }; }
    if (t.t === 'tag') { this.i++; return { k: 'tag', v: t.v }; }
    if (t.t === 'link') { this.i++; return { k: 'link', v: t.v }; }
    if (t.t === 'id' && this.toks[this.i + 1]?.v === '(') {
      const name = t.v;
      const start = t.s;
      let depth = 0;
      this.i++;
      do {
        if (this.cur.v === '(' && this.cur.t === 'op') depth++;
        if (this.cur.v === ')' && this.cur.t === 'op') depth--;
        this.i++;
      } while (depth > 0 && this.cur.t !== 'end');
      return { k: 'other', v: this.src.slice(start, this.toks[this.i - 1].e) || name };
    }
    throw new DqlError('Unsupported source in FROM');
  }

  columns(): Column[] {
    const cols: Column[] = [];
    while (!this.atClause()) {
      const s = this.cur.s;
      const expr = this.expr();
      const text = this.src.slice(s, this.toks[this.i - 1].e);
      let alias: string | undefined;
      if (this.isKw('as')) {
        this.i++;
        if (this.cur.t !== 'str' && this.cur.t !== 'id') throw new DqlError('Expected a name after AS');
        alias = this.cur.v;
        this.i++;
      }
      cols.push({ expr, alias, text });
      if (this.isOp(',')) this.i++;
      else break;
    }
    return cols;
  }

  query(): Query {
    const head = this.cur.v.toLowerCase();
    const q: Query = { type: 'TABLE', withoutId: false, columns: [], where: [], sort: [], flatten: [] };
    if (head === 'task' || head === 'calendar') {
      q.type = head === 'task' ? 'TASK' : 'CALENDAR';
      return q;
    }
    if (head !== 'table' && head !== 'list') throw new DqlError('A query starts with TABLE, LIST, TASK or CALENDAR');
    q.type = head === 'table' ? 'TABLE' : 'LIST';
    this.i++;
    if (this.isKw('without') && this.isKw('id', this.toks[this.i + 1])) { q.withoutId = true; this.i += 2; }
    q.columns = this.columns();
    if (q.type === 'LIST' && q.columns.length > 1) throw new DqlError('LIST takes a single expression');
    while (this.cur.t !== 'end') {
      const kw = this.cur.v.toLowerCase();
      if (!(this.cur.t === 'id' && CLAUSES.has(kw))) throw new DqlError(`Unexpected "${this.cur.v}"`);
      this.i++;
      if (kw === 'from') q.from = this.srcOr();
      else if (kw === 'where') q.where.push(this.expr());
      else if (kw === 'limit') q.limit = this.expr();
      else if (kw === 'sort') {
        for (;;) {
          const expr = this.expr();
          let dir: 'ASC' | 'DESC' = 'ASC';
          if (this.isKw('asc') || this.isKw('ascending')) this.i++;
          else if (this.isKw('desc') || this.isKw('descending')) { dir = 'DESC'; this.i++; }
          q.sort.push({ expr, dir });
          if (this.isOp(',')) this.i++;
          else break;
        }
      } else if (kw === 'group') {
        if (!this.isKw('by')) throw new DqlError('Expected BY after GROUP');
        this.i++;
        const expr = this.expr();
        let alias: string | undefined;
        if (this.isKw('as')) { this.i++; alias = this.cur.v; this.i++; }
        if (q.groupBy) throw new DqlError('Only one GROUP BY is supported');
        q.groupBy = { expr, alias };
      } else if (kw === 'flatten') {
        const s = this.cur.s;
        this.expr();
        q.flatten.push(this.src.slice(s, this.toks[this.i - 1].e));
        if (this.isKw('as')) { this.i += 2; }
      }
    }
    return q;
  }
}

export function parseQuery(src: string): Query {
  const toks = tokenize(src);
  if (toks.length === 1) throw new DqlError('The query is empty');
  const p = new Parser(toks, src);
  return p.query();
}
