import type { ConfigWriteResult, PreparedConfigWrite } from '../config/write.js';
import type { NoticeFlush } from '../engine/effect-retention.js';
import { CliError } from '../process/errors.js';
import {
  NativePromptVisibilityRefusedError,
  type NativePromptFlow,
  type NativePromptUi,
} from '../render/tui/native-prompt-channel.js';

/** The rewrite disclosure and final publication belong to the same visibly admitted native card. */
export async function publishModePreference(options: {
  readonly prepared: PreparedConfigWrite;
  readonly flow: NativePromptFlow;
  readonly ui: NativePromptUi;
  readonly flushVisible: () => NoticeFlush | undefined;
  readonly assertAdmitting: () => void;
}): Promise<ConfigWriteResult> {
  for (;;) {
    options.assertAdmitting();
    const flush = options.flushVisible();
    if (flush === undefined)
      throw new CliError('output_unavailable', 'The mode setting could not be displayed.');
    await flush(() => {
      options.assertAdmitting();
      if (options.prepared.rewriteNeeded)
        options.flow.note(
          'Saving preferences rewrites the global config and removes its comments and ordering.',
        );
      else options.flow.busy('Saving mode preference…');
    });
    const snapshot = options.ui.getSnapshot();
    try {
      return options.prepared.publish(() => {
        options.assertAdmitting();
        options.ui.assertVisible(snapshot);
      });
    } catch (cause) {
      if (!(cause instanceof NativePromptVisibilityRefusedError)) throw cause;
    }
  }
}
