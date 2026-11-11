import { relative } from 'node:path';

import { prepareProjectInit } from '../authoring/project-init.js';
import type { NoticeFlush } from '../engine/effect-retention.js';
import { CliError } from '../process/cli-error.js';
import { sanitizeInline } from '../render/sanitize.js';
import {
  NativePromptVisibilityRefusedError,
  type NativePromptFlow,
  type NativePromptUi,
} from '../render/tui/native-prompt-channel.js';

/** Rehost the prepared shell core without another input owner or model call. */
export async function runHomeProjectInit(deps: {
  readonly cwd: string;
  readonly home: string;
  readonly flow: NativePromptFlow;
  readonly ui: NativePromptUi;
  readonly flushVisible: NoticeFlush;
  readonly assertAdmitting: () => void;
}): Promise<string> {
  deps.assertAdmitting();
  const signal = deps.flow.begin();
  const admit = (): void => {
    deps.assertAdmitting();
    signal.throwIfAborted();
  };
  try {
    const prepared = prepareProjectInit(deps.cwd, deps.home);
    const label = (path: string): string => sanitizeInline(relative(deps.cwd, path) || '.');
    if (prepared.alreadyInitialized)
      return `Already initialized at ${label(prepared.projectConfigDir)}.`;
    deps.flow.note(
      `Will create: ${prepared.directories.map(label).join(', ')}. No config or instruction files will be written.`,
      'Initialize project',
    );
    const confirmed = await deps.flow.confirm('Create these project directories?', false);
    if (confirmed !== true || signal.aborted) return 'Project initialization cancelled.';
    admit();
    deps.flow.busy('Creating project directories…');
    const snapshot = deps.ui.getSnapshot();
    for (;;) {
      await deps.flushVisible();
      try {
        const result = prepared.publish(() => {
          admit();
          deps.ui.assertVisible(snapshot);
        });
        return result.status === 'already-initialized'
          ? `Already initialized at ${label(result.projectConfigDir)}.`
          : `Created ${result.created.map(label).join(', ')}.`;
      } catch (error) {
        if (!(error instanceof NativePromptVisibilityRefusedError)) throw error;
        admit();
      }
    }
  } catch (error) {
    if (signal.aborted && error === signal.reason) return 'Project initialization cancelled.';
    if (error instanceof CliError && error.code === 'invalid_invocation') return error.message;
    throw error;
  } finally {
    await deps.flow.end();
  }
}
