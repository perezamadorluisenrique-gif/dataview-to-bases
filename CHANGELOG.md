# Changelog

The release workflow uses the section named after the version being released
as the release description, so every version needs one. `npm version <x.y.z>`
renames the `Unreleased` heading below to that version.

## 0.3.0

- Many more queries convert: `regextest`, `regexmatch`, `regexreplace`, `substring`, `truncate`, `padleft`, `padright`, `trunc`, `sum`, `average`, `min` and `max` of a list, `map`, `filter`, `any`, `all`, `none` with lambdas (`(h) => h > 8`), `nonnull`, and `typeof(x) = "…"`. Each one is exact or reported as partly with the reason; `sum`, `min` and `max` of a list need Obsidian 1.11.
- `!x` now lists the notes without `x`, as Dataview does, and `length(x)` gives 0 for them.
- `contains()` on text is reported as partly: Bases ignores upper and lower case there.
- `split()` with a regular expression separator now splits on the pattern, as in Dataview, and a backslash in a query string is kept as Dataview keeps it.
- A comparison such as `x > 5` or `file.size < 100` no longer gets the empty-value warning; only `x < 5` (where Dataview lists notes without `x`) does.
- `sort(list)` can start a column.

## 0.2.1

- A query that compares a property with a number (`rating < 5`) now gets a warning: Dataview treats a note without the property as smaller than any number, and Bases does not match it.

## 0.2.0

- New commands move Dataview inline fields (`status:: done`, `[due:: 2026-10-10]`) into the note's properties so Bases can see them, with a preview for the whole vault and an undo for the last move.
- The vault scan report now lists the notes that have inline fields.

## 0.1.1

- Settings now appear in Obsidian's settings search (declarative settings API on 1.13 and later).

## 0.1.0

- First release.
