import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import {
  SlugClashError,
  assertSlugAvailable,
  resolveProjectConfigDir,
} from '../authoring/authoring.js';
import {
  assertImportTargetConfined,
  commitImport,
  prepareImport,
  type ImportPlan,
} from '../commands/import.js';
import { assertProjectArtifactPath } from '../config/project-directory.js';
import { isCliError } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
import { sanitizeInline, sanitizeUntrustedInline } from '../render/sanitize.js';
import type { ImportAttempt, ImportPort, ImportPrepared } from '../render/tui/import-card.js';
import { reasonOf, writeFaultReasonOf } from './defined-port.js';

/**
 * What the Home's `/import` card reads and writes ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §9, MVP-8 step 5, increment 6). It is thin, as the export port is: the file is read, validated and placed by `relavium import`'s own
 * {@link prepareImport}, and written by its own {@link commitImport}, so the card writes exactly the bytes and to exactly the place the
 * command would. What the port adds is the path as a person types it (bounded, `~` expanded, no control characters), the words the card
 * needs where the command's say `--force`, and the fixed sentences for a write the file system refuses.
 *
 * The card never overwrites, so it never asks for `--force`: every plan is prepared with it off and committed with it off.
 */

export interface ImportPortDeps {
  readonly global: GlobalOptions;
  /** The operator home a leading `~` means and the path rules read; the Home's own, so nothing falls back to the process's. */
  readonly homeDir: string;
}

/** The longest path the field accepts, in characters. A path longer than any file system takes is a typo or a paste of something else. */
export const IMPORT_PATH_LIMIT = 1024;

/** Every control character (the C0 and C1 ranges and DEL, as `Cc`) and the line and paragraph separators (`Zl`, `Zp`): none belongs in a path. */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * What is wrong with a path as typed, before anything is read; none when it may be tried. The same check the field runs on `Enter` and
 * the port runs again on whatever it is handed, so a caller that skips the field is held to it.
 */
export function importPathIssue(text: string): string | undefined {
  if (text.length > IMPORT_PATH_LIMIT)
    return `The path is longer than ${IMPORT_PATH_LIMIT.toLocaleString('en-US')} characters.`;
  if (CONTROL_CHARACTERS.test(text)) return 'The path has a control character in it.';
  if (text.trim().length === 0) return 'Type the path of a workflow or agent YAML file.';
  return undefined;
}

/**
 * The path the command is given: surrounding blanks dropped, and a leading `~` (alone, or before a separator) taken as the operator's
 * home. `~name` is not another person's home here; it is a relative name like any other and is looked for under the working directory.
 * A relative path stays relative: the command resolves it against the Home's working directory.
 */
export function expandImportPath(text: string, home: string): string {
  const path = text.trim();
  if (path === '~') return home;
  if (path.startsWith('~/') || (sep === '\\' && path.startsWith('~\\')))
    return join(home, path.slice(2));
  return path;
}

/** What sits at the destination: nothing (or nothing that can be read), a regular file, or anything else (a link, a directory, a device). */
function occupantOf(path: string): 'none' | 'file' | 'other' {
  try {
    return lstatSync(path).isFile() ? 'file' : 'other';
  } catch {
    return 'none';
  }
}

const REPLACE_WITH_SHELL = 'To replace it, run relavium import --force with the same file.';

/** The refusal for a destination that is taken, in the card's words: it never overwrites, and says what does and what to do otherwise. */
function takenReason(destination: string, occupant: 'file' | 'other'): string {
  return occupant === 'file'
    ? `${destination} already exists, and this card never overwrites. ${REPLACE_WITH_SHELL}`
    : `${destination} already exists and is not a regular file, and this card never overwrites. Move it aside, then import again.`;
}

/** The refusal for an id the project already has, as the card words it, or none for any other fault. The prepare and the commit share it. */
function clashReason(cause: unknown): string | undefined {
  if (!(cause instanceof SlugClashError) || cause.clash !== 'same-kind') return undefined;
  return `${cause.kind} '${sanitizeUntrustedInline(cause.slug)}' already exists in this project, and this card never overwrites. ${REPLACE_WITH_SHELL}`;
}

/**
 * The destination relative to the project's root, the directory that holds `.relavium/` (`.relavium/workflows/<id>.relavium.yaml`): what the
 * Done step names, whatever directory the Home was opened in. `undefined` for one that is not inside the root (the plan confines it there, so
 * this is a guard against a display that would name an absolute path, not a case the prepare lets through).
 */
function projectRelative(plan: ImportPlan): string | undefined {
  const rel = relative(dirname(plan.projectConfigDir), plan.target);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return undefined;
  return rel.split(sep).join('/');
}

/** The `errno` code a CliError wraps (the write's EEXIST is wrapped by `writeAuthoredFile`), or none. */
function wrappedErrno(cause: unknown): string | undefined {
  const inner: unknown = isCliError(cause) ? cause.cause : undefined;
  if (typeof inner !== 'object' || inner === null || !('code' in inner)) return undefined;
  const code: unknown = inner.code;
  return typeof code === 'string' ? code : undefined;
}

function commitOf(plan: ImportPlan, deps: ImportPortDeps): () => ImportAttempt {
  const destination = sanitizeUntrustedInline(plan.targetDisplay);
  return () => {
    try {
      // The destination's rules, asked again now: the card stayed open for as long as a person took, and a link put in one of the
      // destination's directories since would send the write into home or global configuration. The shell's check-to-write gap is
      // microseconds; this one is not, so it is closed here the way the shell's is, by looking again right before the write.
      assertProjectArtifactPath(plan.target, deps.homeDir);
      // And a link that leaves the project is no better a destination than one into home: the same look, right after the first.
      assertImportTargetConfined(plan);
      // The id's rule, asked again now for the same reason: a file that declares the same id under another name can have appeared while
      // the card was open, and `wx` only protects the one name. Refused in the very words the prepare used.
      assertSlugAvailable({
        projectConfigDir: resolveProjectConfigDir(deps.global.cwd, deps.homeDir),
        cwd: deps.global.cwd,
        kind: plan.kind,
        slug: plan.slug,
        force: false,
        homeDir: deps.homeDir,
      });
      commitImport(plan);
    } catch (cause) {
      const clash = clashReason(cause);
      if (clash !== undefined) return { ok: false, reason: clash };
      // Something took the place between the card and the answer: `wx` kept it, and the card says so in its own words, not `--force`'s.
      if (wrappedErrno(cause) === 'EEXIST') {
        const occupant = occupantOf(plan.target);
        // Nothing at the destination (a parent that is a file raises the same errno) is not "taken": the command's own words follow.
        if (occupant !== 'none') return { ok: false, reason: takenReason(destination, occupant) };
      }
      // A fault the person can act on is a refusal, not the end of the Home: an unwritable directory is the destination's, not ours.
      const reason = reasonOf(cause) ?? writeFaultReasonOf(cause);
      // Anything else is a defect, and an unclassified fault ends the Home (ADR-0139).
      if (reason === undefined) throw cause;
      return { ok: false, reason };
    }
    return {
      ok: true,
      written: `Imported ${plan.kind} '${sanitizeUntrustedInline(plan.slug)}' to ${destination}.`,
    };
  };
}

/**
 * The import card's port. `prepare` is the command's own prepare step with `--force` off, so a refusal is the command's refusal, in its
 * words, except for an id the project already has and a destination that is already taken: those are refused before the card asks, in
 * words that name `relavium import --force` as the shell's way and the card's never.
 */
export function createImportPort(deps: ImportPortDeps): ImportPort {
  return {
    pathIssue: importPathIssue,
    prepare: (pathText): ImportPrepared => {
      // Before anything is read: a path that is refused here costs the file system nothing.
      const issue = importPathIssue(pathText);
      if (issue !== undefined) return { ok: false, reason: issue };
      let plan: ImportPlan;
      try {
        plan = prepareImport(
          { path: expandImportPath(pathText, deps.homeDir), force: false },
          { global: deps.global, homeDir: deps.homeDir },
        );
      } catch (cause) {
        const clash = clashReason(cause);
        if (clash !== undefined) return { ok: false, reason: clash };
        const reason = reasonOf(cause);
        if (reason === undefined) throw cause;
        return { ok: false, reason };
      }
      const destination = sanitizeUntrustedInline(plan.targetDisplay);
      const occupant = occupantOf(plan.target);
      if (occupant !== 'none') return { ok: false, reason: takenReason(destination, occupant) };
      return {
        ok: true,
        offer: {
          kind: plan.kind,
          slug: sanitizeUntrustedInline(plan.slug),
          source: sanitizeUntrustedInline(plan.source),
          destination,
          target: sanitizeUntrustedInline(projectRelative(plan) ?? plan.targetDisplay),
          bytes: plan.bytes,
          // The command's own sentences (composed here, not read from the file), one row each: the trailing newline is the stream's.
          warnings: plan.warnings.map((warning) => sanitizeInline(warning.trimEnd())),
        },
        commit: commitOf(plan, deps),
      };
    },
  };
}
