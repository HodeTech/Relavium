import { basename, relative, resolve } from 'node:path';

import {
  assertSlugAvailable,
  catalogPath,
  detectAndParse,
  readAuthoredFile,
  resolveProjectConfigDir,
  serializeAuthored,
  writeAuthoredFile,
} from '../authoring/authoring.js';
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
 * **schema** and **slug uniqueness**. It parse-validates the file (a malformed file is a clean exit-2 fault),
 * enforces project-global id uniqueness via `assertSlugAvailable` (a same-kind collision needs `--force`; a
 * cross-kind collision is always rejected), and writes the **re-serialized** (canonical, comment-free,
 * `{{secrets.*}}`-placeholder-preserving) document to `.relavium/<workflows|agents>/<id>.<suffix>`.
 * **Surface-agnostic**: pure YAML I/O — never the keychain or run state.
 */
export function importCommand(args: ImportCommandArgs, deps: ImportCommandDeps): ExitCode {
  const cwd = deps.global.cwd;
  const absolute = resolve(cwd, args.path);
  const source = relative(cwd, absolute);

  const yaml = readAuthoredFile(absolute, source);
  const parsed = detectAndParse(yaml, source, basename(args.path));

  const projectConfigDir = resolveProjectConfigDir(cwd);
  // Project-global id uniqueness (by the in-file id, even under a differently-named file): a same-kind collision
  // needs `--force` to overwrite; a cross-kind collision is always rejected (it would make `export <id>`
  // ambiguous). Shared with `create` so both authoring paths enforce one id-uniqueness rule.
  assertSlugAvailable({
    projectConfigDir,
    cwd,
    kind: parsed.kind,
    slug: parsed.slug,
    force: args.force,
  });

  const target = catalogPath(projectConfigDir, parsed.kind, parsed.slug);
  const rel = relative(cwd, target);
  writeAuthoredFile(target, rel, serializeAuthored(parsed), args.force);

  if (deps.global.json) {
    deps.io.writeOut(`${JSON.stringify({ id: parsed.slug, kind: parsed.kind, path: rel })}\n`);
  } else {
    deps.io.writeOut(`Imported ${parsed.kind} '${parsed.slug}' to ${rel}\n`);
  }
  return EXIT_CODES.success;
}
