# Changelog

The release workflow uses the section named after the version being released
as the release description, so every version needs one. `npm version <x.y.z>`
renames the `Unreleased` heading below to that version.

## 0.2.0

- New commands move Dataview inline fields (`status:: done`, `[due:: 2026-10-10]`) into the note's properties so Bases can see them, with a preview for the whole vault and an undo for the last move.
- The vault scan report now lists the notes that have inline fields.

## 0.1.1

- Settings now appear in Obsidian's settings search (declarative settings API on 1.13 and later).

## 0.1.0

- First release.
