# Dataview to Bases

Convert Dataview queries into Bases blocks, and see which queries in your vault can be converted. A migration helper for people moving off Dataview, which has had no release in over a year, to the Bases core feature.

It converts the common queries (`TABLE`, `LIST`, `FROM`, `WHERE`, `SORT`, `LIMIT`, `GROUP BY`) and tells you plainly why it leaves the rest alone. It never converts anything on its own, and the vault scan never edits a note.

## Commands

| Command | What it does |
|---|---|
| Convert Dataview query at cursor to Bases | Replaces the `dataview` block under the cursor with a `base` block. |
| Convert all Dataview queries in this note | Converts every convertible query in the note and leaves the others as they are. |
| Scan vault for Dataview queries | Writes a report note: for each note, each query and whether it is convertible, partly convertible or not, with the reasons. Edits nothing else. |

Each conversion is one change in the editor, so a single **Undo** brings every query back. By default the original query stays under the new block inside a comment (hidden in reading view; its tags and links do not count for the note). Turn that off in the settings.

## Example

````
```dataview
TABLE rating AS "Stars" FROM "Books" WHERE rating >= 4 SORT rating DESC LIMIT 10
```
````

becomes

````
```base
filters:
  and:
    - 'file.inFolder("Books")'
    - 'note.rating >= 4'
properties:
  file.name:
    displayName: File
  note.rating:
    displayName: Stars
views:
  - type: table
    name: Table
    limit: 10
    sort:
      - property: note.rating
        direction: DESC
    order:
      - file.name
      - note.rating
```
````

## What converts

- `TABLE` (with `AS` aliases and `WITHOUT ID`) becomes a table view; `LIST` becomes a list view.
- `FROM` with folders, files, `#tags`, `[[links]]` (notes that link to it), `[[]]` (notes that link to this one), and `and`, `or`, `-`/`!` and parentheses.
- `WHERE` with comparisons, `and`/`or`/`!`, `= null`, dates (`date(today)`, `dur(7 days)`) and the common functions: `contains`, `icontains`, `lower`, `length`, `default`, `choice`, `startswith`, `endswith`, `replace`, `split`, `join`, `round`, `floor`, `ceil`, `abs`, `min`, `max`, `dateformat`, `striptime`, `number`, `link` and a few more.
- `SORT` with several keys, `LIMIT` with a number, `GROUP BY` one field.
- `file.name`, `file.link`, `file.path`, `file.folder`, `file.ext`, `file.size`, `file.ctime`, `file.mtime`, `file.cday`, `file.mday`, `file.tags`, `file.outlinks`, `file.inlinks` and `this.file.*`.
- Columns that are not plain properties become formulas, named after what they were.

## What does not convert

Left unchanged, with the reason in the notice or the report:

- `TASK` and `CALENDAR` queries, `dataviewjs` blocks and inline `= …` queries.
- `FLATTEN`, and `FROM outgoing(…)` or `csv(…)` sources.
- Functions Bases has no equivalent for, such as `upper`, `sum`, `regexmatch`, `map` and `filter`; `file.tasks`, `file.lists`, `file.day`, `file.starred`.

## Differences you should check

A query is reported as **partly** convertible when the result may not match Dataview. The notice and the report say which of these applies:

- **Inline fields.** Bases reads only properties in the frontmatter. If a field the query uses is written inline somewhere in your vault (`status:: done`, `[due:: 2026-10-10]`), the query is reported as partly, because the converted table would be empty or wrong for those notes. Move the field into the frontmatter, or keep Dataview for that query.
- **`contains()` on a property.** On a list property, Dataview also matches part of an item (`contains(authors, "Smi")` finds "Smith"), while Bases matches whole items only. `econtains` converts exactly.
- **`GROUP BY`.** Dataview shows one row per group; Bases lists every note under its group heading.
- **`this.field`.** Properties of the current page are mapped to `this.note.field`; check the result.
- **Property spelling.** Dataview matches `Due Date` as `due-date`. Bases uses the property name exactly as written in the query, so names with a hyphen or a space are reported as partly and converted to a formula that reads the name as written.
- **Clause order.** Dataview runs `LIMIT` where you wrote it (`LIMIT 10 SORT x` sorts only ten notes); Bases always filters, sorts, then limits.

Translated without a warning: `x = null` stays `x == null` (so `0`, `false` and an empty text are values, as in Dataview), `default(x, y)` only replaces a missing value, `contains(file.tags, "#x")` becomes `file.hasTag("x")`, and `dateformat()` formats are translated to the common Bases ones (unusual tokens are reported as not convertible).

The converted block is what Bases reads, so you can edit it after converting, and **Bases** shows the result right away in the note.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Keep the original query | on | Leaves the query under the new block in a hidden comment. |
| Report note | `Dataview to Bases report.md` | Where the vault scan writes its report. Replaced on every scan. |

## Notes

- Needs a version of Obsidian with Bases (1.10 for the list view). The plugin only writes text; it does not need Dataview installed.
- No network use, no data leaves your vault.

## Installation

In Obsidian, open **Settings → Community plugins → Browse** and search for "Dataview to Bases".
