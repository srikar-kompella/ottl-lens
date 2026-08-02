/**
 * Component-scoped OTTL functions that are NOT in pkg/ottl/ottlfuncs (the catalog
 * generator's source) but ARE valid in specific components. Merged into the
 * known-function set by the linter so we don't false-positive on them.
 *
 * Discovered by scanning real collector configs (scripts/scan.mjs). Keep additions
 * evidence-based — each entry should be a real function shipped by a component.
 */

export const EXTRA_KNOWN: ReadonlySet<string> = new Set([
  // routing connector — decides which pipeline(s) a signal is sent to.
  "route",
]);
