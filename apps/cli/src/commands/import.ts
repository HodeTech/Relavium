import { homedir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';
import { assertProjectArtifactPath } from '../config/project-directory.js';

import {
  assertSlugAvailable,
  catalogPath,
  confineCatalogTarget,
  confineToProjectConfig,
  detectAndParse,
  readAuthoredFile,
  resolveProjectConfigDir,
  serializeAuthored,
  writeAuthoredFile,
  type AuthoredKind,
  type ConfinedTarget,
} from '../authoring/authoring.js';
import { warnSnapshotLiterals } from '../authoring/snapshot-notice.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { sanitizeInline, stringifyJsonLine } from '../render/sanitize.js';

export interface ImportCommandArgs {
  /** The external workflow/agent YAML to copy into the project (absolute, or relative to cwd). */
  readonly path: string;
  /** `--force`: overwrite an existing project entry with the same id; without it a collision is a clean exit-2 fault. */
  readonly force: boolean;
}

export interface ImportCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** The operator home the path rules read. The program passes none (the process's own, read in {@link importCommand}); a test hands it a temporary one. */
  readonly homeDir?: string | undefined;
}

/** What {@link prepareImport} needs: no output (it prints nothing) and the operator home, which has no default here. */
export interface ImportPrepareDeps {
  readonly global: GlobalOptions;
  /** The operator home the path rules read: the command resolves the process's own at its boundary, the Home passes its own. */
  readonly homeDir: string;
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
  /**
   * The absolute destination, with its directory resolved through any link that stays inside the project (a link that leaves it is
   * refused). The human-facing {@link ImportPlan.targetDisplay} is the cwd-relative one of this same path.
   */
  readonly target: string;
  readonly targetDisplay: string;
  /** The project configuration directory the destination was confined to; {@link commitImport} confines it to this again, right before the write. */
  readonly projectConfigDir: string;
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
    homeDir: home,
  });

  const catalogTarget = catalogPath(projectConfigDir, parsed.kind, parsed.slug);
  assertProjectArtifactPath(catalogTarget, home);
  // After the rule about global state, so a link into it keeps that sentence: this one is for a link that leaves the project elsewhere.
  const { target, targetDisplay } = confineCatalogTarget({
    projectConfigDir,
    cwd,
    target: catalogTarget,
  });
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
    projectConfigDir,
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    force: args.force,
    warnings,
  };
}

/**
 * Refuse a plan whose destination directory now leads out of the project, as {@link prepareImport} refuses one that does. The plan was
 * confined when it was made; a link put in one of its directories since (the Home's card stays open for as long as a person takes) is
 * caught here. {@link commitImport} asks it right before the write, and the Home asks it earlier, where it re-checks the destination.
 */
export function assertImportTargetConfined(plan: ImportPlan): void {
  confinedImportTarget(plan);
}

/** {@link assertImportTargetConfined}, returning what the confinement decided: the canonical path the write must go to. */
function confinedImportTarget(plan: ImportPlan): ConfinedTarget {
  return confineToProjectConfig(plan.projectConfigDir, plan.target, dirname(plan.targetDisplay));
}

/**
 * The second half: write the plan. Without `force` an existing target is a clean exit-2 {@link CliError} (`wx`, so no check-then-write
 * window), and a target that is not a file is one too ({@link writeAuthoredFile}). A destination directory that is a link out of the
 * project is refused first ({@link assertImportTargetConfined}).
 */
export function commitImport(plan: ImportPlan): void {
  // The write goes to the canonical directory this very check computed, and looks at it again around the write (a pin that narrows a swap
  // of the directory's name and does not close it; see `writeAuthoredFile`): the plan's own
  // `target` is spelled from the project and would be resolved by name again, through any link put into it since the check.
  const { writeTarget } = confinedImportTarget(plan);
  writeAuthoredFile(writeTarget, plan.targetDisplay, plan.content, plan.force, {
    pinDirectory: true,
  });
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
  // The one place the command reads the process's own home; every rule below is handed it.
  const plan = prepareImport(args, { global: deps.global, homeDir: deps.homeDir ?? homedir() });
  commitImport(plan);
  for (const warning of plan.warnings) deps.io.writeErr(warning);

  if (deps.global.json) {
    deps.io.writeOut(
      `${stringifyJsonLine({ id: plan.slug, kind: plan.kind, path: plan.targetDisplay })}\n`,
    );
  } else {
    // The destination is spelled from the directory names under the project, which a link inside it can make anything: one row, no controls.
    deps.io.writeOut(
      `Imported ${plan.kind} '${plan.slug}' to ${sanitizeInline(plan.targetDisplay)}\n`,
    );
  }
  return EXIT_CODES.success;
}
