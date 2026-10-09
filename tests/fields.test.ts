import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFields, planFields, propertyName, removableLines, removeFieldLines, removeLines, sameValue, typedValue } from '../src/fields.ts';

const keys = (t: string) => parseFields(t).fields.map((f) => [f.kind, f.key, f.raw]);

test('finds full-line and bracketed fields', () => {
  const t = ['Status:: done', 'Some prose with [due:: 2026-10-10] and (rating:: 4) inside.', 'plain line'].join('\n');
  assert.deepEqual(keys(t), [
    ['line', 'Status', 'done'],
    ['bracket', 'due', '2026-10-10'],
    ['bracket', 'rating', '4'],
  ]);
});

test('skips front matter, fenced code, inline code, math, comments and indented code', () => {
  const t = [
    '---',
    'a:: 1',
    '---',
    '```',
    'b:: 2',
    '```',
    '~~~js',
    'c:: 3',
    '~~~',
    'inline `[d:: 4]` code and ``[e:: 5]``',
    '$$',
    'f:: 6',
    '$$',
    '%%',
    'g:: 7',
    '%%',
    '%% h:: 8 %%',
    '    i:: 9',
    '> ```',
    '> j:: 10',
    '> ```',
    'real:: yes',
  ].join('\n');
  assert.deepEqual(keys(t), [['line', 'real', 'yes']]);
});

test('an unclosed front matter marker is not front matter', () => {
  assert.deepEqual(keys('---\nk:: v'), [['line', 'k', 'v']]);
});

test('does not mistake other double colons for fields', () => {
  const t = ['std::string is a type', 'See http://example.com', 'Note: not a field', '- list:: item', '> quote:: x', '| a:: b |', '# Head:: x', '**bold**:: v'].join('\n');
  assert.deepEqual(keys(t), []);
});

test('bracketed fields in a list item are found, with links and nested brackets in the value', () => {
  const t = '- [ ] task [owner:: [[Ana]]] and (see:: a (b) c) end';
  assert.deepEqual(keys(t), [
    ['bracket', 'owner', '[[Ana]]'],
    ['bracket', 'see', 'a (b) c'],
  ]);
});

test('a wikilink or an unclosed bracket is not a field', () => {
  assert.deepEqual(keys('[[a::b]] and [x:: open'), []);
});

test('an empty value is skipped and reported', () => {
  const p = parseFields('empty::\nother:: \ntext [k:: ] and [ok:: 1]');
  assert.deepEqual(p.fields.map((f) => f.key), ['ok']);
  assert.deepEqual(p.skipped.map((s) => [s.field.key, s.reason]), [['empty', 'empty value'], ['other', 'empty value'], ['k', 'empty value']]);
});

test('CRLF text parses and the carriage return is not part of the value', () => {
  const p = parseFields('---\r\nx: 1\r\n---\r\nstatus:: done\r\n');
  assert.deepEqual(p.fields.map((f) => f.raw), ['done']);
});

test('property names: kept when valid, normalised like Dataview otherwise, unicode allowed', () => {
  assert.equal(propertyName('Status'), 'Status');
  assert.equal(propertyName('due_date'), 'due_date');
  assert.equal(propertyName('Due Date'), 'due-date');
  assert.equal(propertyName('  Fecha  de Inicio '), 'fecha-de-inicio');
  assert.equal(propertyName('año'), 'año');
  assert.equal(propertyName('Año Nuevo'), 'año-nuevo');
  assert.equal(propertyName('Приоритет'), 'Приоритет');
  assert.equal(propertyName('日本語 キー'), '日本語-キー');
  assert.equal(propertyName('what?'), 'what');
  assert.equal(propertyName('???'), '');
});

test('values are typed', () => {
  assert.equal(typedValue('n', '42'), 42);
  assert.equal(typedValue('n', '-3.5'), -3.5);
  assert.equal(typedValue('n', '007'), '007');
  assert.equal(typedValue('n', '1.50'), '1.50');
  assert.equal(typedValue('n', '12345678901234567890'), '12345678901234567890');
  assert.equal(typedValue('b', 'true'), true);
  assert.equal(typedValue('b', 'False'), false);
  assert.equal(typedValue('d', '2026-10-10'), '2026-10-10');
  assert.equal(typedValue('d', '2026-10-10T09:30:00'), '2026-10-10T09:30:00');
  assert.equal(typedValue('l', '[[Some note]]'), '[[Some note]]');
  assert.equal(typedValue('l', '[[Some note|alias]]'), '[[Some note|alias]]');
  assert.deepEqual(typedValue('l', '[[A]], [[B, C]]'), ['[[A]]', '[[B, C]]']);
  assert.equal(typedValue('s', 'Smith, John'), 'Smith, John');
  assert.equal(typedValue('s', 'It is 5 pm'), 'It is 5 pm');
});

test('tags, aliases and cssclasses become lists', () => {
  assert.deepEqual(typedValue('tags', '#a, #b c'), ['a', 'b-c']);
  assert.deepEqual(typedValue('Aliases', 'One, Two'), ['One', 'Two']);
  assert.deepEqual(typedValue('tags', 'solo'), ['solo']);
});

test('repeated keys become one list, in order, case-insensitively', () => {
  const p = planFields(parseFields('tag2:: 1\nauthor:: Ann\nauthor:: Bob\n[Author:: Cy]'), {});
  assert.deepEqual(p.moves.map((m) => [m.property, m.value]), [['tag2', 1], ['author', ['Ann', 'Bob', 'Cy']]]);
});

test('a property that does not exist yet is moved', () => {
  const p = planFields(parseFields('Due Date:: 2026-10-10\nrating:: 4'), { other: 1 });
  assert.deepEqual(p.moves.map((m) => [m.property, m.value]), [['due-date', '2026-10-10'], ['rating', 4]]);
  assert.equal(p.conflicts.length, 0);
});

test('an existing property with a different value is a conflict and is not overwritten', () => {
  const p = planFields(parseFields('status:: done\nrating:: 4'), { Status: 'todo' });
  assert.deepEqual(p.moves.map((m) => m.property), ['rating']);
  assert.deepEqual(p.conflicts.map((c) => [c.property, c.existing, c.value]), [['Status', 'todo', 'done']]);
  // the conflicting field stays in the text
  assert.deepEqual(removableLines(p), [1]);
});

test('an existing property with the same value is not written but the text can go', () => {
  const p = planFields(parseFields('rating:: 4\nlist:: a\nlist:: b\nflag:: true'), { rating: '4', list: ['a', 'b'], flag: true });
  assert.equal(p.moves.length, 0);
  assert.equal(p.conflicts.length, 0);
  assert.equal(p.same.length, 3);
  assert.deepEqual(removableLines(p), [0, 1, 2, 3]);
});

test('sameValue compares by text and treats a one-item list as its item', () => {
  assert.equal(sameValue(5, 5), true);
  assert.equal(sameValue('5', 5), true);
  assert.equal(sameValue(['a'], 'a'), true);
  assert.equal(sameValue(['a', 'b'], ['b', 'a']), false);
  assert.equal(sameValue(null, 'x'), false);
});

test('only line fields are removed; bracketed ones stay as prose', () => {
  const text = 'a:: 1\nprose [b:: 2] here\nc:: 3';
  const p = planFields(parseFields(text), {});
  assert.equal(p.moves.length, 3);
  assert.deepEqual(removableLines(p), [0, 2]);
  assert.equal(removeLines(text, removableLines(p)), 'prose [b:: 2] here');
});

test('removing lines keeps everything else byte for byte, including CRLF', () => {
  const text = '---\r\nx: 1\r\n---\r\nk:: v\r\nkeep this  \r\n\r\nend';
  const p = planFields(parseFields(text), {});
  assert.equal(removeLines(text, removableLines(p)), '---\r\nx: 1\r\n---\r\nkeep this  \r\n\r\nend');
});

test('a key with nothing usable is skipped', () => {
  const p = planFields(parseFields('??:: 1'), {});
  assert.equal(p.moves.length, 0);
  assert.deepEqual(p.skipped.map((s) => s.reason), ['not a usable property name']);
});

test('removeFieldLines finds the lines by their text, wherever they moved to', () => {
  const text = '---\nnew: 1\n---\nintro\nk:: v\nmid\nk:: v\nx:: 2';
  assert.equal(removeFieldLines(text, ['k:: v', 'k:: v']), '---\nnew: 1\n---\nintro\nmid\nx:: 2');
  assert.equal(removeFieldLines(text, ['k:: v', 'k:: v', 'k:: v']), undefined);
  assert.equal(removeFieldLines('intro\nk:: changed', ['k:: v']), undefined);
  assert.equal(removeFieldLines('```\nk:: v\n```', ['k:: v']), undefined);
});
