/**
 * The run scope the interpolation resolver reads from, and the host capabilities it may call (1.L2).
 *
 * `RunScope` is plain, immutable data the engine assembles as a run progresses: 1.M builds the
 * per-node inputs, 1.O fills `outputs` as nodes complete, and `resolveContext` (this module's sibling)
 * produces the frozen `ctx` snapshot. The resolver only reads it — it never mutates the scope.
 *
 * `ResolverCapabilities` is the **purity seam**. The engine has zero platform-specific imports
 * (CLAUDE.md rule 5), so any filter that needs I/O — today only `read_file` — calls a host-supplied
 * function instead of reaching for `node:fs`. The host (CLI / desktop / VS Code) owns the capability
 * and its workspace-root sandbox; the engine passes the authored argument through verbatim. A
 * capability is optional: a template that needs an absent one fails with a typed `InterpolationError`,
 * never a crash, and never a platform import sneaking into `packages/core`.
 *
 * There is deliberately **no `secrets` namespace** here. The v1.0 authored surface
 * (workflow-yaml-spec.md §Context-and-interpolation) exposes `inputs`, `ctx`, and `run.outputs`; a
 * `secret`-typed input lives in `inputs` like any other value. The parse-time taint gate
 * (`analyzeSecretTaint`) has already rejected every secret reference from agent/human text before a
 * scope is ever resolved, so a secret value never flows through the text path by construction.
 */

/** The run-scope namespaces a `{{ … }}` reference may read against. */
export interface RunScope {
  /** Declared workflow inputs, resolved to their values — `{{inputs.<name>}}`. */
  readonly inputs: Readonly<Record<string, unknown>>;
  /** The eagerly-resolved, frozen context snapshot — `{{ctx.<key>}}`. */
  readonly ctx: Readonly<Record<string, unknown>>;
  /** Completed node outputs, keyed by node id — `{{run.outputs["<id>"]}}`. */
  readonly outputs: Readonly<Record<string, unknown>>;
}

/** Side-effecting capabilities the host injects because the pure engine cannot implement them. */
export interface ResolverCapabilities {
  /**
   * Read a workspace file's text for the `read_file` filter. The engine passes the authored path
   * through **unchanged** and never touches the filesystem itself, so the host reader **must jail to
   * the workspace root and reject path traversal** — that sandbox duty is delegated, not optional, and
   * is a mandatory-review trigger (docs/standards/security-review.md §When a review is mandatory). May
   * resolve synchronously or asynchronously. When absent, a `read_file` filter fails with a typed
   * `InterpolationError` (`read_file_unavailable`), never a crash.
   */
  readonly readFile?: (path: string) => string | Promise<string>;
}
