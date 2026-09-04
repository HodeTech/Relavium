import { basename, isAbsolute, relative } from 'node:path';

/**
 * A user-facing label for a resolved file: relative to the caller's cwd, else its bare filename.
 *
 * The parsers put this label into their error messages, and the CLI promotes those messages to the user
 * (`process/errors.ts` maps a `WorkflowParseError` / `AgentParseError` to `invalid_invocation`). An absolute
 * path there is what the error contract forbids — it discloses the operator's directory layout in a message
 * that also reaches logs and `--json` consumers.
 *
 * **`relative()` alone is not enough, which is why this is a function and not an inline call.** It returns
 * an ABSOLUTE path across Windows drives and an empty string when the two paths are equal, either of which
 * puts back exactly what the label exists to keep out. A basename is the fallback: enough to identify the
 * file, disclosing no structure.
 *
 * It lives here rather than beside its first caller because it had two call sites within one change and the
 * second one was written without the guard — the same disclosure left open twice in the same PR.
 */
export function sourceLabel(cwd: string, filePath: string): string {
  const rel = relative(cwd, filePath);
  return rel !== '' && !isAbsolute(rel) ? rel : basename(filePath);
}
