import * as vscode from "vscode";
import { lint, Severity, Diagnostic as OttlDiagnostic } from "./ottl/linter";
import { extractOTTL } from "./ottl/yaml";
import { initWasm } from "./ottl/wasmRunner";
import { DryRunPanel } from "./panel/dryRunPanel";

const COLLECTION_NAME = "ottl";
const YAML_LANGS = new Set(["yaml", "yml"]);

function toVscodeSeverity(sev: Severity): vscode.DiagnosticSeverity {
  return sev === "error"
    ? vscode.DiagnosticSeverity.Error
    : vscode.DiagnosticSeverity.Warning;
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

function lintDocument(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): void {
  let diagnostics: vscode.Diagnostic[] = [];
  const opts = {
    unknownFunctions: vscode.workspace
      .getConfiguration("ottl")
      .get<boolean>("lint.unknownFunctions", true),
  };

  if (doc.languageId === "ottl") {
    // Standalone .ottl file: the whole document is OTTL.
    diagnostics = lint(doc.getText(), opts).map((d) => toVscodeDiag(d, 0, 0));
  } else if (YAML_LANGS.has(doc.languageId)) {
    // Collector YAML: find embedded OTTL and lint each string in place.
    let extracted;
    try {
      extracted = extractOTTL(doc.getText());
    } catch {
      collection.delete(doc.uri);
      return;
    }
    for (const ex of extracted) {
      for (const d of lint(ex.text, opts)) {
        diagnostics.push(toVscodeDiag(d, ex.line, ex.col));
      }
    }
  } else {
    return; // not a file we handle
  }

  collection.set(doc.uri, diagnostics);
}

export function activate(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection(COLLECTION_NAME);
  context.subscriptions.push(collection);

  if (vscode.window.activeTextEditor) {
    lintDocument(vscode.window.activeTextEditor.document, collection);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => lintDocument(doc, collection)),
    vscode.workspace.onDidChangeTextDocument((e) => lintDocument(e.document, collection)),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)),
    vscode.commands.registerCommand("ottl.lintActiveFile", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        lintDocument(editor.document, collection);
      }
    }),
    vscode.commands.registerCommand("ottl.dryRun", async () => {
      try {
        // WASM init is lazy and idempotent; the progress notification only shows on first call.
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Loading OTTL engine…", cancellable: false },
          () => initWasm(context)
        );
      } catch (err) {
        void vscode.window.showErrorMessage(String(err));
        return;
      }
      DryRunPanel.show(context);
    })
  );
}

export function deactivate(): void {}
