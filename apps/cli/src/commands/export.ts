import { basename, join, relative, resolve } from 'node:path';

import {
  authoredFileName,
  detectAndParse,
  readAuthoredFile,
  resolveById,
  resolveProjectConfigDir,
  serializeAuthored,
  writeAuthoredFile,
} from '../authoring/authoring.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { stringifyJsonLine, stripTerminalControls } from '../render/sanitize.js';

export interface ExportCommandArgs {
  /** The in-file `id` of the workflow/agent to export (resolved across both project catalogs). */
  readonly id: string;
  /** `--out <path>` (absolute, or relative to cwd); default is `<id>.relavium.yaml` / `<id>.agent.yaml` in cwd. */
  readonly out?: string;
  /** `--force`: overwrite an existing file at the target; without it an existing file is a clean exit-2 fault. */
  readonly force: boolean;
}

export interface ExportCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
}

/**
 * `relavium export <id>` (2.J) — write a portable, canonical copy of a project workflow or agent. It
 * resolves `<id>` across BOTH catalogs, **re-serializes from the validated AST** (`serializeWorkflow` /
 * `serializeAgent`) so the output drops authored comments and preserves authored values. Relavium does not
 * insert resolved provider keys, but arbitrary authored strings may contain pasted credentials or other
 * sensitive content. Review the copy before sharing. MCP `env` credentials should use `{{secrets.*}}`
 * placeholders; serialization does not scrub literals
 * ([keychain-and-secrets.md](../../../../docs/reference/desktop/keychain-and-secrets.md)).
 * The default target is `<id>.<suffix>` in cwd; `--out` overrides, `--force` overwrites. **Surface-agnostic**:
 * pure YAML I/O, never the keychain or run state. An unknown/ambiguous id, an invalid source file, or an
 * existing target without `--force` is a clean exit-2 {@link CliError}.
 */
export function exportCommand(args: ExportCommandArgs, deps: ExportCommandDeps): ExitCode {
  const cwd = deps.global.cwd;
  const projectConfigDir = resolveProjectConfigDir(cwd);
  const { path } = resolveById({ projectConfigDir, cwd, id: args.id });

  const displayPath = relative(cwd, path);
  const yaml = readAuthoredFile(path, displayPath);
  // Re-validate the source (it was valid at the catalog scan) to get the AST before canonical serialization.
  // This validates structure, not secrecy. The basename hint picks the parser for a precise error.
  const parsed = detectAndParse(yaml, displayPath, basename(path));

  const target =
    args.out === undefined
      ? join(cwd, authoredFileName(parsed.kind, parsed.slug))
      : resolve(cwd, args.out);
  const targetDisplay = relative(cwd, target);
  writeAuthoredFile(target, targetDisplay, serializeAuthored(parsed), args.force);

  // Emit the cwd-relative path in both modes — the same contract `import` uses, so a script consuming either
  // command's `--json` gets the same path shape (and no absolute filesystem tree leaks into the output).
  if (deps.global.json) {
    // `stringifyJsonLine`, not a bare `JSON.stringify` (CR-03). `targetDisplay` derives from the user-typed
    // `--out`, so unlike `import --json`'s payload — whose `slug` is kebab-schema-validated and cannot carry
    // one — it really can hold a C1 control or a bidi override, which `JSON.stringify` leaves raw.
    deps.io.writeOut(
      `${stringifyJsonLine({ id: parsed.slug, kind: parsed.kind, path: targetDisplay })}\n`,
    );
  } else {
    // The human line needs the terminal floor for the same reason: every dynamic string written to a terminal
    // passes `stripTerminalControls` (security-review.md), and this one is user-supplied.
    deps.io.writeOut(
      `Exported ${parsed.kind} '${parsed.slug}' to ${stripTerminalControls(targetDisplay)}\n`,
    );
  }
  return EXIT_CODES.success;
}
