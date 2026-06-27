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
 * `relavium export <id>` (2.J) — write a portable, **share-safe** copy of a project workflow or agent. It
 * resolves `<id>` across BOTH catalogs, **re-serializes from the validated AST** (`serializeWorkflow` /
 * `serializeAgent`) so the output drops any authored comments and carries only `{{secrets.*}}` placeholders —
 * never a resolved secret VALUE (keys live in the OS keychain; [keychain-and-secrets.md](../../../../docs/reference/desktop/keychain-and-secrets.md)).
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
  // Re-validate the source (it was valid at the catalog scan) to get the AST — and reject a now-invalid/leaky
  // file before writing a share-able copy. The basename hint picks the matching parser for a precise error.
  const parsed = detectAndParse(yaml, displayPath, basename(path));

  const target =
    args.out === undefined
      ? join(cwd, authoredFileName(parsed.kind, parsed.slug))
      : resolve(cwd, args.out);
  writeAuthoredFile(target, serializeAuthored(parsed), args.force);

  if (deps.global.json) {
    deps.io.writeOut(`${JSON.stringify({ id: parsed.slug, kind: parsed.kind, path: target })}\n`);
  } else {
    deps.io.writeOut(`Exported ${parsed.kind} '${parsed.slug}' to ${target}\n`);
  }
  return EXIT_CODES.success;
}
