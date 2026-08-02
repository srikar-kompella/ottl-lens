import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { stripOttlComments } from "./yaml";

export interface DryRunResult {
  ok: boolean;
  output?: string;   // transformed OTLP JSON
  error?: string;
  executionMs?: number;
}

let ready = false;

export async function initWasm(context: vscode.ExtensionContext): Promise<void> {
  if (ready) return;

  const mediaDir = context.asAbsolutePath("media");
  const wasmExecPath = path.join(mediaDir, "wasm_exec.js");
  const wasmBinPath = path.join(mediaDir, "ottl.wasm");

  if (!fs.existsSync(wasmBinPath) || !fs.existsSync(wasmExecPath)) {
    throw new Error("OTTL WASM not built. Run: npm run build:wasm  (requires Go installed)");
  }

  // wasm_exec.js is not a module — require() executes it for its side effect of setting globalThis.Go.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  require(wasmExecPath);

  const go = new (globalThis as unknown as { Go: new () => GoInstance }).Go();
  const wasmBuffer = fs.readFileSync(wasmBinPath);
  // WebAssembly is available in Node.js 12+ but absent from TS's ES2021 lib.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wa = (globalThis as any).WebAssembly as WasmAPI;
  const result = await wa.instantiate(wasmBuffer, go.importObject);

  // go.run() resolves only when Go's main() exits; ours blocks forever, so fire-and-forget.
  void go.run(result.instance);

  // ottlEval is registered synchronously inside Go's main(); poll briefly to confirm.
  await waitFor(() => typeof (globalThis as Record<string, unknown>).ottlEval === "function", 5000);

  ready = true;
}

export function evalOTTL(statements: string, signal: string, payloadJSON: string): DryRunResult {
  if (!ready) {
    return { ok: false, error: "WASM not initialised — open the Dry Run panel first" };
  }
  const fn = (globalThis as Record<string, unknown>).ottlEval as (s: string, sig: string, p: string) => string;
  const clean = stripOttlComments(statements);
  if (!clean.trim()) {
    return { ok: false, error: "No runnable OTTL statements (only comments/blank lines)." };
  }
  try {
    return JSON.parse(fn(clean, signal, payloadJSON)) as DryRunResult;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) { resolve(); }
      else if (Date.now() > deadline) { reject(new Error("Timed out waiting for OTTL WASM")); }
      else { setTimeout(check, 20); }
    };
    check();
  });
}

// Narrow typings for Go WASM glue (WebAssembly not in TS ES2021 lib).
interface WasmAPI {
  instantiate(buffer: Buffer, imports: Record<string, Record<string, unknown>>): Promise<{ instance: WasmInstance }>;
}
interface WasmInstance { exports: Record<string, unknown>; }
interface GoInstance {
  importObject: Record<string, Record<string, unknown>>;
  run(instance: WasmInstance): Promise<void>;
}
