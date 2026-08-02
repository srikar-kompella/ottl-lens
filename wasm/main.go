//go:build js && wasm

// Build: cd wasm && GOOS=js GOARCH=wasm go build -o ../media/ottl.wasm .
// Then:  cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" ../media/wasm_exec.js
// Or just run: npm run build:wasm

package main

import (
	"syscall/js"

	"ottl-vscode/wasm/internal"
)

func main() {
	js.Global().Set("ottlEval", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) != 3 {
			return `{"ok":false,"error":"ottlEval expects (statements, signal, payloadJSON)"}`
		}
		return internal.Eval(args[0].String(), args[1].String(), args[2].String())
	}))
	// Block forever — the Go scheduler must stay alive for JS to call ottlEval.
	<-make(chan struct{})
}
