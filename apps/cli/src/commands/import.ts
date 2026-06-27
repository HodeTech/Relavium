import { basename, relative, resolve } from 'node:path';

import {
  catalogPath,
  detectAndParse,
  readAuthoredFile,
  resolveProjectConfigDir,
  serializeAuthored,
  slugExists,
  writeAuthoredFile,
} from '../authoring/authoring.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';

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

/**
 * `relavium import <path>` (2.J) — copy an external workflow/agent YAML INTO the project `.relavium/`, validating
 * **schema** and **slug uniqueness**. It parse-validates the file (a malformed file is a clean exit-2
 * {@link CliError}), rejects an id that already names a same-kind catalog entry (exit 2, unless `--force`), and
 * writes the **re-serialized** (canonical, comment-free, `{{secrets.*}}`-placeholder-preserving) document to
 * `.relavium/<workflows|agents>/<id>.<suffix>`. **Surface-agnostic**: pure YAML I/O — never the keychain or run
 * state.
 */
export function importCommand(args: ImportCommandArgs, deps: ImportCommandDeps): ExitCode {
  const cwd = deps.global.cwd;
  const absolute = resolve(cwd, args.path);
  const source = relative(cwd, absolute);

  const yaml = readAuthoredFile(absolute, source);
  const parsed = detectAndParse(yaml, source, basename(args.path));

  const projectConfigDir = resolveProjectConfigDir(cwd);
  // Slug uniqueness (by the in-file id, even under a differently-named file) — the import collision guard. With
  // `--force` it is skipped and the canonical-named target is overwritten.
  if (!args.force && slugExists({ projectConfigDir, cwd, kind: parsed.kind, slug: parsed.slug })) {
    throw new CliError(
      'invalid_invocation',
      `${parsed.kind} '${parsed.slug}' already exists in this project (id collision) — pass --force to overwrite.`,
    );
  }

  const target = catalogPath(projectConfigDir, parsed.kind, parsed.slug);
  writeAuthoredFile(target, serializeAuthored(parsed), args.force);

  const rel = relative(cwd, target);
  if (deps.global.json) {
    deps.io.writeOut(`${JSON.stringify({ id: parsed.slug, kind: parsed.kind, path: rel })}\n`);
  } else {
    deps.io.writeOut(`Imported ${parsed.kind} '${parsed.slug}' to ${rel}\n`);
  }
  return EXIT_CODES.success;
}
