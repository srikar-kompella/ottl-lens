import * as vscode from "vscode";
import { evalOTTL } from "../ottl/wasmRunner";
import { collectStatementsForDryRun } from "../ottl/yaml";

const PANEL_TITLE = "OTTL Dry Run";
const VIEW_TYPE = "ottl.dryRun";

const DEFAULT_PAYLOAD: Record<string, string> = {
  logs: JSON.stringify({
    resourceLogs: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "my-service" } }] },
      scopeLogs: [{
        scope: {},
        logRecords: [{
          timeUnixNano: "1000000000000000000",
          severityNumber: 9,
          severityText: "INFO",
          body: { stringValue: "Hello world" },
          attributes: [
            { key: "environment", value: { stringValue: "staging" } },
            { key: "http.method", value: { stringValue: "GET" } }
          ]
        }]
      }]
    }]
  }, null, 2),
  traces: JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "my-service" } }] },
      scopeSpans: [{
        scope: {},
        spans: [{
          traceId: "00000000000000000000000000000001",
          spanId: "0000000000000001",
          name: "my-operation",
          kind: 1,
          startTimeUnixNano: "1000000000000000000",
          endTimeUnixNano: "2000000000000000000",
          attributes: [
            { key: "http.method", value: { stringValue: "GET" } },
            { key: "http.status_code", value: { intValue: "200" } }
          ]
        }]
      }]
    }]
  }, null, 2),
  metrics: JSON.stringify({
    resourceMetrics: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "my-service" } }] },
      scopeMetrics: [{
        scope: {},
        metrics: [{
          name: "http.request.duration",
          unit: "ms",
          gauge: {
            dataPoints: [{
              timeUnixNano: "1000000000000000000",
              asDouble: 42.5,
              attributes: [{ key: "http.method", value: { stringValue: "GET" } }]
            }]
          }
        }]
      }]
    }]
  }, null, 2),
};

export class DryRunPanel {
  private static instance: DryRunPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  /** Statements last shown in the panel (whole .ottl file, or the YAML block at the cursor). */
  private currentStatements = "";

  private constructor(
    _context: vscode.ExtensionContext
  ) {
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, PANEL_TITLE, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    }, {
      enableScripts: true,
      localResourceRoots: [],
    });

    this.panel.webview.html = buildHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg: { type: string; signal?: string; payload?: string }) => {
        if (msg.type === "run") {
          this.handleRun(msg.signal ?? "logs", msg.payload ?? "");
        } else if (msg.type === "ready") {
          this.pushStatements();
        }
      },
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // Re-push statements when the active editor changes, or when the cursor moves
    // to a different transform block within a Collector YAML file.
    vscode.window.onDidChangeActiveTextEditor(
      () => this.pushStatements(),
      undefined,
      this.disposables
    );
    vscode.window.onDidChangeTextEditorSelection(
      (e) => { if (e.textEditor === vscode.window.activeTextEditor) this.pushStatements(); },
      undefined,
      this.disposables
    );
  }

  static show(context: vscode.ExtensionContext): void {
    if (DryRunPanel.instance) {
      DryRunPanel.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    DryRunPanel.instance = new DryRunPanel(context);
  }

  /**
   * Gather the OTTL statements to run from the active editor:
   * a whole `.ottl` file, or the transform block at the cursor in a Collector YAML.
   */
  private collectInput(editor: vscode.TextEditor | undefined): { text: string; signal: string | null } {
    if (!editor) return { text: "", signal: null };
    const doc = editor.document;
    if (doc.languageId === "ottl") return { text: doc.getText(), signal: null };
    if (doc.languageId === "yaml" || doc.languageId === "yml") {
      const r = collectStatementsForDryRun(doc.getText(), editor.selection.active.line);
      return { text: r.statements, signal: r.signal };
    }
    return { text: "", signal: null };
  }

  private pushStatements(): void {
    const editor = vscode.window.activeTextEditor;
    // When focus moves to the dry-run panel itself, there is no active text editor.
    // Keep the statements we last captured instead of wiping them (otherwise clicking
    // Run would find nothing to execute).
    if (!editor) return;
    const filename = editor.document.fileName.split(/[\\/]/).pop() ?? "";
    const { text, signal } = this.collectInput(editor);
    this.currentStatements = text;
    void this.panel.webview.postMessage({ type: "statements", text, filename, signal });
  }

  private handleRun(signal: string, payload: string): void {
    // Re-collect in case the cursor moved to a different block since the last push.
    const statements = this.collectInput(vscode.window.activeTextEditor).text || this.currentStatements;
    if (!statements.trim()) {
      void this.panel.webview.postMessage({
        type: "result",
        ok: false,
        error: "No OTTL statements found. Open a .ottl file, or put your cursor inside a transform block in your Collector YAML.",
      });
      return;
    }
    const result = evalOTTL(statements, signal, payload);
    void this.panel.webview.postMessage({
      type: "result",
      ok: result.ok,
      output: result.output ? prettyJSON(result.output) : undefined,
      error: result.error,
      executionMs: result.executionMs,
    });
  }

  private dispose(): void {
    DryRunPanel.instance = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}

function prettyJSON(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function buildHtml(): string {
  const defaultPayloads = JSON.stringify(DEFAULT_PAYLOAD);
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 12px 16px;
  }
  h2 { margin: 0 0 8px; font-size: 1.1em; font-weight: 600; }
  #file-info { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-bottom: 10px; }
  #controls {
    display: flex; align-items: center; gap: 10px; margin-bottom: 12px;
    padding-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border);
  }
  label { font-size: 0.9em; }
  select {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    padding: 3px 6px; border-radius: 2px; font-size: 0.9em;
  }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 5px 14px; border-radius: 2px;
    cursor: pointer; font-size: 0.9em;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  #exec-time { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  #main { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .pane-label {
    font-size: 0.8em; font-weight: 600; text-transform: uppercase;
    color: var(--vscode-descriptionForeground); margin-bottom: 4px; letter-spacing: 0.05em;
  }
  #statements-box {
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 2px; padding: 8px; font-family: var(--vscode-editor-font-family);
    font-size: 0.85em; max-height: 140px; overflow-y: auto;
    white-space: pre; margin-bottom: 10px; color: var(--vscode-foreground);
  }
  #statements-empty {
    font-style: italic; color: var(--vscode-descriptionForeground); font-size: 0.85em;
    margin-bottom: 10px;
  }
  textarea {
    width: 100%; resize: vertical;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 2px; padding: 6px; font-family: var(--vscode-editor-font-family);
    font-size: 0.85em; outline: none;
  }
  textarea:focus { border-color: var(--vscode-focusBorder); }
  #output-area {
    font-family: var(--vscode-editor-font-family); font-size: 0.85em;
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border); border-radius: 2px;
    padding: 8px; min-height: 200px; white-space: pre; overflow: auto;
    color: var(--vscode-foreground);
  }
  #error-box {
    display: none; background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    color: var(--vscode-errorForeground, #f48771);
    border-radius: 2px; padding: 8px; font-size: 0.85em;
    font-family: var(--vscode-editor-font-family); white-space: pre-wrap;
    margin-bottom: 6px;
  }
  #placeholder { color: var(--vscode-descriptionForeground); font-style: italic; }
</style>
</head>
<body>
<h2>OTTL Dry Run</h2>
<div id="file-info">Active file: <span id="filename">—</span></div>

<div id="controls">
  <label>Signal:
    <select id="signal">
      <option value="logs">Logs</option>
      <option value="traces">Traces</option>
      <option value="metrics">Metrics</option>
    </select>
  </label>
  <button id="run-btn">▶ Run</button>
  <span id="exec-time"></span>
</div>

<div id="main">
  <div id="left">
    <div class="pane-label">OTTL Statements (active file)</div>
    <div id="statements-box" style="display:none"></div>
    <div id="statements-empty">Open a .ottl file, or place your cursor in a transform block in your Collector YAML.</div>
    <div class="pane-label" style="margin-top:8px">Sample Payload (OTLP JSON)</div>
    <textarea id="payload" rows="14" spellcheck="false"></textarea>
  </div>
  <div id="right">
    <div class="pane-label">Output (after transformation)</div>
    <div id="error-box"></div>
    <div id="output-area"><span id="placeholder">Click ▶ Run to see the transformed payload.</span></div>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();
const defaults = ${defaultPayloads};

const signalEl = document.getElementById('signal');
const payloadEl = document.getElementById('payload');
const runBtn = document.getElementById('run-btn');
const outputEl = document.getElementById('output-area');
const errorBox = document.getElementById('error-box');
const execTime = document.getElementById('exec-time');
const statementsBox = document.getElementById('statements-box');
const statementsEmpty = document.getElementById('statements-empty');
const filenameEl = document.getElementById('filename');

// Populate default payload for current signal.
payloadEl.value = defaults[signalEl.value];
signalEl.addEventListener('change', () => {
  payloadEl.value = defaults[signalEl.value];
  clearOutput();
});

runBtn.addEventListener('click', () => {
  runBtn.disabled = true;
  execTime.textContent = '';
  vscode.postMessage({ type: 'run', signal: signalEl.value, payload: payloadEl.value });
});

function clearOutput() {
  outputEl.innerHTML = '<span id="placeholder">Click ▶ Run to see the transformed payload.</span>';
  errorBox.style.display = 'none';
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'statements') {
    if (msg.text) {
      statementsBox.textContent = msg.text;
      statementsBox.style.display = 'block';
      statementsEmpty.style.display = 'none';
      filenameEl.textContent = msg.filename;
      // Preselect the block's signal (from Collector YAML) and load its default payload.
      if (msg.signal && ['logs','traces','metrics'].includes(msg.signal)) {
        signalEl.value = msg.signal;
        payloadEl.value = defaults[signalEl.value];
      }
    } else {
      statementsBox.style.display = 'none';
      statementsEmpty.style.display = 'block';
      filenameEl.textContent = '—';
    }
    clearOutput();
  } else if (msg.type === 'result') {
    runBtn.disabled = false;
    if (msg.ok) {
      errorBox.style.display = 'none';
      outputEl.textContent = msg.output ?? '';
      execTime.textContent = msg.executionMs != null ? msg.executionMs + ' ms' : '';
    } else {
      errorBox.textContent = msg.error ?? 'Unknown error';
      errorBox.style.display = 'block';
      outputEl.innerHTML = '';
      execTime.textContent = '';
    }
  }
});

// Signal readiness so the extension can push the initial statements.
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
