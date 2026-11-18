// One fixture per Dataview function: the query in, the whole base block out, and whether it is exact.
import test from 'node:test';
import assert from 'node:assert/strict';

import { compareVersions, convertQuery, regexLiteral } from '../src/convert.ts';
import { parseQuery, tokenize } from '../src/dql.ts';
import type { Status } from '../src/convert.ts';

/** The block for `LIST WHERE <expr>`. */
const listBlock = (filter: string) =>
  ['filters:', '  and:', `    - ${filter}`, 'views:', '  - type: list', '    name: List', '    order:', '      - file.name'].join('\n');

/** The block for `TABLE WITHOUT ID <expr> AS "F"`. */
const columnBlock = (formula: string) =>
  [
    'formulas:',
    `  c1: ${formula}`,
    'properties:',
    '  formula.c1:',
    '    displayName: F',
    'views:',
    '  - type: table',
    '    name: Table',
    '    order:',
    '      - formula.c1',
  ].join('\n');

interface Fixture {
  fn: string;
  dql: string;
  /** The YAML scalar of the filter (for LIST WHERE) or of the formula (for TABLE WITHOUT ID … AS "F"). */
  out: string;
  status: Status;
  /** Part of the warning that makes it "partly". */
  warning?: RegExp;
}

const FIXTURES: Fixture[] = [
  // ---- text ----
  { fn: 'regextest', dql: 'LIST WHERE regextest("^Ch(ap)?", title)', out: "'/^Ch(ap)?/.matches(note.title)'", status: 'full' },
  { fn: 'regexmatch', dql: 'LIST WHERE regexmatch("\\d{4}", year)', out: "'/^\\d{4}$/.matches(note.year)'", status: 'full' },
  { fn: 'regexmatch (anchored)', dql: 'LIST WHERE regexmatch("^a|b", code)', out: "'/^a|b/.matches(note.code)'", status: 'full' },
  { fn: 'regexreplace', dql: 'TABLE WITHOUT ID regexreplace(path, "a/(\\w+)", "$1") AS "F"', out: "'note.path.replace(/a\\/(\\w+)/g, \"$1\")'", status: 'full' },
  { fn: 'replace', dql: 'TABLE WITHOUT ID replace(title, "-", " ") AS "F"', out: "'note.title.replace(\"-\", \" \")'", status: 'full' },
  { fn: 'lower', dql: 'TABLE WITHOUT ID lower(title) AS "F"', out: "'note.title.lower()'", status: 'full' },
  { fn: 'startswith', dql: 'LIST WHERE startswith(file.name, "2026")', out: "'file.basename.startsWith(\"2026\")'", status: 'full' },
  { fn: 'endswith', dql: 'LIST WHERE endswith(file.name, "draft")', out: "'file.basename.endsWith(\"draft\")'", status: 'full' },
  { fn: 'split (text)', dql: 'TABLE WITHOUT ID split(authors, ", ") AS "F"', out: "'note.authors.split(\", \")'", status: 'full' },
  { fn: 'split (pattern)', dql: 'TABLE WITHOUT ID split(authors, "\\s*;\\s*", 2) AS "F"', out: "'note.authors.split(/\\s*;\\s*/, 2)'", status: 'full' },
  { fn: 'split (computed)', dql: 'TABLE WITHOUT ID split(authors, sep) AS "F"', out: "'note.authors.split(note.sep)'", status: 'partly', warning: /regular expression, Bases as plain text/ },
  { fn: 'join', dql: 'TABLE WITHOUT ID join(authors, " & ") AS "F"', out: "'note.authors.join(\" & \")'", status: 'full' },
  { fn: 'join (default)', dql: 'TABLE WITHOUT ID join(authors) AS "F"', out: "'note.authors.join(\", \")'", status: 'full' },
  { fn: 'substring', dql: 'TABLE WITHOUT ID substring(title, 0, 3) AS "F"', out: "'note.title.slice(0, 3)'", status: 'full' },
  { fn: 'substring (negative)', dql: 'TABLE WITHOUT ID substring(title, -2) AS "F"', out: "'note.title.slice(-2)'", status: 'partly', warning: /slice\(\)/ },
  { fn: 'truncate', dql: 'TABLE WITHOUT ID truncate(title, 10) AS "F"', out: "'if(note.title.length > 7, note.title.slice(0, 7) + \"...\", note.title)'", status: 'full' },
  { fn: 'truncate (ending)', dql: 'TABLE WITHOUT ID truncate(title, 6, "…") AS "F"', out: "'if(note.title.length > 5, note.title.slice(0, 5) + \"…\", note.title)'", status: 'full' },
  { fn: 'padleft', dql: 'TABLE WITHOUT ID padleft(code, 5, "0") AS "F"', out: "'if(note.code == null, note.code, \"00000\".slice(0, max(0, 5 - note.code.length)) + note.code)'", status: 'full' },
  { fn: 'padright', dql: 'TABLE WITHOUT ID padright(code, 4) AS "F"', out: "'if(note.code == null, note.code, note.code + \"    \".slice(0, max(0, 4 - note.code.length)))'", status: 'full' },
  { fn: 'padleft (long padding)', dql: 'TABLE WITHOUT ID padleft(code, 5, "ab") AS "F"', out: "'if(note.code == null, note.code, \"ababa\".slice(0, max(0, 5 - note.code.length)) + note.code)'", status: 'full' },
  { fn: 'length (property)', dql: 'LIST WHERE length(authors) < 2', out: "'if(note.authors == null, 0, note.authors.length) < 2'", status: 'full' },
  { fn: 'length (file field)', dql: 'TABLE WITHOUT ID length(file.name) AS "F"', out: 'file.basename.length', status: 'full' },
  { fn: 'contains (text field)', dql: 'LIST WHERE contains(file.name, "Draft")', out: "'file.basename.contains(\"Draft\")'", status: 'partly', warning: /upper and lower case/ },
  { fn: 'contains (no letters)', dql: 'LIST WHERE contains(file.name, "2026")', out: "'file.basename.contains(\"2026\")'", status: 'full' },
  { fn: 'icontains', dql: 'LIST WHERE icontains(file.name, "Draft")', out: "'file.basename.lower().contains(\"Draft\".lower())'", status: 'full' },
  { fn: 'string', dql: 'TABLE WITHOUT ID string(rating) AS "F"', out: "'note.rating.toString()'", status: 'full' },
  // ---- numbers ----
  { fn: 'round', dql: 'TABLE WITHOUT ID round(score) AS "F"', out: "'note.score.round()'", status: 'full' },
  { fn: 'round (decimals)', dql: 'TABLE WITHOUT ID round(score, 2) AS "F"', out: "'note.score.round(2)'", status: 'partly', warning: /halfway/ },
  { fn: 'trunc', dql: 'TABLE WITHOUT ID trunc(score) AS "F"', out: "'if(note.score < 0, note.score.ceil(), note.score.floor())'", status: 'full' },
  { fn: 'floor', dql: 'TABLE WITHOUT ID floor(score) AS "F"', out: "'note.score.floor()'", status: 'full' },
  { fn: 'ceil', dql: 'TABLE WITHOUT ID ceil(score) AS "F"', out: "'note.score.ceil()'", status: 'full' },
  { fn: 'abs', dql: 'TABLE WITHOUT ID abs(score) AS "F"', out: "'note.score.abs()'", status: 'full' },
  { fn: 'number', dql: 'TABLE WITHOUT ID number(score) AS "F"', out: "'number(note.score)'", status: 'full' },
  { fn: 'min (values)', dql: 'TABLE WITHOUT ID min(3, 1, 2) AS "F"', out: "'min(3, 1, 2)'", status: 'full' },
  { fn: 'max (property)', dql: 'TABLE WITHOUT ID max(score, 0) AS "F"', out: "'max(note.score, 0)'", status: 'partly', warning: /one of the values is missing/ },
  // ---- lists ----
  { fn: 'sum', dql: 'TABLE WITHOUT ID sum(hours) AS "F"', out: "'note.hours.sum()'", status: 'partly', warning: /only the numbers/ },
  { fn: 'sum (numbers)', dql: 'TABLE WITHOUT ID sum([1, 2, 3]) AS "F"', out: "'[1, 2, 3].sum()'", status: 'full' },
  { fn: 'average', dql: 'TABLE WITHOUT ID average(hours) AS "F"', out: "'note.hours.mean()'", status: 'partly', warning: /average\(\) of a list/ },
  { fn: 'min (list)', dql: 'TABLE WITHOUT ID min(hours) AS "F"', out: "'note.hours.min()'", status: 'partly', warning: /min\(\) of a list/ },
  { fn: 'max (list)', dql: 'TABLE WITHOUT ID max([4, -1]) AS "F"', out: "'[4, -1].max()'", status: 'full' },
  { fn: 'map', dql: 'TABLE WITHOUT ID map(hours, (h) => h * 60) AS "F"', out: "'note.hours.map(value * 60)'", status: 'full' },
  { fn: 'map (functions inside)', dql: 'TABLE WITHOUT ID map(authors, (a) => lower(a)) AS "F"', out: "'note.authors.map(value.lower())'", status: 'full' },
  { fn: 'filter', dql: 'TABLE WITHOUT ID filter(hours, (h) => h > 2) AS "F"', out: "'note.hours.filter(value > 2)'", status: 'full' },
  { fn: 'any', dql: 'LIST WHERE any(hours, (h) => h > 8)', out: "'note.hours.filter(value > 8).length > 0'", status: 'partly', warning: /without the list/ },
  { fn: 'any (list)', dql: 'LIST WHERE any(flags)', out: "'note.flags.filter(value).length > 0'", status: 'partly', warning: /without the list/ },
  { fn: 'all', dql: 'LIST WHERE all(hours, (h) => h >= 1)', out: "'note.hours.filter(value >= 1).length == note.hours.length'", status: 'partly', warning: /without the list/ },
  { fn: 'none', dql: 'LIST WHERE none(authors, (a) => startswith(a, "X"))', out: "'note.authors.filter(value.startsWith(\"X\")).length == 0'", status: 'partly', warning: /without the list/ },
  { fn: 'nonnull', dql: 'TABLE WITHOUT ID nonnull(authors) AS "F"', out: "'note.authors.filter(value != null)'", status: 'full' },
  { fn: 'contains (list)', dql: 'LIST WHERE contains(authors, "Smith")', out: "'note.authors.contains(\"Smith\")'", status: 'partly', warning: /whole items/ },
  { fn: 'reverse', dql: 'TABLE WITHOUT ID reverse(authors) AS "F"', out: "'note.authors.reverse()'", status: 'full' },
  { fn: 'sort', dql: 'TABLE WITHOUT ID sort(authors) AS "F"', out: "'note.authors.sort()'", status: 'full' },
  { fn: 'unique', dql: 'TABLE WITHOUT ID unique(authors) AS "F"', out: "'note.authors.unique()'", status: 'full' },
  { fn: 'flat', dql: 'TABLE WITHOUT ID flat(authors) AS "F"', out: "'note.authors.flat()'", status: 'full' },
  { fn: 'slice', dql: 'TABLE WITHOUT ID slice(authors, 0, 2) AS "F"', out: "'note.authors.slice(0, 2)'", status: 'full' },
  // ---- types, choices, dates ----
  { fn: 'typeof', dql: 'LIST WHERE typeof(due) = "date"', out: "'note.due.isType(\"date\")'", status: 'full' },
  { fn: 'typeof (array)', dql: 'LIST WHERE typeof(tags) != "array"', out: "'!note.tags.isType(\"list\")'", status: 'full' },
  { fn: 'typeof (string)', dql: 'LIST WHERE "string" = typeof(x)', out: "'(note.x.isType(\"string\") && !note.x.isType(\"link\"))'", status: 'full' },
  { fn: 'choice', dql: 'TABLE WITHOUT ID choice(done, "yes", "no") AS "F"', out: "'if(note.done, \"yes\", \"no\")'", status: 'full' },
  { fn: 'default', dql: 'TABLE WITHOUT ID default(status, "new") AS "F"', out: "'if(note.status == null, \"new\", note.status)'", status: 'full' },
  { fn: 'striptime', dql: 'TABLE WITHOUT ID striptime(file.ctime) AS "F"', out: "'file.ctime.date()'", status: 'full' },
  { fn: 'dateformat', dql: 'TABLE WITHOUT ID dateformat(due, "yyyy-MM-dd") AS "F"', out: "'note.due.format(\"YYYY-MM-DD\")'", status: 'full' },
  { fn: 'date(today) and dur()', dql: 'LIST WHERE due <= date(today) + dur(1 week)', out: "'note.due <= today() + \"1 week\"'", status: 'full' },
  { fn: 'date(now)', dql: 'LIST WHERE file.mtime > date(now) - dur(2 hours)', out: "'file.mtime > now() - \"2 hours\"'", status: 'full' },
  // ---- negation: Bases gives !null = null, Dataview lists the note ----
  { fn: '! (property)', dql: 'LIST WHERE !done', out: "'!note.done.isTruthy()'", status: 'full' },
  { fn: '! (function)', dql: 'LIST WHERE !regextest("x", title)', out: "'!/x/.matches(note.title).isTruthy()'", status: 'full' },
  { fn: '! (equality)', dql: 'LIST WHERE !(status = "done")', out: "'!(note.status == \"done\")'", status: 'full' },
];

for (const f of FIXTURES) {
  test(`function fixture: ${f.fn}`, () => {
    const c = convertQuery(f.dql);
    assert.equal(c.reasons.join('; '), '');
    assert.equal(c.yaml, f.dql.startsWith('LIST') ? listBlock(f.out) : columnBlock(f.out));
    assert.equal(c.status, f.status, c.warnings.join('; '));
    if (f.warning) assert.match(c.warnings.join('\n'), f.warning);
  });
}

const NONE: [string, RegExp][] = [
  ['LIST WHERE upper(title) = "A"', /no upper case/],
  ['LIST WHERE product(xs) > 1', /product\(\)/],
  ['TABLE typeof(x) FROM #a', /compared with a type name/],
  ['LIST WHERE typeof(x) = "widget"', /"widget"/],
  ['TABLE map(xs, (a, b) => a) FROM #a', /lambda of 2 names/],
  ['TABLE map(xs, f) FROM #a', /without a lambda/],
  ['TABLE map(xs, (a) => map(a, (b) => a + b)) FROM #a', /outer lambda/],
  ['TABLE map(xs, (a) => a.file.name) FROM #a', /field of a list item/],
  ['TABLE (x) => x FROM #a', /outside map/],
  ['TABLE truncate(t, n) FROM #a', /truncate\(\)/],
  ['TABLE padleft(t, n) FROM #a', /padleft\(\)/],
  ['TABLE regexreplace(t, p, "") FROM #a', /pattern that is not written/],
  ['TABLE sum(rows.h) FROM #a GROUP BY b', /rows of a group/],
  ['TABLE average(rows.h) FROM #a GROUP BY b', /rows of a group/],
  ['TABLE length(rows.h) FROM #a GROUP BY b', /rows of a group/],
  ['TABLE map(rows.h, (x) => x) FROM #a GROUP BY b', /rows of a group/],
  ['TABLE any(rows.h) FROM #a GROUP BY b', /rows of a group/],
  ['TABLE firstvalue(xs) FROM #a', /firstvalue\(\)/],
];
for (const [q, re] of NONE) {
  test(`function not convertible: ${q}`, () => {
    const c = convertQuery(q);
    assert.equal(c.status, 'none');
    assert.match(c.reasons.join('; '), re);
  });
}

test('list sum(), min() and max() need Obsidian 1.11; mean() and the rest work on 1.10', () => {
  const old = convertQuery('TABLE sum(h), max(h) FROM #a', { appVersion: '1.10.6' });
  assert.equal(old.status, 'none');
  assert.deepEqual(old.reasons, ['sum() of a list needs Obsidian 1.11 or newer in Bases', 'max() of a list needs Obsidian 1.11 or newer in Bases']);
  assert.equal(convertQuery('TABLE sum(h) FROM #a', { appVersion: '1.11.4' }).status, 'partly');
  assert.equal(convertQuery('TABLE average(h), map(h, (x) => x + 1), padleft(c, 3) FROM #a', { appVersion: '1.10.3' }).status, 'partly');
  assert.equal(convertQuery('TABLE max(a, 1) FROM #a', { appVersion: '1.10.3' }).reasons.length, 0);
});

test('compareVersions', () => {
  assert.equal(compareVersions('1.10.6', '1.11.4'), -1);
  assert.equal(compareVersions('1.11.4', '1.11.4'), 0);
  assert.equal(compareVersions('1.12', '1.11.4'), 1);
});

test('regexLiteral escapes slashes and line breaks and refuses broken patterns', () => {
  assert.equal(regexLiteral('a/b'), '/a\\/b/');
  assert.equal(regexLiteral('a\\/b'), '/a\\/b/');
  assert.equal(regexLiteral('[/]', 'g'), '/[\\/]/g');
  assert.equal(regexLiteral('a\nb'), '/a\\nb/');
  assert.equal(regexLiteral(''), '/(?:)/');
  assert.equal(regexLiteral('a('), undefined);
});

test('strings keep backslashes the way Dataview does', () => {
  const v = (src: string) => tokenize(src)[0].v;
  assert.equal(v('"\\d+"'), '\\d+');
  assert.equal(v('"a\\"b"'), 'a"b');
  assert.equal(v('"a\\\\b"'), 'a\\b');
});

test('lambdas parse with zero, one or more names, and parentheses stay parentheses', () => {
  const q = parseQuery('TABLE map(xs, (x) => x + 1), filter(xs, (a, b) => a), (1 + 2) * 3 FROM #a');
  assert.deepEqual(q.columns[0].expr, {
    k: 'call',
    fn: 'map',
    args: [{ k: 'id', name: 'xs' }, { k: 'lambda', params: ['x'], body: { k: 'bin', op: '+', l: { k: 'id', name: 'x' }, r: { k: 'num', v: 1 } } }],
  });
  assert.deepEqual((q.columns[1].expr as { args: { params?: string[] }[] }).args[1].params, ['a', 'b']);
  assert.equal(q.columns[2].expr.k, 'bin');
  assert.equal(parseQuery('TABLE map(xs, () => 1) FROM #a').columns.length, 1);
});

test('sort(list) as the first column is a function, SORT after the columns a clause', () => {
  const q = parseQuery('TABLE sort(xs) AS "S", x SORT x DESC');
  assert.equal(q.columns.length, 2);
  assert.equal(q.sort.length, 1);
});

test('a comparison inside a lambda does not raise the empty-value warning', () => {
  assert.deepEqual(convertQuery('LIST WHERE any([1, 9], (h) => h > 8)').warnings, []);
});

test('a lambda item named like a property shadows it, as in Dataview', () => {
  const c = convertQuery('TABLE WITHOUT ID filter(tags, (rating) => rating != "x") AS "F" FROM #a');
  assert.match(c.yaml ?? '', /note\.tags\.filter\(value != "x"\)/);
});
