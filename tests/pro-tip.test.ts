import assert from 'node:assert/strict';
import test from 'node:test';

import { leftSomeBehind } from '../src/pro-tip.ts';
import { planEdits } from '../src/scan.ts';

test('nothing to check when every query converted cleanly, or there were none', () => {
  assert.equal(leftSomeBehind([]), false);
  assert.equal(leftSomeBehind(['full', 'full']), false);
});

test('one partly or unconverted query is enough', () => {
  assert.equal(leftSomeBehind(['full', 'partly']), true);
  assert.equal(leftSomeBehind(['none']), true);
});

test('works on real plans: a plain list converts, dataviewjs with a loop does not', () => {
  const ok = planEdits('```dataview\nLIST FROM "a"\n```\n', true);
  assert.equal(leftSomeBehind(ok.map((e) => e.conversion.status)), false);
  const bad = planEdits('```dataviewjs\nfor (const p of dv.pages()) { dv.paragraph(p.file.name); }\n```\n', true);
  assert.equal(leftSomeBehind(bad.map((e) => e.conversion.status)), true);
});
