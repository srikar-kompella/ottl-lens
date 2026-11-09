import * as vscode from "vscode";
import { lint, Severity, Diagnostic as OttlDiagnostic } from "./ottl/linter";
import { extractOTTL, editableInPlace, dryRunTargets, configIssues } from "./ottl/yaml";
import { EngineManager } from "./engineManager";
import { BUNDLED_ENGINE } from "./ottl/engines";
import { DryRunPanel } from "./panel/dryRunPanel";
import { registerAssistProviders } from "./providers";
import { InlineVerdicts } from "./verdicts";

const COLLECTION_NAME = "ottl";
const YAML_LANGS = new Set(["yaml", "yml"]);

/** A quick fix attached to a diagnostic, in document coordinates. */
interface DocFix {
  diagnostic: vscode.Diagnostic;
  title: string;
  range: vscode.Range;
  replacement: string;
  preferred?: boolean;
}

/** Fixes from the latest lint of each document, keyed by URI. */
const fixesByUri = new Map<string, DocFix[]>();

function toVscodeSeverity(sev: Severity): vscode.DiagnosticSeverity {
  if (sev === "error") return vscode.DiagnosticSeverity.Error;
  if (sev === "info") return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Warning;
}

function toVscodeDiag(d: OttlDiagnostic, lineOffset: number, colOffset: number): vscode.Diagnostic {
  // OTTL statements embedded in YAML are single-line scalars, so a diagnostic on
  // line 0 of the statement maps to (yamlLine, yamlCol + startCol). Column offset
  // only applies to the statement's own first line.
  const startLine = lineOffset + d.line;
  const startCol = d.line === 0 ? colOffset + d.startCol : d.startCol;
  const endCol = d.line === 0 ? colOffset + d.endCol : d.endCol;
  const range = new vscode.Range(startLine, startCol, startLine, endCol);
  const diag = new vscode.Diagnostic(range, d.message, toVscodeSeverity(d.severity));
  diag.source = "ottl";
  diag.code = d.code;
  return diag;
}

function lintDocument(doc: vscode.TextDocument, collection: vscode.DiagnosticCollection): void {
  const diagnostics: vscode.Diagnostic[] = [];
  const fixes: DocFix[] = [];
  const opts = {
    unknownFunctions: vscode.workspace.getConfiguration("ottl").get<boolean>("lint.unknownFunctions", true),
  };
  const add = (d: OttlDiagnostic, lineOffset: number, colOffset: number, canEdit: boolean) => {
    const diag = toVscodeDiag(d, lineOffset, colOffset);
    diagnostics.push(diag);
    if (d.fix && canEdit) {
      const line = lineOffset + d.line;
      const base = d.line === 0 ? colOffset : 0;
      for (const fix of [d.fix, ...(d.alternativeFixes ?? [])]) {
        fixes.push({
          diagnostic: diag,
          title: fix.title,
          range: new vscode.Range(line, base + fix.start, line, base + fix.end),
          replacement: fix.replacement,
          preferred: fix === d.fix,
        });
      }
    }
  };

  if (doc.languageId === "ottl") {
    // Standalone .ottl file: the whole document is OTTL.
    for (const d of lint(doc.getText(), opts)) add(d, 0, 0, true);
  } else if (YAML_LANGS.has(doc.languageId)) {
    // Collector YAML: find embedded OTTL and lint each string in place.
    let extracted;
    try {
      extracted = extractOTTL(doc.getText());
    } catch {
      collection.delete(doc.uri);
      fixesByUri.delete(doc.uri.toString());
      return;
    }
    for (const ex of extracted) {
      // Fixes are only offered where text offsets map 1:1 onto the document.
      const canEdit = editableInPlace(ex);
      const inferredSignal = ex.context === null && /^transform(\/|$)/.test(ex.component)
        ? ex.signal ?? undefined
        : undefined;
      for (const d of lint(ex.text, { ...opts, inferredSignal })) add(d, ex.line, ex.col, canEdit && d.line === 0);
    }
    // Processor settings around the OTTL (deprecated / conflicting keys).
    for (const c of configIssues(doc.getText())) {
      const range = new vscode.Range(c.line, c.startCol, c.line, c.endCol);
      const diag = new vscode.Diagnostic(range, c.message, c.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      diag.source = "ottl";
      diag.code = c.code;
      diagnostics.push(diag);
      if (c.fix) fixes.push({ diagnostic: diag, title: c.fix.title, range, replacement: c.fix.replacement });
    }
  } else {
    return; // not a file we handle
  }

  collection.set(doc.uri, diagnostics);
  fixesByUri.set(doc.uri.toString(), fixes);
}

const SELECTOR: vscode.DocumentSelector = [{ language: "ottl" }, { language: "yaml" }, { language: "yml" }];

class QuickFixes implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const fixes = fixesByUri.get(doc.uri.toString()) ?? [];
    return fixes
      .filter((f) => f.diagnostic.range.intersection(range) !== undefined)
      .map((f) => {
        const action = new vscode.CodeAction(f.title, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(doc.uri, f.range, f.replacement);
        action.diagnostics = [f.diagnostic];
        action.isPreferred = f.preferred ?? true;
        return action;
      });
  }
}

/** "▶ Dry-run" above every runnable transform block (YAML) and at the top of .ottl files. */
class DryRunLenses implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  refresh(): void {
    this.changed.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration("ottl").get<boolean>("codeLens.enabled", true)) return [];
    const lens = (line: number, title: string) =>
      new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title,
        command: "ottl.dryRunAt",
        arguments: [doc.uri, line],
      });
    if (doc.languageId === "ottl") return doc.getText().trim() ? [lens(0, "▶ Dry-run this file")] : [];
    let targets;
    try {
      targets = dryRunTargets(doc.getText());
    } catch {
      return [];
    }
    return targets.map((t) =>
      lens(t.line, `▶ Dry-run ${t.component} (${t.signal}, ${t.count} statement${t.count === 1 ? "" : "s"})`)
    );
  }
}

let engines: EngineManager | undefined;

/** Make sure the bundled engine loads before opening the panel (other versions load on demand). */
async function ensureEngine(): Promise<boolean> {
  try {
    return !!(await engines?.get(BUNDLED_ENGINE));
  } catch (err) {
    void vscode.window.showErrorMessage(String(err));
    return false;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection(COLLECTION_NAME);
  const inline = new InlineVerdicts();
  const lenses = new DryRunLenses();
  DryRunPanel.inline = inline;
  engines = new EngineManager(context);
  DryRunPanel.engines = engines;
  context.subscriptions.push(collection, inline);
  registerAssistProviders(context);

  if (vscode.window.activeTextEditor) {
    lintDocument(vscode.window.activeTextEditor.document, collection);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => lintDocument(doc, collection)),
    vscode.workspace.onDidChangeTextDocument((e) => lintDocument(e.document, collection)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      collection.delete(doc.uri);
      fixesByUri.delete(doc.uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("ottl.codeLens")) lenses.refresh(); }),
    vscode.languages.registerCodeActionsProvider(SELECTOR, new QuickFixes(), { providedCodeActionKinds: QuickFixes.kinds }),
    vscode.languages.registerCodeLensProvider(SELECTOR, lenses),
    vscode.commands.registerCommand("ottl.lintActiveFile", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) lintDocument(editor.document, collection);
    }),
    vscode.commands.registerCommand("ottl.dryRun", async () => {
      if (await ensureEngine()) DryRunPanel.show(context);
    }),
    vscode.commands.registerCommand("ottl.dryRunAt", async (uri: vscode.Uri, line: number) => {
      // Put the cursor in the chosen block, then open the panel and run it right away.
      const editor = await vscode.window.showTextDocument(uri, { preserveFocus: false, preview: false });
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      if (await ensureEngine()) DryRunPanel.show(context, { autoRun: true });
    }),
    vscode.commands.registerCommand("ottl.clearVerdicts", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) inline.clear(editor.document.uri);
    })
  );
}

export function deactivate(): void {}
