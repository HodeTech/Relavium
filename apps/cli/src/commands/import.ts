import { basename, relative, resolve } from 'node:path';
import { assertProjectArtifactPath } from '../config/project-directory.js';

import {
  assertSlugAvailable,
  catalogPath,
  detectAndParse,
  readAuthoredFile,
  resolveProjectConfigDir,
  serializeAuthored,
  writeAuthoredFile,
  type AuthoredKind,
} from '../authoring/authoring.js';
import { warnSnapshotLiterals } from '../authoring/snapshot-notice.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { stringifyJsonLine } from '../render/sanitize.js';

export interface ImportCommandArgs {
  /** The external workflow/agent YAML to copy into the project (absolute, or relative to cwd). */
  readonly path: string;
  /** `--force`: overwrite an existing project entry with the same id; without it a collision is a clean exit-2 fault. */
  readonly force: boolean;
}

export interface ImportCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
}

/** What {@link prepareImport} needs: no output (it prints nothing) and, for a caller that is handed one, the operator home. */
export interface ImportPrepareDeps {
  readonly global: GlobalOptions;
  /** The operator home the path rules read. The command passes none (the process's own); the Home passes its own. */
  readonly homeDir?: string | undefined;
}

/**
 * What an import WILL write, worked out and not written: the destination, the canonical content and the notices the command would
 * print once it had written. It is the whole of what the Home's import card shows before it asks, and {@link commitImport} writes
 * exactly this and nothing else.
 */
export interface ImportPlan {
  readonly kind: AuthoredKind;
  readonly slug: string;
  /** The source as the command names it in its own words: relative to the working directory. */
  readonly source: string;
  /** The absolute destination. The human-facing {@link ImportPlan.targetDisplay} is the cwd-relative one. */
  readonly target: string;
  readonly targetDisplay: string;
  /** The canonical re-serialization, as it will be written (UTF-8). */
  readonly content: string;
  /** The bytes {@link ImportPlan.content} takes on disk. */
  readonly bytes: number;
  readonly force: boolean;
  /**
   * The best-effort notices about the definition's literals, each a whole line as the command writes it to stderr (a trailing newline
   * included), in the order it writes them. Collected here, written only after the file is: a refused import warns of nothing.
   */
  readonly warnings: readonly string[];
}

/**
 * The first half of `relavium import`: read and validate the source, resolve where it would land, and refuse what the command refuses
 * (a missing, oversized or invalid source, an id the project already has unless `--force`, a destination that resolves into global
 * state). Nothing is written and nothing is printed. Every refusal is the same exit-2 {@link CliError} the command always raised, in
 * the order it raised them (an id the project already has is a `SlugClashError`: a CliError that also says which clash it is); a target
 * that already holds a file and one that is not a file are the write's to refuse, and {@link commitImport} does.
 */
export function prepareImport(args: ImportCommandArgs, deps: ImportPrepareDeps): ImportPlan {
  const cwd = deps.global.cwd;
  const home = deps.homeDir;
  const absolute = resolve(cwd, args.path);
  const source = relative(cwd, absolute);

  const yaml = readAuthoredFile(absolute, source);
  const parsed = detectAndParse(yaml, source, basename(args.path));

  const projectConfigDir = resolveProjectConfigDir(cwd, home);
  // Project-global id uniqueness (by the in-file id, even under a differently-named file): a same-kind collision
  // needs `--force` to overwrite; a cross-kind collision is always rejected (it would make `export <id>`
  // ambiguous). Shared with `create` so both authoring paths enforce one id-uniqueness rule.
  assertSlugAvailable({
    projectConfigDir,
    cwd,
    kind: parsed.kind,
    slug: parsed.slug,
    force: args.force,
    ...(home === undefined ? {} : { homeDir: home }),
  });

  const target = catalogPath(projectConfigDir, parsed.kind, parsed.slug);
  const targetDisplay = relative(cwd, target);
  assertProjectArtifactPath(target, home);
  const content = serializeAuthored(parsed);
  const warnings: string[] = [];
  warnSnapshotLiterals(parsed.definition, {
    writeErr: (text) => {
      warnings.push(text);
    },
  });
  return {
    kind: parsed.kind,
    slug: parsed.slug,
    source,
    target,
    targetDisplay,
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    force: args.force,
    warnings,
  };
}

/**
 * The second half: write the plan. Without `force` an existing target is a clean exit-2 {@link CliError} (`wx`, so no check-then-write
 * window), and a target that is not a file is one too ({@link writeAuthoredFile}).
 */
export function commitImport(plan: ImportPlan): void {
  writeAuthoredFile(plan.target, plan.targetDisplay, plan.content, plan.force);
}

/**
 * `relavium import <path>` (2.J) — copy an external workflow/agent YAML INTO the project `.relavium/`, validating
 * **schema** and **slug uniqueness**. It parse-validates the file (a malformed file is a clean exit-2 fault),
 * enforces project-global id uniqueness via `assertSlugAvailable` (a same-kind collision needs `--force`; a
 * cross-kind collision is always rejected), and writes the **re-serialized** (canonical, comment-free,
 * `{{secrets.*}}`-placeholder-preserving) document to `.relavium/<workflows|agents>/<id>.<suffix>`.
 * **Surface-agnostic**: pure YAML I/O — never the keychain or run state.
 *
 * It is {@link prepareImport}, then {@link commitImport}, then the output, in that order: the split lets the Home's import card show
 * the destination between the first two, and changes nothing the command prints, returns or throws (the credential notices, which the
 * first step collects, are written only after the second has written).
 */
export function importCommand(args: ImportCommandArgs, deps: ImportCommandDeps): ExitCode {
  const plan = prepareImport(args, deps);
  commitImport(plan);
  for (const warning of plan.warnings) deps.io.writeErr(warning);

  if (deps.global.json) {
    deps.io.writeOut(
      `${stringifyJsonLine({ id: plan.slug, kind: plan.kind, path: plan.targetDisplay })}\n`,
    );
  } else {
    deps.io.writeOut(`Imported ${plan.kind} '${plan.slug}' to ${plan.targetDisplay}\n`);
  }
  return EXIT_CODES.success;
}
