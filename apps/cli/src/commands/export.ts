import { basename, join, relative, resolve } from 'node:path';
import { assertProjectArtifactPath } from '../config/project-directory.js';

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
 * What an export WILL write, worked out and not written: the destination and the canonical content. It is the whole of what the
 * Home's export card shows before it asks, and {@link commitExport} writes exactly this and nothing else.
 */
export interface ExportPlan {
  readonly kind: 'workflow' | 'agent';
  readonly slug: string;
  /** The absolute destination. The human-facing {@link ExportPlan.targetDisplay} is the cwd-relative one. */
  readonly target: string;
  readonly targetDisplay: string;
  /** The canonical re-serialization, as it will be written (UTF-8). */
  readonly content: string;
  /** The bytes {@link ExportPlan.content} takes on disk. */
  readonly bytes: number;
  readonly force: boolean;
}

/**
 * The first half of `relavium export`: resolve `<id>` across BOTH catalogs, read and re-validate the file, work out the destination
 * and re-serialize from the validated AST. Nothing is written. Every refusal that does not need the file system's answer to a write
 * is raised here, as the same exit-2 {@link CliError} the command always raised (an unknown or ambiguous id, an invalid source file,
 * a destination that resolves into global state); an existing target without `--force` and a target that is not a file are the write's
 * to refuse, and {@link commitExport} does.
 */
export function prepareExport(
  args: ExportCommandArgs,
  deps: Pick<ExportCommandDeps, 'global'> & {
    /** The operator home the path rules read, for a caller that is handed one (the Home). The command passes none: the process's own. */
    readonly homeDir?: string | undefined;
  },
): ExportPlan {
  const cwd = deps.global.cwd;
  const home = deps.homeDir;
  const projectConfigDir = resolveProjectConfigDir(cwd, home);
  const { path } = resolveById({
    projectConfigDir,
    cwd,
    id: args.id,
    ...(home === undefined ? {} : { homeDir: home }),
  });

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
  if (args.out === undefined) assertProjectArtifactPath(target, home);
  const content = serializeAuthored(parsed);
  return {
    kind: parsed.kind,
    slug: parsed.slug,
    target,
    targetDisplay,
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    force: args.force,
  };
}

/**
 * The second half: write the plan. Without `force` an existing target is a clean exit-2 {@link CliError} (`wx`, so no check-then-write
 * window), and a target that is not a file is one too ({@link writeAuthoredFile}).
 */
export function commitExport(plan: ExportPlan): void {
  writeAuthoredFile(plan.target, plan.targetDisplay, plan.content, plan.force);
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
 *
 * It is {@link prepareExport} then {@link commitExport}, in that order, and prints after the second: the split lets the Home's export
 * card show the destination between them, and changes nothing the command prints, returns or throws.
 */
export function exportCommand(args: ExportCommandArgs, deps: ExportCommandDeps): ExitCode {
  const plan = prepareExport(args, deps);
  commitExport(plan);
  const { kind, slug, targetDisplay } = plan;

  // Emit the cwd-relative path in both modes — the same contract `import` uses, so a script consuming either
  // command's `--json` gets the same path shape (and no absolute filesystem tree leaks into the output).
  if (deps.global.json) {
    // `stringifyJsonLine`, not a bare `JSON.stringify` (CR-03). `targetDisplay` derives from the user-typed
    // `--out`, so unlike `import --json`'s payload — whose `slug` is kebab-schema-validated and cannot carry
    // one — it really can hold a C1 control or a bidi override, which `JSON.stringify` leaves raw.
    deps.io.writeOut(`${stringifyJsonLine({ id: slug, kind, path: targetDisplay })}\n`);
  } else {
    // The human line needs the terminal floor for the same reason: every dynamic string written to a terminal
    // passes `stripTerminalControls` (security-review.md), and this one is user-supplied.
    deps.io.writeOut(`Exported ${kind} '${slug}' to ${stripTerminalControls(targetDisplay)}\n`);
  }
  return EXIT_CODES.success;
}
