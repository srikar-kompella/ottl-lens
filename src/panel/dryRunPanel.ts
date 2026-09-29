import * as vscode from "vscode";
import { evalOTTL } from "../ottl/wasmRunner";
import { collectStatementsForDryRun } from "../ottl/yaml";
import { traceStatements, summarize, type ErrorMode } from "../ottl/trace";
import { SAMPLES, samplePayloadText } from "../ottl/samples";
import { normalizePayloadInput, describeConversion } from "../ottl/payload";

const PANEL_TITLE = "OTTL Dry Run";
const VIEW_TYPE = "ottl.dryRun";
/** Payload files larger than this are refused; the dry-run is for samples, not archives. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

type InboundMessage =
  | { type: "ready" }
  | { type: "run"; signal?: string; payload?: string; errorMode?: string }
  | { type: "openFile" };

export class DryRunPanel {
  private static instance: DryRunPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  /** Statements last shown in the panel (whole .ottl file, or the YAML block at the cursor). */
  private currentStatements = "";
  /** Signal of the YAML transform block the statements came from, if any. */
  private currentBlockSignal: string | null = null;

  private constructor(_context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, PANEL_TITLE, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    }, {
      enableScripts: true,
      localResourceRoots: [],
    });

    this.panel.webview.html = buildHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg: InboundMessage) => {
        if (msg.type === "run") {
          this.handleRun(msg.signal ?? "logs", msg.payload ?? "", (msg.errorMode as ErrorMode) ?? "propagate");
        } else if (msg.type === "ready") {
          this.pushStatements();
        } else if (msg.type === "openFile") {
          void this.openPayloadFile();
        }
      },
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // Re-push statements when the active editor changes, or when the cursor moves
    // to a different transform block within a Collector YAML file.
    vscode.window.onDidChangeActiveTextEditor(() => this.pushStatements(), undefined, this.disposables);
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
    // Keep the statements we last captured instead of wiping them.
    if (!editor) return;
    const filename = editor.document.fileName.split(/[\\/]/).pop() ?? "";
    const { text, signal } = this.collectInput(editor);
    this.currentStatements = text;
    this.currentBlockSignal = signal;
    void this.panel.webview.postMessage({ type: "statements", text, filename, signal });
  }

  private handleRun(selectedSignal: string, payloadText: string, errorMode: ErrorMode): void {
    // Re-collect in case the cursor moved to a different block since the last push.
    const fresh = this.collectInput(vscode.window.activeTextEditor);
    const statements = fresh.text || this.currentStatements;
    const blockSignal = fresh.text ? fresh.signal : this.currentBlockSignal;
    if (!statements.trim()) {
      this.post({
        type: "result",
        ok: false,
        error: "No OTTL statements found. Open a .ottl file, or put your cursor inside a transform block in your Collector YAML.",
      });
      return;
    }

    // Accept whatever was pasted: OTLP JSON, JSON Lines, or debug exporter text.
    const input = normalizePayloadInput(payloadText);
    if (!input.ok || !input.json || !input.signal) {
      this.post({ type: "result", ok: false, error: input.error ?? "Could not read the payload." });
      return;
    }

    const signal = input.signal;
    const notes: string[] = [];
    const converted = describeConversion(input);
    if (converted) notes.push(converted);
    if (signal !== selectedSignal) {
      notes.push(`The payload is ${signal} data, so it ran as ${signal} (the dropdown said ${selectedSignal}).`);
    }
    if (blockSignal && blockSignal !== signal) {
      notes.push(
        `Heads up: this transform block handles ${blockSignal}, but the payload is ${signal}. ` +
        `Statements written for ${blockSignal} will not find ${blockSignal} fields in ${signal} data.`
      );
    }
    notes.push(...input.warnings);

    // Show the converted JSON in the box, so the user can see and edit what actually ran.
    if (input.source !== "json" || signal !== selectedSignal) {
      this.post({ type: "payload", json: input.json, signal });
    }

    const started = Date.now();
    const trace = traceStatements(statements, signal, input.json, evalOTTL, errorMode);
    const executionMs = Date.now() - started;

    if (trace.error) {
      this.post({ type: "result", ok: false, error: trace.error, notes });
      return;
    }

    this.post({
      type: "result",
      ok: trace.ok,
      steps: trace.steps,
      summary: summarize(trace),
      noEffectCount: trace.noEffectCount,
      output: trace.finalOutput ? prettyJSON(trace.finalOutput) : undefined,
      executionMs,
      notes,
    });
  }

  /** Load a payload from disk: OTLP JSON, file-exporter JSON Lines, or saved debug output. */
  private async openPayloadFile(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Load payload",
      filters: { "Telemetry payloads": ["json", "jsonl", "ndjson", "log", "txt"], "All files": ["*"] },
    });
    const uri = picked?.[0];
    if (!uri) return;

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) {
        this.post({
          type: "result",
          ok: false,
          error: `That file is ${(stat.size / 1024 / 1024).toFixed(1)} MB. The dry-run is for sample payloads; trim it under 5 MB.`,
        });
        return;
      }
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      const input = normalizePayloadInput(text);
      if (!input.ok || !input.json) {
        this.post({ type: "result", ok: false, error: input.error ?? "Could not read that file as a payload." });
        return;
      }
      const name = uri.path.split("/").pop() ?? "file";
      const note = describeConversion(input) ?? `Loaded ${name}.`;
      this.post({ type: "payload", json: input.json, signal: input.signal, note, warnings: input.warnings });
    } catch (e) {
      this.post({ type: "result", ok: false, error: `Could not read the file: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private post(message: Record<string, unknown>): void {
    void this.panel.webview.postMessage(message);
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

/** Serialize for inline <script>: escape "<" so no payload text can close the tag. */
function inlineJSON(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Exported for rendering checks; the panel is its only runtime caller. */
export function buildHtml(): string {
  const samples = inlineJSON(
    SAMPLES.map((s) => ({ id: s.id, label: s.label, signal: s.signal, hint: s.hint, text: samplePayloadText(s) }))
  );
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
  code { font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
  #file-info { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-bottom: 10px; }
  #controls {
    display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 12px;
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
  button.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border); padding: 3px 10px; font-size: 0.82em;
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  #exec-time { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  /* minmax(0, …) lets columns shrink below their content; long statements scroll inside their box. */
  #main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
  /* A "Beside" editor column is often narrow: stack the panes instead of crushing the results. */
  @media (max-width: 760px) {
    #main { grid-template-columns: minmax(0, 1fr); }
    #right { border-top: 1px solid var(--vscode-panel-border); padding-top: 10px; }
  }
  .pane-label {
    font-size: 0.8em; font-weight: 600; text-transform: uppercase;
    color: var(--vscode-descriptionForeground); margin-bottom: 4px; letter-spacing: 0.05em;
  }
  .payload-head { display: flex; align-items: center; gap: 6px; margin: 8px 0 4px; flex-wrap: wrap; }
  .payload-head .pane-label { margin: 0 4px 0 0; }
  #sample { max-width: 60%; }
  #sample-hint, .help { font-size: 0.78em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; line-height: 1.4; }
  .help { margin-top: 4px; }
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
  #notes .note {
    font-size: 0.8em; padding: 4px 8px; margin-bottom: 4px; border-radius: 2px;
    background: var(--vscode-inputValidation-infoBackground, rgba(55,148,255,0.12));
    border-left: 2px solid var(--vscode-inputValidation-infoBorder, #3794ff);
  }
  #placeholder { color: var(--vscode-descriptionForeground); font-style: italic; }

  /* --- stepped trace --- */
  #summary { font-size: 0.85em; margin-bottom: 8px; color: var(--vscode-descriptionForeground); }
  #summary strong { color: var(--vscode-foreground); }
  .tabs { display: flex; gap: 4px; margin-bottom: 6px; }
  .tab {
    background: none; border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground);
    padding: 3px 10px; font-size: 0.8em; border-radius: 2px; cursor: pointer;
  }
  .tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .step {
    border: 1px solid var(--vscode-panel-border); border-left-width: 3px;
    border-radius: 2px; padding: 6px 8px; margin-bottom: 6px;
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
  }
  .step.changed     { border-left-color: #3fb950; }
  .step.no-effect   { border-left-color: #d29922; }
  .step.not-matched { border-left-color: #8b949e; }
  .step.error       { border-left-color: #f85149; }
  .step-head { display: flex; align-items: baseline; gap: 8px; }
  .step-num { font-size: 0.75em; color: var(--vscode-descriptionForeground); min-width: 1.4em; }
  .step-stmt {
    font-family: var(--vscode-editor-font-family); font-size: 0.82em;
    white-space: pre-wrap; word-break: break-word; flex: 1;
  }
  .badge {
    font-size: 0.68em; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 1px 6px; border-radius: 8px; white-space: nowrap; font-weight: 600;
  }
  .badge.changed     { background: rgba(63,185,80,0.18);  color: #3fb950; }
  .badge.no-effect   { background: rgba(210,153,34,0.18); color: #d29922; }
  .badge.not-matched { background: rgba(139,148,158,0.2); color: #8b949e; }
  .badge.error       { background: rgba(248,81,73,0.18);  color: #f85149; }
  .step-note { font-size: 0.8em; margin-top: 5px; color: var(--vscode-descriptionForeground); line-height: 1.4; }
  .step-note.warn { color: #d29922; }
  .step-note.danger { color: #f85149; font-weight: 500; }
  .step-note.explain { color: var(--vscode-foreground); }
  .raw-error { margin-top: 4px; font-size: 0.78em; }
  .raw-error summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
  .raw-error .step-note { font-family: var(--vscode-editor-font-family); word-break: break-word; }
  .diff { margin-top: 5px; font-family: var(--vscode-editor-font-family); font-size: 0.78em; }
  .diff-row { padding: 1px 0; white-space: pre-wrap; word-break: break-word; }
  .diff-row.added   { color: #3fb950; }
  .diff-row.removed { color: #f85149; }
  .diff-row.changed { color: var(--vscode-foreground); }
  .diff-sigil { display: inline-block; width: 1.1em; font-weight: 700; }
  .diff-value { color: var(--vscode-foreground); }
  .diff-row.removed .diff-value { color: inherit; opacity: 0.8; }
  .diff-sep { opacity: 0.7; }
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
  <label>error_mode:
    <select id="error-mode" title="How the collector reacts when a statement errors. OTTL's default is propagate, which discards the record.">
      <option value="propagate">propagate (default)</option>
      <option value="ignore">ignore</option>
      <option value="silent">silent</option>
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

    <div class="payload-head">
      <span class="pane-label">Payload</span>
      <select id="sample" title="Realistic sample payloads for the selected signal"></select>
      <button id="open-file" class="secondary" title="Load OTLP JSON, file-exporter JSON Lines, or saved debug exporter output">Open file…</button>
    </div>
    <div id="sample-hint"></div>
    <textarea id="payload" rows="14" spellcheck="false"></textarea>
    <div class="help">
      Paste OTLP JSON, JSON Lines from the file exporter, or raw <code>debug</code> exporter output
      (<code>verbosity: detailed</code>, straight from <code>docker logs</code>). It's converted when you run.
    </div>
  </div>
  <div id="right">
    <div class="pane-label">What each statement did</div>
    <div id="error-box"></div>
    <div id="notes"></div>
    <div id="summary"></div>
    <div class="tabs">
      <button class="tab active" id="tab-trace">Per-statement</button>
      <button class="tab" id="tab-output">Final payload</button>
    </div>
    <div id="trace-area"><span id="placeholder">Click ▶ Run to see what each statement actually does.</span></div>
    <div id="output-area" style="display:none"></div>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();
const SAMPLES = ${samples};
const CUSTOM = '';

const signalEl = document.getElementById('signal');
const errorModeEl = document.getElementById('error-mode');
const sampleEl = document.getElementById('sample');
const sampleHintEl = document.getElementById('sample-hint');
const openFileBtn = document.getElementById('open-file');
const payloadEl = document.getElementById('payload');
const runBtn = document.getElementById('run-btn');
const outputEl = document.getElementById('output-area');
const traceEl = document.getElementById('trace-area');
const summaryEl = document.getElementById('summary');
const notesEl = document.getElementById('notes');
const errorBox = document.getElementById('error-box');
const execTime = document.getElementById('exec-time');
const statementsBox = document.getElementById('statements-box');
const statementsEmpty = document.getElementById('statements-empty');
const filenameEl = document.getElementById('filename');
const tabTrace = document.getElementById('tab-trace');
const tabOutput = document.getElementById('tab-output');

let lastStatements = null;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** Like el(), but renders \`code\` spans as <code> (built as DOM nodes, never innerHTML). */
function richEl(tag, cls, text) {
  const n = el(tag, cls);
  String(text).split(/(\`[^\`]+\`)/).forEach((part) => {
    if (/^\`[^\`]+\`$/.test(part)) n.appendChild(el('code', '', part.slice(1, -1)));
    else if (part) n.appendChild(document.createTextNode(part));
  });
  return n;
}

/* ---------------- payload: samples, custom paste, files ---------------- */

function populateSamples(signal) {
  sampleEl.innerHTML = '';
  for (const s of SAMPLES.filter((x) => x.signal === signal)) {
    const o = el('option', '', s.label);
    o.value = s.id;
    sampleEl.appendChild(o);
  }
  const custom = el('option', '', 'Custom / pasted');
  custom.value = CUSTOM;
  sampleEl.appendChild(custom);
}

function loadSample(id) {
  const s = SAMPLES.find((x) => x.id === id);
  if (!s) return;
  sampleEl.value = s.id;
  payloadEl.value = s.text;
  sampleHintEl.textContent = s.hint;
}

function loadDefaultSample(signal) {
  populateSamples(signal);
  const first = SAMPLES.find((x) => x.signal === signal);
  if (first) loadSample(first.id);
}

/** Switch signal. Only replace the payload if the user hasn't typed their own. */
function setSignal(signal, opts) {
  const keepPayload = opts && opts.keepPayload;
  if (signalEl.value === signal && sampleEl.options.length) return;
  signalEl.value = signal;
  if (keepPayload || sampleEl.value === CUSTOM) {
    populateSamples(signal);
    sampleEl.value = CUSTOM;
    sampleHintEl.textContent = '';
  } else {
    loadDefaultSample(signal);
  }
}

loadDefaultSample(signalEl.value);

signalEl.addEventListener('change', () => {
  loadDefaultSample(signalEl.value);
  clearOutput();
});
sampleEl.addEventListener('change', () => {
  if (sampleEl.value !== CUSTOM) loadSample(sampleEl.value);
  else sampleHintEl.textContent = '';
  clearOutput();
});
payloadEl.addEventListener('input', () => {
  if (sampleEl.value !== CUSTOM) {
    sampleEl.value = CUSTOM;
    sampleHintEl.textContent = '';
  }
});
openFileBtn.addEventListener('click', () => vscode.postMessage({ type: 'openFile' }));

/* ---------------- results ---------------- */

function selectTab(which) {
  const isTrace = which === 'trace';
  tabTrace.classList.toggle('active', isTrace);
  tabOutput.classList.toggle('active', !isTrace);
  traceEl.style.display = isTrace ? 'block' : 'none';
  outputEl.style.display = isTrace ? 'none' : 'block';
}
tabTrace.addEventListener('click', () => selectTab('trace'));
tabOutput.addEventListener('click', () => selectTab('output'));

const VERDICT_LABEL = {
  'changed': 'changed',
  'no-effect': 'no effect',
  'not-matched': 'matched nothing',
  'error': 'error'
};

function renderNotes(notes) {
  notesEl.innerHTML = '';
  for (const n of notes || []) notesEl.appendChild(richEl('div', 'note', n));
}

/** Prefer the OTTL-language presentation; fall back to raw OTLP paths. */
function diffRows(s) {
  if (s.display && s.display.length) return s.display;
  return (s.diff || []).map((d) => ({
    kind: d.kind,
    label: d.path,
    text: d.kind === 'changed' ? JSON.stringify(d.before) + ' → ' + JSON.stringify(d.after)
        : JSON.stringify(d.kind === 'added' ? d.after : d.before)
  }));
}

function renderDiff(rows) {
  const wrap = el('div', 'diff');
  const shown = rows.slice(0, 12);
  for (const d of shown) {
    const sigil = d.kind === 'added' ? '+' : d.kind === 'removed' ? '−' : '~';
    const row = el('div', 'diff-row ' + d.kind);
    row.appendChild(el('span', 'diff-sigil', sigil));
    row.appendChild(el('span', 'diff-label', d.label));
    row.appendChild(el('span', 'diff-sep', d.kind === 'changed' ? ': ' : ' = '));
    row.appendChild(el('span', 'diff-value', d.text));
    wrap.appendChild(row);
  }
  if (rows.length > shown.length) {
    wrap.appendChild(el('div', 'diff-row', '… and ' + (rows.length - shown.length) + ' more'));
  }
  return wrap;
}

function renderTrace(steps) {
  traceEl.innerHTML = '';
  if (!steps || steps.length === 0) {
    traceEl.appendChild(el('span', '', 'Nothing to show.'));
    return;
  }
  for (const s of steps) {
    const card = el('div', 'step ' + s.verdict);
    const head = el('div', 'step-head');
    head.appendChild(el('span', 'step-num', '#' + (s.index + 1)));
    head.appendChild(el('span', 'step-stmt', s.statement));
    head.appendChild(el('span', 'badge ' + s.verdict, VERDICT_LABEL[s.verdict] || s.verdict));
    card.appendChild(head);
    if (s.verdict === 'changed') {
      const rows = diffRows(s);
      if (rows.length) card.appendChild(renderDiff(rows));
    }
    if (s.note) card.appendChild(richEl('div', 'step-note ' + (s.verdict === 'no-effect' ? 'warn' : ''), s.note));
    if (s.explanation) card.appendChild(richEl('div', 'step-note explain', s.explanation));
    if (s.consequence) card.appendChild(el('div', 'step-note danger', s.consequence));
    if (s.error) {
      // Raw engine message: kept for accuracy, collapsed when we have a better explanation.
      if (s.explanation) {
        const det = el('details', 'raw-error');
        det.appendChild(el('summary', '', 'Engine message'));
        det.appendChild(el('div', 'step-note', s.error));
        card.appendChild(det);
      } else {
        card.appendChild(el('div', 'step-note danger', s.error));
      }
    }
    traceEl.appendChild(card);
  }
}

function clearOutput() {
  traceEl.innerHTML = '<span id="placeholder">Click ▶ Run to see what each statement actually does.</span>';
  outputEl.textContent = '';
  summaryEl.textContent = '';
  notesEl.innerHTML = '';
  errorBox.style.display = 'none';
  execTime.textContent = '';
  selectTab('trace');
}

runBtn.addEventListener('click', () => {
  runBtn.disabled = true;
  execTime.textContent = '';
  vscode.postMessage({
    type: 'run',
    signal: signalEl.value,
    payload: payloadEl.value,
    errorMode: errorModeEl.value
  });
});

window.addEventListener('message', (event) => {
  const msg = event.data;

  if (msg.type === 'statements') {
    if (msg.text) {
      statementsBox.textContent = msg.text;
      statementsBox.style.display = 'block';
      statementsEmpty.style.display = 'none';
      filenameEl.textContent = msg.filename;
      // Follow the block's signal, but never overwrite a payload the user pasted.
      if (msg.signal && ['logs', 'traces', 'metrics'].includes(msg.signal)) setSignal(msg.signal);
    } else {
      statementsBox.style.display = 'none';
      statementsEmpty.style.display = 'block';
      filenameEl.textContent = '—';
    }
    // Moving the cursor re-sends statements; only clear results if they changed.
    if (msg.text !== lastStatements) clearOutput();
    lastStatements = msg.text;
    return;
  }

  if (msg.type === 'payload') {
    payloadEl.value = msg.json;
    if (msg.signal) setSignal(msg.signal, { keepPayload: true });
    sampleEl.value = CUSTOM;
    sampleHintEl.textContent = '';
    if (msg.note || (msg.warnings && msg.warnings.length)) {
      renderNotes([msg.note].concat(msg.warnings || []).filter(Boolean));
    }
    return;
  }

  if (msg.type === 'result') {
    runBtn.disabled = false;
    execTime.textContent = msg.executionMs != null ? msg.executionMs + ' ms' : '';
    renderNotes(msg.notes);

    // A fatal problem (no statements, unreadable payload) — nothing to trace.
    if (!msg.steps) {
      errorBox.textContent = msg.error ?? 'Unknown error';
      errorBox.style.display = 'block';
      traceEl.innerHTML = '';
      outputEl.textContent = '';
      summaryEl.textContent = '';
      execTime.textContent = '';
      return;
    }

    errorBox.style.display = 'none';
    renderTrace(msg.steps);
    outputEl.textContent = msg.output ?? '(no output — the block did not run to completion)';

    summaryEl.innerHTML = '';
    summaryEl.appendChild(el('strong', '', msg.summary ?? ''));
    if (msg.noEffectCount > 0) {
      summaryEl.appendChild(document.createTextNode(
        ' — ' + msg.noEffectCount + ' statement' + (msg.noEffectCount === 1 ? '' : 's') +
        ' ran without error but changed nothing.'
      ));
    }
    selectTab('trace');
    revealResults();
  }
});

/** In the stacked (narrow) layout the results sit below the payload; bring them into view. */
function revealResults() {
  if (window.matchMedia('(max-width: 760px)').matches) {
    document.getElementById('right').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// Signal readiness so the extension can push the initial statements.
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
