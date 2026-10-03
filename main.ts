import { Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import type { Editor } from 'obsidian';

import { buildReport, inlineFieldNames, planEdits, scanText } from './src/scan.ts';
import type { Edit, FileScan } from './src/scan.ts';

interface Settings {
  keepOriginal: boolean;
  reportPath: string;
}

const DEFAULTS: Settings = {
  keepOriginal: true,
  reportPath: 'Dataview to Bases report.md',
};

export default class DataviewToBases extends Plugin {
  settings: Settings = { ...DEFAULTS };

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

    this.addSettingTab(new DataviewToBasesSettingTab(this));
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
    const data = (await this.loadData()) as Partial<Settings> | null;
    this.settings = { ...DEFAULTS, ...(data ?? {}) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class DataviewToBasesSettingTab extends PluginSettingTab {
  plugin: DataviewToBases;

  constructor(plugin: DataviewToBases) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Keep the original query')
      .setDesc('Leave the Dataview query under the new block, inside a comment that only shows while editing.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.keepOriginal).onChange(async (v) => {
          this.plugin.settings.keepOriginal = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Report note')
      .setDesc('Where the vault scan writes its report. The note is replaced on every scan.')
      .addText((t) =>
        t
          .setPlaceholder(DEFAULTS.reportPath)
          .setValue(this.plugin.settings.reportPath)
          .onChange(async (v) => {
            const p = v.trim() || DEFAULTS.reportPath;
            this.plugin.settings.reportPath = p.endsWith('.md') ? p : `${p}.md`;
            await this.plugin.saveSettings();
          }),
      );
  }
}
