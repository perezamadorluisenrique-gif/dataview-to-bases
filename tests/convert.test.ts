import test from 'node:test';
import assert from 'node:assert/strict';

import { convertQuery, luxonToMoment } from '../src/convert.ts';
import { parseQuery, tokenize } from '../src/dql.ts';

const yaml = (q: string) => {
  const c = convertQuery(q);
  assert.notEqual(c.status, 'none', c.reasons.join('; '));
  return c.yaml;
};

test('tokenizer keeps hyphenated names whole and reads durations', () => {
  const t = tokenize('due-date - a < 7 days');
  assert.deepEqual(t.map((x) => `${x.t}:${x.v}`), ['id:due-date', 'op:-', 'id:a', 'op:<', 'dur:7 days', 'end:']);
});

test('parser reads the clauses of a full query', () => {
  const q = parseQuery('TABLE WITHOUT ID file.link AS "N", x FROM #a AND "B" WHERE x > 1 SORT x DESC, y LIMIT 5');
  assert.equal(q.type, 'TABLE');
  assert.equal(q.withoutId, true);
  assert.equal(q.columns.length, 2);
  assert.equal(q.columns[0].alias, 'N');
  assert.equal(q.sort.length, 2);
  assert.equal(q.sort[0].dir, 'DESC');
  assert.equal(q.where.length, 1);
  assert.ok(q.limit);
});

test('table with aliases, where, sort and limit', () => {
  assert.equal(
    yaml('TABLE file.mtime AS "Modified", rating FROM "Books" WHERE rating >= 4 AND contains(file.tags, "#fiction") SORT rating DESC, file.name LIMIT 10'),
    [
      'filters:',
      '  and:',
      "    - 'file.inFolder(\"Books\")'",
      "    - 'note.rating >= 4 && file.hasTag(\"fiction\")'",
      'properties:',
      '  file.name:',
      '    displayName: File',
      '  file.mtime:',
      '    displayName: Modified',
      'views:',
      '  - type: table',
      '    name: Table',
      '    limit: 10',
      '    sort:',
      '      - property: note.rating',
      '        direction: DESC',
      '      - property: file.basename',
      '        direction: ASC',
      '    order:',
      '      - file.name',
      '      - file.mtime',
      '      - note.rating',
    ].join('\n'),
  );
});

test('list with tag and negated folder', () => {
  assert.equal(
    yaml('LIST FROM #project and -"Archive"'),
    [
      'filters:',
      '  and:',
      '    - and:',
      "        - 'file.hasTag(\"project\")'",
      '        - not:',
      "            - 'file.inFolder(\"Archive\")'",
      'views:',
      '  - type: list',
      '    name: List',
      '    order:',
      '      - file.name',
    ].join('\n'),
  );
});

test('WITHOUT ID drops the file column; hyphenated fields become formulas', () => {
  const y = yaml('TABLE WITHOUT ID file.link AS "Note", due-date FROM [[]] WHERE due-date < date(today) + dur(7 days) SORT due-date');
  assert.match(y, /file\.hasLink\(this\.file\)/);
  assert.match(y, /note\["due-date"\] < today\(\) \+ "7 days"/);
  assert.match(y, /c1: 'note\["due-date"\]'/);
  assert.match(y, /order:\n {6}- file\.name\n {6}- formula\.c1/);
  assert.doesNotMatch(y, /displayName: File\b/);
});

test('FROM with links, folders, files, or/and nesting', () => {
  assert.match(yaml('LIST FROM [[Project X]]'), /file\.hasLink\("Project X"\)/);
  assert.match(yaml('LIST FROM [[Note#Heading|alias]]'), /file\.hasLink\("Note"\)/);
  assert.match(yaml('LIST FROM "Inbox/todo.md"'), /file\.path == "Inbox\/todo\.md"/);
  assert.doesNotMatch(yaml('LIST FROM ""'), /filters/);
  const y = yaml('LIST FROM (#a or #b) and "Notes"');
  assert.match(y, /- or:\n {12}- 'file\.hasTag\("a"\)'\n {12}- 'file\.hasTag\("b"\)'/);
});

test('functions map to Bases methods', () => {
  const y = yaml('TABLE default(status, "none") AS S, length(file.outlinks) AS L, lower(title) AS T, choice(done, "y", "n") AS C FROM #x WHERE icontains(title, "a") AND !done');
  assert.match(y, /if\(note\.status, note\.status, "none"\)/);
  assert.match(y, /file\.links\.length/);
  assert.match(y, /note\.title\.lower\(\)/);
  assert.match(y, /if\(note\.done, "y", "n"\)/);
  assert.match(y, /note\.title\.lower\(\)\.contains\("a"\.lower\(\)\) && !note\.done/);
});

test('dates: today, now, durations, dateformat', () => {
  assert.match(yaml('LIST FROM #x WHERE file.mtime >= date(today) - dur(1 week)'), /file\.mtime >= today\(\) - "1 week"/);
  assert.match(yaml('LIST FROM #x WHERE due < date(now)'), /note\.due < now\(\)/);
  assert.match(yaml('LIST FROM #x WHERE due = date(tomorrow)'), /note\.due == today\(\) \+ "1 day"/);
  assert.match(yaml('TABLE dateformat(file.ctime, "yyyy-MM-dd") AS D FROM #x'), /file\.ctime\.format\("YYYY-MM-DD"\)/);
  assert.equal(luxonToMoment("dd 'of' MMMM"), 'DD [of] MMMM');
  assert.equal(luxonToMoment('ZZZ'), undefined);
});

test('comparison with null becomes a truthiness test', () => {
  assert.match(yaml('LIST FROM #x WHERE status = null'), /!note\.status\.isTruthy\(\)/);
  assert.match(yaml('LIST FROM #x WHERE status != null'), /note\.status\.isTruthy\(\)/);
});

test('operator precedence keeps needed parentheses only', () => {
  assert.match(yaml('LIST FROM #x WHERE (a or b) and c'), /\(note\.a \|\| note\.b\) && note\.c/);
  assert.match(yaml('LIST FROM #x WHERE a and b or c'), /note\.a && note\.b \|\| note\.c/);
  assert.match(yaml('LIST FROM #x WHERE a - (b - c) > 0'), /note\.a - \(note\.b - note\.c\) > 0/);
});

test('GROUP BY converts with a warning', () => {
  const c = convertQuery('TABLE rows.file.link AS Files, key FROM #x GROUP BY status');
  assert.equal(c.status, 'partly');
  assert.match(c.warnings[0], /GROUP BY/);
  assert.match(c.yaml ?? '', /groupBy:\n {6}property: note\.status/);
});

test('this.file maps and this.field warns', () => {
  assert.equal(convertQuery('LIST FROM #x WHERE file.folder = this.file.folder').status, 'full');
  assert.equal(convertQuery('LIST FROM #x WHERE project = this.project').status, 'partly');
});

test('file fields: mapped and unsupported', () => {
  const y = yaml('TABLE file.size, file.cday, file.inlinks FROM #x');
  assert.match(y, /c1: 'file\.ctime\.date\(\)'/);
  assert.match(y, /- file\.size\n {6}- formula\.c1\n {6}- file\.backlinks/);
  const c = convertQuery('TABLE file.tasks FROM #x');
  assert.equal(c.status, 'none');
  assert.match(c.reasons[0], /file\.tasks/);
});

// every unsupported construct -> its reason
const NOT_CONVERTIBLE: Array<[string, RegExp]> = [
  ['TASK FROM #x', /TASK/],
  ['CALENDAR file.cday', /CALENDAR/],
  ['TABLE a FROM #x FLATTEN tags', /FLATTEN/],
  ['TABLE upper(a) FROM #x', /upper\(\)/],
  ['TABLE sum(rows.a) FROM #x GROUP BY b', /sum\(\)/],
  ['TABLE regexmatch("a", b) FROM #x', /regexmatch/],
  ['LIST FROM outgoing([[A]])', /outgoing/],
  ['LIST FROM csv("a.csv")', /csv/],
  ['TABLE length(rows) FROM #x GROUP BY b', /rows/],
  ['LIST FROM #x LIMIT n', /LIMIT/],
  ['LIST FROM #x WHERE date(sow) < due', /sow/],
  ['LIST FROM #x WHERE contains(file.tags, tagvar)', /file\.tags/],
  ['TABLE foo(a) FROM #x', /foo\(\)/],
  ['TABLE a FROM', /could not read/],
  ['SELECT * FROM x', /starts with/],
  ['TABLE map(a, (x) => x) FROM #x', /could not read/],
];
for (const [q, re] of NOT_CONVERTIBLE) {
  test(`not convertible: ${q}`, () => {
    const c = convertQuery(q);
    assert.equal(c.status, 'none');
    assert.equal(c.yaml, undefined);
    assert.match(c.reasons.join('; '), re);
  });
}
