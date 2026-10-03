import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReport, countInline, findBlocks, planEdits, scanText } from '../src/scan.ts';

const NOTE = [
  '# Title',
  '',
  '```dataview',
  'LIST FROM #a',
  '```',
  'text',
  '```js',
  '```dataview',
  '```',
  '> [!note]',
  '> ```dataview',
  '> TASK FROM #b',
  '> ```',
  '```dataviewjs',
  'dv.list([])',
  '```',
  'Inline `= this.file.name` and `$= 1` here.',
].join('\n');

test('finds dataview blocks, skipping look-alikes inside other fences, keeping the prefix', () => {
  const b = findBlocks(NOTE);
  assert.deepEqual(b.map((x) => [x.lang, x.start, x.end, x.prefix]), [
    ['dataview', 2, 4, ''],
    ['dataview', 10, 12, '> '],
    ['dataviewjs', 13, 15, ''],
  ]);
  assert.equal(b[0].body, 'LIST FROM #a');
  assert.equal(b[1].body, 'TASK FROM #b');
});

test('counts inline queries outside fences only', () => {
  assert.equal(countInline(NOTE), 2);
  assert.equal(countInline('```\n`= x`\n```'), 0);
});

test('plans replacements for convertible blocks and leaves the rest', () => {
  const edits = planEdits(NOTE, true);
  assert.equal(edits.length, 3);
  assert.equal(edits[0].conversion.status, 'full');
  assert.deepEqual(edits[0].lines, [
    '```base',
    'filters:',
    '  and:',
    "    - 'file.hasTag(\"a\")'",
    'views:',
    '  - type: list',
    '    name: List',
    '    order:',
    '      - file.name',
    '```',
    '%%',
    '```dataview-original',
    'LIST FROM #a',
    '```',
    '%%',
  ]);
  assert.equal(edits[1].lines, undefined);
  assert.equal(edits[2].lines, undefined);
  assert.match(edits[2].conversion.reasons[0], /JavaScript/);
});

test('keepOriginal off drops the comment; quoted blocks keep their prefix', () => {
  const text = '> ```dataview\n> LIST FROM #a\n> ```';
  const [e] = planEdits(text, false);
  assert.ok(e.lines);
  assert.ok(e.lines.every((l) => l.startsWith('> ')));
  assert.equal(e.lines.at(-1), '> ```');
  assert.ok(!e.lines.join('\n').includes('%%'));
});

test('a %% inside the original cannot end the comment early', () => {
  const [e] = planEdits('```dataview\nLIST FROM #a WHERE x = "%%"\n```', true);
  assert.ok(e.lines);
  assert.equal(e.lines.filter((l) => l === '%%').length, 2);
});

test('scanText ignores notes without queries and builds the report', () => {
  assert.equal(scanText('a.md', 'hello'), undefined);
  assert.equal(scanText('a.md', 'about dataview, no queries'), undefined);
  const s = scanText('n.md', NOTE);
  assert.ok(s);
  assert.equal(s.entries.length, 3);
  assert.equal(s.inline, 2);
  const r = buildReport([s], 10, '2026-10-03');
  assert.match(r, /Scanned 10 notes on 2026-10-03/);
  assert.match(r, /3 Dataview queries in 1 notes/);
  assert.match(r, /1 convertible, 0 partly.*2 not convertible/);
  assert.match(r, /\| \[\[n\.md\]\] \| 3 \| LIST \| convertible \| {2}\|/);
  assert.match(r, /\| \[\[n\.md\]\] \| 11 \| TASK \| not convertible \| TASK queries/);
  assert.match(r, /2 inline `=` queries/);
  assert.match(buildReport([], 4, 'x'), /No Dataview queries found/);
});
