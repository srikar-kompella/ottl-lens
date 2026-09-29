/**
 * VS Code glue for hover and autocomplete. All logic lives in src/ottl/assist.ts;
 * this file only decides where OTTL is and converts results to VS Code types.
 */

import * as vscode from "vscode";
import { completionsAt, hoverAt, isOttlLine, type LineOptions, type SuggestionKind } from "./ottl/assist";

const SELECTOR: vscode.DocumentSelector = [
  { language: "ottl" },
  { language: "yaml" },
  { language: "yml" },
];

const KIND: Record<SuggestionKind, vscode.CompletionItemKind> = {
  function: vscode.CompletionItemKind.Function,
  field: vscode.CompletionItemKind.Field,
  context: vscode.CompletionItemKind.Module,
  enum: vscode.CompletionItemKind.EnumMember,
  keyword: vscode.CompletionItemKind.Keyword,
};

/** Line options for this position, or undefined when the position isn't OTTL. */
function ottlLine(doc: vscode.TextDocument, pos: vscode.Position): LineOptions | undefined {
  if (doc.languageId === "ottl") return { yaml: false };
  const lines = doc.getText().split(/\r?\n/);
  return isOttlLine(lines, pos.line) ? { yaml: true } : undefined;
}

export function registerAssistProviders(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(SELECTOR, {
      provideHover(doc, pos) {
        const opts = ottlLine(doc, pos);
        if (!opts) return undefined;
        const h = hoverAt(doc.lineAt(pos.line).text, pos.character, opts);
        if (!h) return undefined;
        const md = new vscode.MarkdownString(h.markdown);
        md.isTrusted = false;
        return new vscode.Hover(md, new vscode.Range(pos.line, h.start, pos.line, h.end));
      },
    }),

    vscode.languages.registerCompletionItemProvider(
      SELECTOR,
      {
        provideCompletionItems(doc, pos) {
          const opts = ottlLine(doc, pos);
          if (!opts) return undefined;
          const { items, replaceStart } = completionsAt(doc.lineAt(pos.line).text, pos.character, opts);
          const range = new vscode.Range(pos.line, replaceStart, pos.line, pos.character);
          return items.map((s) => {
            const item = new vscode.CompletionItem(s.label, KIND[s.kind]);
            item.detail = s.detail;
            if (s.documentation) item.documentation = new vscode.MarkdownString(s.documentation);
            item.insertText = s.snippet ? new vscode.SnippetString(s.insertText) : s.insertText;
            item.sortText = s.sortText;
            item.range = range;
            if (s.deprecated) item.tags = [vscode.CompletionItemTag.Deprecated];
            if (s.retrigger) item.command = { title: "", command: "editor.action.triggerSuggest" };
            return item;
          });
        },
      },
      "."
    )
  );
}
