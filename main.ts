import { MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import type { App, Editor, MarkdownFileInfo, SettingDefinitionItem } from 'obsidian';

import { parseFields, planFields, removableSources, removeFieldLines, showValue } from './src/fields.ts';
import type { Plan } from './src/fields.ts';
import { buildReport, inlineFieldNames, planEdits, scanText } from './src/scan.ts';
import type { Edit, FileScan } from './src/scan.ts';

interface Settings {
  keepOriginal: boolean;
  reportPath: string;
  removeFields: boolean;
}

const DEFAULTS: Settings = {
  keepOriginal: true,
  reportPath: 'Dataview to Bases report.md',
  removeFields: true,
};

/** A note as it was before and right after the last move, so it can be put back. */
interface SavedNote {
  path: string;
  original: string;
  after: string;
}

interface LastMove {
  notes: SavedNote[];
}

/** Above this many characters the last move is only kept until Obsidian closes. */
const MAX_SAVED_CHARS = 4_000_000;

interface NoteResult {
  path: string;
  plan: Plan;
  /** Field lines taken out of the text. */
  removed: number;
  error?: string;
}

interface Candidate {
  file: TFile;
  plan: Plan;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function isLastMove(v: unknown): v is LastMove {
  const notes = (v as LastMove | undefined)?.notes;
  return (
    Array.isArray(notes) &&
    notes.every((n) => typeof n?.path === 'string' && typeof n.original === 'string' && typeof n.after === 'string')
  );
}

/** Front matter as the metadata cache has it, without its `position` entry. */
function cachedProperties(app: App, file: TFile): Record<string, unknown> {
  const fm = { ...(app.metadataCache.getFileCache(file)?.frontmatter ?? {}) } as Record<string, unknown>;
  delete fm.position;
  return fm;
}

export default class DataviewToBases extends Plugin {
  settings: Settings = { ...DEFAULTS };
  lastMove: LastMove | undefined;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: 'convert-at-cursor',
      name: 'Convert Dataview query at cursor to Bases',
      icon: 'arrow-right-left',
      editorCallback: (editor: Editor) => {
        void this.convert(editor, true);
      },
    });
    this.addCommand({
      id: 'convert-all',
      name: 'Convert all Dataview queries in this note',
      icon: 'list-restart',
      editorCallback: (editor: Editor) => {
        void this.convert(editor, false);
      },
    });
    this.addCommand({
      id: 'scan-vault',
      name: 'Scan vault for Dataview queries',
      icon: 'scan-search',
      callback: () => {
        void this.scanVault();
      },
    });

    this.addCommand({
      id: 'move-fields-note',
      name: 'Move inline fields to properties in this note',
      icon: 'file-input',
      editorCheckCallback: (checking: boolean, _editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
        if (!ctx.file) return false;
        if (!checking) void this.moveInNote(ctx);
        return true;
      },
    });
    this.addCommand({
      id: 'move-fields-vault',
      name: 'Move inline fields to properties in the vault…',
      icon: 'files',
      callback: () => {
        void this.moveInVault();
      },
    });
    this.addCommand({
      id: 'undo-move-fields',
      name: 'Undo the last move of inline fields',
      icon: 'undo-2',
      callback: () => {
        void this.undoMove();
      },
    });

    this.addSettingTab(new DataviewToBasesSettingTab(this));
  }

  /**
   * Adds the properties first, then takes the field lines out of the text, so a
   * failure in between leaves a duplicate, never a lost value. Nothing is
   * overwritten: a property the note already has with another value is a conflict.
   */
  private async moveInFile(file: TFile, remove: boolean): Promise<{ result: NoteResult; saved?: SavedNote }> {
    const original = await this.app.vault.read(file);
    const parsed = parseFields(original);
    let plan = planFields(parsed, cachedProperties(this.app, file));
    const result: NoteResult = { path: file.path, plan, removed: 0 };
    try {
      if (plan.moves.length) {
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          plan = planFields(parsed, fm);
          for (const m of plan.moves) fm[m.property] = Array.isArray(m.value) ? m.value.slice() : m.value;
        });
        result.plan = plan;
      }
      const sources = remove ? removableSources(plan) : [];
      if (sources.length) {
        let gone = false;
        await this.app.vault.process(file, (data) => {
          const out = removeFieldLines(data, sources);
          if (out === undefined) return data;
          gone = true;
          return out;
        });
        if (gone) result.removed = sources.length;
        else result.error = 'The note changed while it was being updated, so the fields were left in the text.';
      }
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
    }
    const after = await this.app.vault.read(file);
    return { result, saved: after !== original ? { path: file.path, original, after } : undefined };
  }

  private async remember(notes: SavedNote[]) {
    if (!notes.length) return;
    this.lastMove = { notes };
    await this.saveSettings();
  }

  private async moveInNote(ctx: MarkdownView | MarkdownFileInfo) {
    const file = ctx.file;
    if (!file) return;
    // what is on screen must be on disk before the note is read
    if (ctx instanceof MarkdownView) await ctx.save();
    const { result, saved } = await this.moveInFile(file, this.settings.removeFields);
    if (saved) await this.remember([saved]);
    const p = result.plan;
    const found = p.moves.length + p.same.length + p.conflicts.length;
    if (!found) {
      new Notice(p.skipped.length ? `No inline field could be moved (${p.skipped[0].reason}).` : 'No inline fields in this note.');
      return;
    }
    const done = p.moves.length;
    const parts = [`Moved ${plural(done, 'field', 'fields')} to properties.`];
    if (p.conflicts.length) {
      parts.push(`${plural(p.conflicts.length, 'property was', 'properties were')} left alone because the note already has a different value (${p.conflicts.map((c) => c.property).join(', ')}).`);
    }
    if (result.error) parts.push(result.error);
    if (saved) parts.push('Run "Undo the last move of inline fields" to revert.');
    new Notice(parts.join(' '), 10000);
  }

  private async moveInVault() {
    const found: Candidate[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const text = await this.app.vault.cachedRead(file);
      if (!text.includes('::')) continue;
      const parsed = parseFields(text);
      if (!parsed.fields.length && !parsed.skipped.length) continue;
      found.push({ file, plan: planFields(parsed, cachedProperties(this.app, file)) });
    }
    found.sort((a, b) => a.file.path.localeCompare(b.file.path));
    if (!found.length) {
      new Notice('No inline fields found in the vault.');
      return;
    }
    new MoveFieldsModal(this.app, this, found, (files) => {
      void this.applyVault(files);
    }).open();
  }

  private async applyVault(files: TFile[]) {
    const saved: SavedNote[] = [];
    let fields = 0;
    let notes = 0;
    let left = 0;
    let errors = 0;
    for (const file of files) {
      const { result, saved: s } = await this.moveInFile(file, this.settings.removeFields);
      if (s) saved.push(s);
      if (result.plan.moves.length) notes++;
      fields += result.plan.moves.length;
      left += result.plan.conflicts.length;
      if (result.error) errors++;
    }
    await this.remember(saved);
    const parts = [`Moved ${plural(fields, 'property', 'properties')} in ${plural(notes, 'note', 'notes')}.`];
    if (left) parts.push(`${plural(left, 'conflict', 'conflicts')} left alone.`);
    if (errors) parts.push(`${plural(errors, 'note', 'notes')} could not be fully updated.`);
    if (saved.length) parts.push('Run "Undo the last move of inline fields" to revert.');
    new Notice(parts.join(' '), 10000);
  }

  /** Puts back each note as it was, unless it was edited after the move. */
  private async undoMove() {
    const last = this.lastMove;
    if (!last) {
      new Notice('There is no move to undo.');
      return;
    }
    let restored = 0;
    let edited = 0;
    let missing = 0;
    for (const n of last.notes) {
      const file = this.app.vault.getAbstractFileByPath(n.path);
      if (!(file instanceof TFile)) {
        missing++;
        continue;
      }
      let did = false;
      await this.app.vault.process(file, (data) => {
        if (data !== n.after) return data;
        did = true;
        return n.original;
      });
      if (did) restored++;
      else edited++;
    }
    this.lastMove = undefined;
    await this.saveSettings();
    const parts = [`Restored ${plural(restored, 'note', 'notes')}.`];
    if (edited) parts.push(`${plural(edited, 'note was', 'notes were')} edited since and left as they are.`);
    if (missing) parts.push(`${plural(missing, 'note is', 'notes are')} gone or renamed.`);
    new Notice(parts.join(' '), 8000);
  }

  /** Names of inline fields (key:: value) anywhere in the vault, which Bases cannot read. */
  private async inlineFields(): Promise<Set<string>> {
    const names = new Set<string>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const text = await this.app.vault.cachedRead(f);
      if (!text.includes('::')) continue;
      for (const n of inlineFieldNames(text)) names.add(n);
    }
    return names;
  }

  private async convert(editor: Editor, atCursor: boolean) {
    const inlineFields = await this.inlineFields();
    // read the note after the wait, so what is converted is what is on screen
    const text = editor.getValue();
    const cursor = editor.getCursor('from').line;
    const edits = planEdits(text, this.settings.keepOriginal, atCursor ? (b) => cursor >= b.start && cursor <= b.end : undefined, { inlineFields });
    if (!edits.length) {
      new Notice(atCursor ? 'The cursor is not inside a Dataview query.' : 'No Dataview queries in this note.');
      return;
    }
    const todo = edits.filter((e): e is Edit & { lines: string[] } => e.lines !== undefined);
    if (todo.length) {
      const lines = text.split('\n');
      // one transaction, so a single undo restores every query
      editor.transaction({
        changes: todo.map((e) => ({
          from: { line: e.block.start, ch: 0 },
          to: { line: e.block.end, ch: lines[e.block.end].length },
          text: e.lines.join('\n'),
        })),
      });
    }
    const skipped = edits.filter((e) => e.lines === undefined);
    if (atCursor) {
      const only = edits[0];
      new Notice(
        only.lines
          ? `Converted to Bases.${only.conversion.warnings.length ? ' ' + only.conversion.warnings.join(' ') : ''}`
          : `Not converted: ${only.conversion.reasons.join('; ')}.`,
        only.lines ? 6000 : 10000,
      );
      return;
    }
    const first = skipped[0]?.conversion.reasons[0];
    new Notice(
      `Converted ${todo.length} of ${edits.length} queries.` +
        (skipped.length ? ` ${skipped.length} left unchanged (first reason: ${first}). Run the vault scan for details.` : ''),
      8000,
    );
  }

  private async scanVault() {
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path !== this.settings.reportPath);
    const scans: FileScan[] = [];
    const inlineFields = await this.inlineFields();
    for (const f of files) {
      const text = await this.app.vault.cachedRead(f);
      const s = scanText(f.path, text, { inlineFields });
      if (s) scans.push(s);
    }
    scans.sort((a, b) => a.path.localeCompare(b.path));
    const report = buildReport(scans, files.length, new Date().toISOString().slice(0, 10));
    const path = this.settings.reportPath;
    const existing = this.app.vault.getAbstractFileByPath(path);
    let file: TFile;
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, report);
      file = existing;
    } else {
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
      file = await this.app.vault.create(path, report);
    }
    await this.app.workspace.getLeaf(false).openFile(file);
    new Notice(`Scanned ${files.length} notes. Report: ${path}`);
  }

  async loadSettings() {
    const { lastMove, ...rest } = ((await this.loadData()) ?? {}) as Partial<Settings> & { lastMove?: unknown };
    this.settings = { ...DEFAULTS, ...rest };
    this.lastMove = isLastMove(lastMove) ? lastMove : undefined;
  }

  async saveSettings() {
    const size = this.lastMove?.notes.reduce((n, x) => n + x.original.length + x.after.length, 0) ?? 0;
    await this.saveData({ ...this.settings, lastMove: size <= MAX_SAVED_CHARS ? this.lastMove : undefined });
  }
}

/** Names and descriptions shared by the 1.13+ declarative tab and the older `display()`. */
const TEXT = {
  keepOriginal: {
    name: 'Keep the original query',
    desc: 'Leave the Dataview query under the new block, inside a comment that only shows while editing.',
  },
  removeFields: {
    name: 'Remove the fields from the text',
    desc: 'When moving inline fields to properties, take lines like "status:: done" out of the note. Fields inside a sentence, like [status:: done], always stay in the text and are only copied.',
  },
  reportPath: {
    name: 'Report note',
    desc: 'Where the vault scan writes its report. The note is replaced on every scan.',
  },
};

class DataviewToBasesSettingTab extends PluginSettingTab {
  plugin: DataviewToBases;

  constructor(plugin: DataviewToBases) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  /**
   * The settings, described rather than drawn. Obsidian 1.13 and later
   * renders this itself and indexes it for the settings search. Older
   * versions ignore it and call `display()`.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { ...TEXT.keepOriginal, control: { type: 'toggle', key: 'keepOriginal', defaultValue: DEFAULTS.keepOriginal } },
      { ...TEXT.removeFields, control: { type: 'toggle', key: 'removeFields', defaultValue: DEFAULTS.removeFields } },
      { ...TEXT.reportPath, control: { type: 'text', key: 'reportPath', placeholder: DEFAULTS.reportPath, defaultValue: DEFAULTS.reportPath } },
    ];
  }

  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === 'reportPath') {
      const p = String(value).trim() || DEFAULTS.reportPath;
      this.plugin.settings.reportPath = p.endsWith('.md') ? p : `${p}.md`;
    } else Object.assign(this.plugin.settings, { [key]: value });
    await this.plugin.saveSettings();
  }

  /** The pre-1.13 rendering, from the same text. Obsidian skips it once `getSettingDefinitions()` returns anything. */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName(TEXT.keepOriginal.name)
      .setDesc(TEXT.keepOriginal.desc)
      .addToggle((t) => t.setValue(this.plugin.settings.keepOriginal).onChange((v) => this.setControlValue('keepOriginal', v)));

    new Setting(containerEl)
      .setName(TEXT.removeFields.name)
      .setDesc(TEXT.removeFields.desc)
      .addToggle((t) => t.setValue(this.plugin.settings.removeFields).onChange((v) => this.setControlValue('removeFields', v)));

    new Setting(containerEl)
      .setName(TEXT.reportPath.name)
      .setDesc(TEXT.reportPath.desc)
      .addText((t) =>
        t
          .setPlaceholder(DEFAULTS.reportPath)
          .setValue(this.plugin.settings.reportPath)
          .onChange((v) => this.setControlValue('reportPath', v)),
      );
  }
}

/** Shows what the vault-wide move would do, per note, and lets the user pick the notes. */
class MoveFieldsModal extends Modal {
  private readonly picked = new Set<TFile>();
  private static readonly SHOWN = 300;

  constructor(
    app: App,
    private readonly plugin: DataviewToBases,
    private readonly found: Candidate[],
    private readonly onApply: (files: TFile[]) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle('Move inline fields to properties');
    const shown = this.found.slice(0, MoveFieldsModal.SHOWN);
    const todo = (c: Candidate) => c.plan.moves.length > 0 || c.plan.same.length > 0;
    shown.filter(todo).forEach((c) => this.picked.add(c.file));

    const fieldCount = this.found.reduce((n, c) => n + c.plan.moves.length, 0);
    contentEl.createEl('p', {
      text: `${plural(this.found.length, 'note has', 'notes have')} inline fields. ${plural(fieldCount, 'property', 'properties')} can be added. Nothing is overwritten, and you can undo the move afterwards.`,
    });
    if (this.found.length > shown.length) {
      contentEl.createEl('p', { cls: 'setting-item-description', text: `Showing the first ${shown.length} notes. Run the command again after this one to see the rest.` });
    }

    new Setting(contentEl)
      .setName(TEXT.removeFields.name)
      .setDesc('Fields inside a sentence always stay in the text.')
      .addToggle((t) => t.setValue(this.plugin.settings.removeFields).onChange((v) => {
        this.plugin.settings.removeFields = v;
        void this.plugin.saveSettings();
      }));

    const list = contentEl.createDiv();
    const apply = new Setting(contentEl);
    let button: { setButtonText(text: string): unknown; setDisabled(disabled: boolean): unknown } | undefined;
    const refresh = () => {
      button?.setButtonText(`Move fields in ${plural(this.picked.size, 'note', 'notes')}`);
      button?.setDisabled(this.picked.size === 0);
    };

    for (const c of shown) {
      const row = list.createDiv({ cls: 'setting-item' });
      const info = row.createDiv({ cls: 'setting-item-info' });
      const label = info.createEl('label', { cls: 'setting-item-name' });
      const box = label.createEl('input', { type: 'checkbox' });
      box.checked = this.picked.has(c.file);
      box.disabled = !todo(c);
      box.addEventListener('change', () => {
        if (box.checked) this.picked.add(c.file);
        else this.picked.delete(c.file);
        refresh();
      });
      label.createSpan({ text: ` ${c.file.path}` });
      const lines = info.createDiv({ cls: 'setting-item-description' });
      const add = (text: string) => lines.createDiv({ text });
      const at = (fields: Array<{ line: number }>) => `line ${fields.map((f) => f.line + 1).join(', ')}`;
      for (const m of c.plan.moves) add(`${m.property}: ${showValue(m.value)} (${at(m.fields)})`);
      for (const m of c.plan.same) add(`${m.property}: already has this value (${at(m.fields)})`);
      for (const x of c.plan.conflicts) {
        add(`${x.property}: kept ${showValue(x.existing)}, not ${showValue(x.value)}. Left in the text (${at(x.fields)})`);
      }
      for (const x of c.plan.skipped) add(`${x.field.key}:: skipped, ${x.reason} (line ${x.field.line + 1})`);
    }

    apply
      .addButton((b) => {
        button = b;
        b.setCta().onClick(() => {
          const files = this.found.map((c) => c.file).filter((f) => this.picked.has(f));
          this.close();
          this.onApply(files);
        });
      })
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
    refresh();
  }

  onClose() {
    this.contentEl.empty();
  }
}
