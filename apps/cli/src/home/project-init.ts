import { isAbsolute, relative } from 'node:path';

import { prepareProjectInit, type ProjectInitResult } from '../authoring/project-init.js';
import type { NoticeFlush } from '../engine/effect-retention.js';
import { POPUP_NOTICE_MAX_COLUMNS } from '../popups/geometry.js';
import { CliError } from '../process/cli-error.js';
import { FLOW_CLOSE_LABEL, flowText } from '../render/tui/flow-text.js';
import {
  NativePromptVisibilityRefusedError,
  type NativeChordPort,
  type NativePromptFlow,
  type NativePromptUi,
} from '../render/tui/native-prompt-channel.js';
import { displayWidth } from '../render/tui/viewport.js';
import { framedFlow, type FramedChordFlow } from './framed-flow.js';

/**
 * `/init` on the Home, drawn as a popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §3, §6): the shell's own prepared initialization (`prepareProjectInit`), rehosted with no other input owner and no model call.
 *
 * - **The rail is `Check · Confirm · Done`.** The check is the folder looked at (nothing is asked there: it is done when the popup opens), the
 *   confirmation is the chord card that names every directory it would create and that no config or instruction file is written, and the
 *   Done step names what was created, project-relative, and what to type next. A folder that is already a project opens nothing: one
 *   notification says where it is.
 * - **`Ctrl+Y` creates; nothing else does** (§3: a project write is a chord). `Ctrl+N`, `Esc`, `Ctrl+C`, a closed Home and every key that is
 *   not a chord create nothing, and the guard layers of the chord card are the channel's, unchanged.
 * - **The write is behind the visibility proof.** The directories are created only while the wait that says so is the frame on screen,
 *   measured and flushed (`ui.assertVisible` inside `publish`, after the renderer's own flush); a terminal that no longer shows it holds the
 *   write until it does again, or until the person leaves.
 * - **Nothing is left behind** (§6): the result is the Done step, a refusal is a step of the popup, and a cancel is one notification, the
 *   sentence this function resolves with. Nothing is written to the Home's notice or a transcript.
 */

export const INIT_TITLE = '/init';
export const INIT_STEPS = ['Check', 'Confirm', 'Done'] as const;
const CHECK = 0;
const CONFIRM = 1;

export const INIT_QUESTION = 'Create these project directories?';
export const INIT_ALLOW_LABEL = 'Create them';
export const INIT_DENY_LABEL = 'Create nothing';
export const INIT_NO_FILES = 'No config or instruction files will be written.';
export const INIT_NO_FILES_WRITTEN = 'No config or instruction files were written.';
export const INIT_CREATING = 'Creating project directories…';
/** The notification after a cancel: what the person is told when the popup closed with nothing created. */
export const INIT_CANCELLED = 'Project initialization cancelled.';
/** The notification when the folder was already a project and its own place could not be named in the room a notification has. */
export const INIT_ALREADY_HERE = 'This folder is already in a project.';
/**
 * The Done step's sentence: what was done, with no path in it. The directories are the rows under it (the first of them, `.relavium/`, is the
 * target), so each is said once; a sentence that named the target as well would say it a second time.
 */
export const INIT_CREATED = 'Created the project directories';
/** What to type next, on the Done step: the Home's own words for what a project is for. */
export const INIT_NEXT = 'Next: /import brings a workflow or an agent into this project.';
export const INIT_REFUSED = 'Cannot initialize this folder.';
export const INIT_FAILED = 'Project initialization did not complete.';
export const INIT_CLOSE_LABEL = FLOW_CLOSE_LABEL;

/** `path` relative to the working directory, as a directory (`.relavium/`), through the full scrub; `undefined` when it is not relative there. */
function directoryLabel(cwd: string, path: string): string | undefined {
  const rel = relative(cwd, path);
  if (rel === '') return './';
  if (isAbsolute(rel)) return undefined;
  return `${flowText(rel.split('\\').join('/'))}/`;
}

/** The labels of `paths`, each project-relative (a path that is not is named by its last part: the flow never prints an absolute one). */
function directoryLabels(cwd: string, paths: readonly string[]): string[] {
  return paths.map(
    (path) => directoryLabel(cwd, path) ?? `${flowText(path.split(/[\\/]/u).at(-1) ?? '')}/`,
  );
}

/** The notification for a folder that is already a project: where it is, when that fits the row a notification has. */
export function alreadyInitializedNotice(cwd: string, projectConfigDir: string): string {
  const label = directoryLabel(cwd, projectConfigDir);
  const named = label === undefined ? undefined : `Already initialized at ${label}`;
  return named !== undefined && displayWidth(named) <= POPUP_NOTICE_MAX_COLUMNS
    ? named
    : INIT_ALREADY_HERE;
}

export interface HomeProjectInitDeps {
  readonly cwd: string;
  readonly home: string;
  /** The Home's native prompt flow: framed here as the `/init` popup. */
  readonly flow: NativePromptFlow & NativeChordPort;
  readonly ui: NativePromptUi;
  readonly flushVisible: NoticeFlush;
  readonly assertAdmitting: () => void;
}

/** The refusal, where the question would have been: what is wrong, in the product's words, with one way to close it. Writes nothing. */
async function refuse(flow: FramedChordFlow, reason: string): Promise<undefined> {
  await flow.at(CHECK).select({
    message: INIT_REFUSED,
    details: [flowText(reason)],
    options: [{ value: 'close', label: INIT_CLOSE_LABEL }],
    escape: 'cancel',
    final: 'failed',
  });
  return undefined;
}

/**
 * Publish the prepared directories while the wait that says so is the frame on screen: the renderer flushes, then `publish` asserts that
 * exact frame is measured and visible before every directory it creates. A frame that is not (a shrink, a lost screen) is waited out.
 */
async function publishVisibly(
  deps: HomeProjectInitDeps,
  prepared: ReturnType<typeof prepareProjectInit>,
  admit: () => void,
): Promise<ProjectInitResult> {
  const snapshot = deps.ui.getSnapshot();
  for (;;) {
    await deps.flushVisible();
    try {
      return prepared.publish(() => {
        admit();
        deps.ui.assertVisible(snapshot);
      });
    } catch (error) {
      if (!(error instanceof NativePromptVisibilityRefusedError)) throw error;
      admit();
    }
  }
}

/** The persistent last step: what was created (project-relative) and what to type next, or that the folder became a project meanwhile. */
async function finish(
  flow: FramedChordFlow,
  cwd: string,
  result: ProjectInitResult,
): Promise<undefined> {
  if (result.status === 'already-initialized') {
    await flow.done({
      message: alreadyInitializedNotice(cwd, result.projectConfigDir),
      lines: ['Nothing was created: this folder became a project while the popup was open.'],
    });
    return undefined;
  }
  await flow.done({
    message: INIT_CREATED,
    lines: [...directoryLabels(cwd, result.created), INIT_NO_FILES_WRITTEN, INIT_NEXT],
    target: directoryLabel(cwd, result.projectConfigDir) ?? '.relavium/',
  });
  return undefined;
}

/** The folder, looked at before anything is drawn: what would be created, or why this folder cannot be made a project. */
type FolderCheck =
  | { readonly kind: 'ready'; readonly prepared: ReturnType<typeof prepareProjectInit> }
  | { readonly kind: 'refused'; readonly reason: string };

function checkFolder(deps: HomeProjectInitDeps): FolderCheck {
  try {
    return { kind: 'ready', prepared: prepareProjectInit(deps.cwd, deps.home) };
  } catch (error) {
    if (error instanceof CliError && error.code === 'invalid_invocation')
      return { kind: 'refused', reason: error.message };
    throw error;
  }
}

/** The confirmation, the write behind the visibility proof, and the Done step. Resolves with the notification of a No, else `undefined`. */
async function confirmAndCreate(
  deps: HomeProjectInitDeps,
  flow: FramedChordFlow,
  signal: AbortSignal,
  prepared: ReturnType<typeof prepareProjectInit>,
): Promise<string | undefined> {
  const admit = (): void => {
    deps.assertAdmitting();
    signal.throwIfAborted();
  };
  const answer = await flow.at(CONFIRM).chord({
    message: INIT_QUESTION,
    details: [
      `Will create: ${directoryLabels(deps.cwd, prepared.directories).join(', ')}`,
      INIT_NO_FILES,
    ],
    allow: INIT_ALLOW_LABEL,
    deny: INIT_DENY_LABEL,
    escape: 'cancel',
    signal,
  });
  // The default is No: only an `allow` the chord guard let through creates anything, never "anything that is not a `deny`".
  if (answer !== 'allow' || signal.aborted) return INIT_CANCELLED;
  admit();
  flow.at(CONFIRM).busy(INIT_CREATING);
  let result: ProjectInitResult;
  try {
    result = await publishVisibly(deps, prepared, admit);
  } catch (error) {
    if (signal.aborted && error === signal.reason) return INIT_CANCELLED;
    if (!(error instanceof CliError && error.code === 'invalid_invocation')) throw error;
    await flow.done({
      message: INIT_FAILED,
      lines: [flowText(error.message)],
      tone: 'failed',
    });
    return undefined;
  }
  return finish(flow, deps.cwd, result);
}

/**
 * Run `/init` as a popup. Resolves with the ONE notification the Home shows (a cancel, a folder that is already a project), or `undefined`
 * when the popup itself said what happened (the Done step, a refusal). The folder is looked at first: one that is already a project opens no
 * popup at all. Otherwise the flow is begun here and ended here, whatever the answer.
 */
export async function runHomeProjectInit(deps: HomeProjectInitDeps): Promise<string | undefined> {
  deps.assertAdmitting();
  const checked = checkFolder(deps);
  if (checked.kind === 'ready' && checked.prepared.alreadyInitialized)
    return alreadyInitializedNotice(deps.cwd, checked.prepared.projectConfigDir);
  const flow = framedFlow(deps.flow, {
    title: INIT_TITLE,
    origin: 'home',
    stepNames: INIT_STEPS,
    progress: 'manual',
  });
  const signal = flow.begin();
  try {
    if (checked.kind === 'refused') return await refuse(flow, checked.reason);
    return await confirmAndCreate(deps, flow, signal, checked.prepared);
  } catch (error) {
    if (signal.aborted && error === signal.reason) return INIT_CANCELLED;
    throw error;
  } finally {
    await flow.end();
  }
}
