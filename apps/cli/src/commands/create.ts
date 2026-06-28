import { relative } from 'node:path';

import {
  assertSlugAvailable,
  buildAuthored,
  catalogPath,
  resolveProjectConfigDir,
  serializeAuthored,
  writeAuthoredFile,
  type CreatePrompter,
} from '../authoring/authoring.js';
import { createClackPrompter } from '../authoring/create-prompter.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';

export interface CreateCommandArgs {
  /** `--force`: overwrite an existing project entry with the same id; without it a collision is a clean exit-2 fault. */
  readonly force: boolean;
}

export interface CreateCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** Injectable wizard (tests inject canned answers); default is the `@clack/prompts` wizard. */
  readonly prompter?: CreatePrompter;
}

/**
 * `relavium create` (2.J) — an interactive wizard that scaffolds a new agent or a minimal single-agent workflow
 * as plain, git-ready YAML, **validated against the `@relavium/shared` schema before write** (a bad
 * model/provider/name is a clean exit-2 {@link CliError}). It writes `.relavium/<workflows|agents>/<id>.<suffix>`;
 * a name colliding with an existing entry is exit 2 unless `--force`. **Surface-agnostic** — pure YAML I/O, no
 * keychain/run state. The wizard needs an interactive terminal, so it fails loud under `--json` / a non-TTY.
 */
export async function createCommand(
  args: CreateCommandArgs,
  deps: CreateCommandDeps,
): Promise<ExitCode> {
  // The clack wizard needs an interactive TTY on BOTH ends: stdout to render the prompt and stdin to read
  // keystrokes (a non-TTY stdin makes clack's raw-mode setup throw, not hang). Under --json or either stream
  // piped there is no way to prompt, so fail loud. (An injected prompter — a test, or a future non-interactive
  // flag path — bypasses this gate.)
  if (
    deps.prompter === undefined &&
    (deps.global.json || !deps.io.stdoutIsTty || !deps.io.stdinIsTty)
  ) {
    throw new CliError(
      'invalid_invocation',
      '`relavium create` needs an interactive terminal — it is not available under --json or a non-TTY pipe.',
    );
  }

  const spec = await (deps.prompter ?? createClackPrompter()).gather();
  if (spec === null) {
    // The user cancelled the wizard (Ctrl-C / ESC) — nothing was written; a clean, non-fault exit.
    deps.io.writeErr('create cancelled.\n');
    return EXIT_CODES.success;
  }

  const parsed = buildAuthored(spec); // build + validate (a bad combination is a typed exit-2 CliError)
  const cwd = deps.global.cwd;
  const projectConfigDir = resolveProjectConfigDir(cwd);
  // Project-global id uniqueness (across both catalogs) — a cross-kind collision is rejected even with --force.
  assertSlugAvailable({
    projectConfigDir,
    cwd,
    kind: parsed.kind,
    slug: parsed.slug,
    force: args.force,
  });

  const target = catalogPath(projectConfigDir, parsed.kind, parsed.slug);
  const targetDisplay = relative(cwd, target);
  writeAuthoredFile(target, targetDisplay, serializeAuthored(parsed), args.force);
  deps.io.writeOut(`Created ${parsed.kind} '${parsed.slug}' at ${targetDisplay}\n`);
  return EXIT_CODES.success;
}
