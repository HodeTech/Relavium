import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The `$EDITOR` half of the ADR-0068 §e copy-and-search escape hatches (2.6.F Step 5d): write the transcript to a
 * private temp file and hand the terminal to the user's editor, so they can search, select, and copy it — the
 * capability the alternate screen takes away (it has no native scrollback, and mouse reporting captures click-drag).
 *
 * It is **read-only by contract**: the file is a throwaway VIEW of the conversation. Edits are never read back — the
 * transcript is the session's persisted history, not a document. The temp file is removed on every path.
 *
 * This is the repo's FIRST TTY-inheriting child process. Every other spawn (`run_command`, `git_*`, the `!`-shell)
 * runs behind the tool sandbox with piped stdio (`apps/cli/src/engine/tool-host/process.ts`) and therefore never
 * touches the terminal. `$EDITOR` must inherit the TTY to be usable at all, which is exactly why it may only run
 * inside `suspendFullScreen` — see `suspend.ts` for which terminal modes must be off first (mouse reporting above
 * all: DECSET 1002 left on floods the editor with `\x1b[<…M` reports).
 *
 * SECURITY. `$EDITOR` is the user's own environment, at the same trust level as `$PATH` — not untrusted input. Even
 * so it is spawned with **`shell: false`**, so every shell metacharacter in its value (`;`, `|`, `` ` ``, `$`) is an
 * inert literal argv token rather than a command: there is no shell for an injection to reach. There is deliberately
 * **no fallback to `vi`** — dropping a user who never set `$EDITOR` into a modal editor they cannot exit, inside a
 * suspended full-screen app, is a worse failure than an actionable "set $EDITOR" notice.
 */

/** The classified result of an editor session — a discriminated union so the surface renders each case explicitly
 *  and no raw error escapes (mirrors `UserCommandOutcome`, ADR-0061). */
export type EditorOutcome =
  /** The editor ran and exited; `exitCode` may be non-zero (the user's editor failed, not us). */
  | { readonly kind: 'closed'; readonly exitCode: number }
  /** Neither `$VISUAL` nor `$EDITOR` is set (or both are blank) — nothing was spawned, no temp file created. */
  | { readonly kind: 'unavailable' }
  /** The editor could not be started, or died on a signal. `message` is secret-free and user-facing. */
  | { readonly kind: 'failed'; readonly message: string };

/** How the editor process ended. `code` is `null` when it was killed by `signal`. */
export interface EditorExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** A temp file holding the transcript, plus the disposer that removes it (and its private directory). */
export interface TempDocument {
  readonly path: string;
  readonly dispose: () => Promise<void>;
}

export interface OpenInEditorDeps {
  /** The process environment — read for `$VISUAL` / `$EDITOR` (in that precedence, as `git` and `less` use). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Report a temp-file disposal failure. This is the ONE cleanup in the module whose purpose is to keep the user's
   * conversation off disk, so a failure (a Windows `EBUSY` from an AV scanner or a not-yet-released editor handle)
   * must never vanish into a bare `.catch()`. Mirrors `chat.ts`'s `warnTeardown`: warn, never throw — a cleanup
   * fault must not turn a successful edit into a failure. Absent ⇒ the failure is dropped (a test/driver default).
   */
  readonly onDisposeFailed?: ((path: string, error: unknown) => void) | undefined;
  /** Spawn the editor with the TTY INHERITED; resolves when it exits, rejects if it could not be started. */
  readonly spawnEditor: (
    command: string,
    args: readonly string[],
    file: string,
  ) => Promise<EditorExit>;
  /** Create the private temp document. Injected so the orchestration is unit-testable without touching disk. */
  readonly createTempDocument: (contents: string) => Promise<TempDocument>;
}

/**
 * Split an `$EDITOR` value into `command + args`, honouring simple single/double quoting so `"code -w"`,
 * `"subl --wait"`, and `"'/Applications/My Editor/bin/ed' -n"` all work. NOT a shell parser: no variable expansion,
 * no globbing, no escape sequences, no operators — the value is spawned with `shell: false`, so anything it does not
 * understand stays an inert literal argument instead of becoming executable. Returns `undefined` for a blank value.
 */
export function parseEditorCommand(
  value: string,
): { readonly command: string; readonly args: readonly string[] } | undefined {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false; // distinguishes a real empty token (`""`) from "no token yet"
  for (const char of value) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);

  const [command, ...args] = tokens;
  if (command === undefined || command.length === 0) return undefined;
  return { command, args };
}

/** Resolve the editor from the environment: `$VISUAL` wins over `$EDITOR` (the POSIX convention — `VISUAL` is the
 *  full-screen editor, `EDITOR` the line-mode fallback, and we are handing over a full screen). */
export function resolveEditor(
  env: Readonly<Record<string, string | undefined>>,
): { readonly command: string; readonly args: readonly string[] } | undefined {
  for (const key of ['VISUAL', 'EDITOR'] as const) {
    const raw = env[key];
    if (raw === undefined) continue;
    const parsed = parseEditorCommand(raw);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * Write `contents` to a private temp file and open it in the user's editor, removing the file on EVERY path
 * (success, non-zero exit, spawn failure, or a throw). Never throws: every fault is classified into
 * {@link EditorOutcome} for the surface to render as a notice.
 *
 * Must be called inside `suspendFullScreen` — it inherits the TTY.
 */
export async function openInEditor(
  deps: OpenInEditorDeps,
  contents: string,
): Promise<EditorOutcome> {
  const editor = resolveEditor(deps.env);
  if (editor === undefined) return { kind: 'unavailable' }; // nothing spawned, nothing written to disk

  let document: TempDocument;
  try {
    document = await deps.createTempDocument(contents);
  } catch {
    return { kind: 'failed', message: 'could not create a temporary file for the transcript' };
  }

  try {
    const exit = await deps.spawnEditor(editor.command, editor.args, document.path);
    if (exit.signal !== null) {
      return { kind: 'failed', message: `${editor.command} was terminated by ${exit.signal}` };
    }
    return { kind: 'closed', exitCode: exit.code ?? 0 };
  } catch {
    // The editor could not be started (ENOENT / EACCES). The command NAME is the user's own env value, so echoing
    // it is safe and is the only actionable part of the message.
    return { kind: 'failed', message: `could not start ${editor.command}` };
  } finally {
    // Best-effort: a leftover temp file must never turn a successful edit into a failure — but it also must not be
    // silently retained, because it holds the conversation. Report, never throw (`warnTeardown`'s contract).
    await document.dispose().catch((error: unknown) => {
      deps.onDisposeFailed?.(document.path, error);
    });
  }
}

/**
 * The production {@link OpenInEditorDeps.createTempDocument}: a `0700` private directory holding one `0600` file,
 * both removed by `dispose`. `mkdtemp` (not a predictable name) closes the classic shared-`/tmp` symlink race, and
 * the directory means `dispose` reclaims any sidecar/swap file the editor left behind (`.swp`, `~`).
 *
 * It also registers a SYNCHRONOUS `process.on('exit')` net, mirroring the alt-screen exit-safety pattern in
 * `alt-screen.ts` / `chat.ts`. This is not belt-and-braces — it closes a real hole found by the Step-5d-2 Sonnet
 * review: during a suspension ink has turned raw mode OFF, so a keyboard **Ctrl-C reaches the kernel as a real
 * SIGINT** to the whole foreground process group (the editor shares ours — it is not `detached`). A second press
 * runs the surface's `process.exit(…)`, which halts the event loop while `openInEditor` is still awaiting the
 * child — so its `async finally` NEVER runs and the directory holding the full conversation survives on disk.
 * `rmSync` in an `'exit'` listener is the only cleanup that can still run there. `dispose` removes the listener
 * after its async `rm`, so a long session opening `/edit` repeatedly cannot accumulate listeners.
 */
export const nodeCreateTempDocument = async (contents: string): Promise<TempDocument> => {
  const dir = await mkdtemp(join(tmpdir(), 'relavium-transcript-'));
  const path = join(dir, 'transcript.md');
  try {
    await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    // The write can fail AFTER flushing part of the conversation (ENOSPC on a full disk, EIO). At this point no exit
    // net is armed and no `dispose` has been returned, so nothing downstream would ever reclaim the directory — the
    // partial transcript would simply stay in the OS temp dir. Reclaim it here, then rethrow so `openInEditor` still
    // classifies it as `{ kind: 'failed' }` (Step-5d-3 Opus review).
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  const exitNet = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true }); // the only cleanup that survives a hard `process.exit()`
    } catch {
      // an 'exit' listener may not throw — and there is nowhere left to report to
    }
  };
  process.on('exit', exitNet);

  return {
    path,
    dispose: async () => {
      // `force: true` ⇒ an already-reclaimed dir is a silent no-op, so the exit net can never provoke a spurious
      // disposal warning if both run.
      //
      // If this THROWS (a Windows `EBUSY` from an AV scanner, an editor that has not released its handle, `EPERM`),
      // the exit net is deliberately LEFT ARMED and gets one more chance at process exit. It used to be removed in a
      // `finally`, which disarmed the last-ditch cleanup at exactly the moment it was needed — and the temp file
      // holding the WHOLE conversation survived the process (whole-phase Opus review). `openInEditor` still reports
      // the failure through `onDisposeFailed`; this only decides whether we keep trying.
      await rm(dir, { recursive: true, force: true });
      process.removeListener('exit', exitNet);
    },
  };
};

/** The production {@link OpenInEditorDeps.spawnEditor}: inherit the TTY (the editor IS the foreground app while it
 *  runs) and resolve on exit. `shell: false` — see the module note. Rejects only when the child cannot be started. */
export const nodeSpawnEditor = (
  command: string,
  args: readonly string[],
  file: string,
): Promise<EditorExit> =>
  new Promise<EditorExit>((resolve, reject) => {
    const child = spawn(command, [...args, file], {
      stdio: 'inherit', // the editor owns the terminal; suspendFullScreen already handed it over
      shell: false, // SECURITY: no shell — a metacharacter in $EDITOR is an inert argv token, never a command
      windowsHide: false,
    });
    child.once('error', reject); // ENOENT / EACCES — the command does not exist or is not executable
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
