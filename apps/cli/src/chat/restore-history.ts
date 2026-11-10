import type { NativePromptFlow } from '../render/tui/native-prompt-channel.js';
import type { TranscriptEntry } from '../render/tui/session-view-model.js';
import { restoreSessionTranscript, RestoredDisplayReadError } from './restored-transcript.js';

export async function prepareRestoredHistory(
  options: Parameters<typeof restoreSessionTranscript>[0] & {
    readonly assertAdmitting: () => void;
    readonly retry: () => Promise<boolean>;
  },
): Promise<readonly TranscriptEntry[] | undefined> {
  for (;;) {
    options.assertAdmitting();
    let entries: readonly TranscriptEntry[];
    try {
      entries = restoreSessionTranscript(options);
    } catch (cause) {
      if (!(cause instanceof RestoredDisplayReadError)) throw cause;
      options.assertAdmitting();
      if (await options.retry()) continue;
      return undefined;
    }
    options.assertAdmitting();
    return entries;
  }
}

/** A display failure offers recovery before any session/provider/MCP activation. */
export async function retryRestoredHistory(flow: NativePromptFlow): Promise<boolean> {
  const signal = flow.begin();
  try {
    flow.note(
      'Saved display text could not be read. Original user text will not be shown as a fallback.',
    );
    const choice = await flow.select({
      message: 'Restore session history?',
      options: [
        { value: 'retry', label: 'Retry reading history' },
        { value: 'return', label: 'Return' },
      ],
      initialValue: 'return',
    });
    return choice === 'retry' && !signal.aborted;
  } finally {
    await flow.end();
  }
}
