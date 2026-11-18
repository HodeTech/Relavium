import { wrapTranscript } from './chat-projection.js';
import type { ToolDisplay } from './tool-display.js';
import type { ChatStore } from './chat-store.js';
import type { TranscriptEntry } from './session-view-model.js';

export interface TranscriptPublication {
  /** Capture the exact notice objects appended by this publication. */
  published(): void;
  visible(): boolean;
}

/** Render evidence is ephemeral; it grants no authority over an effect-journal row. */
export interface TranscriptAcknowledgement {
  clearViewport(): void;
  capture(): TranscriptPublication;
  inlineNotice(entry: TranscriptEntry): void;
  viewport(
    transcript: readonly TranscriptEntry[],
    columns: number,
    firstRow: number,
    endRow: number,
    measuredWidth: number,
    displays?: ReadonlyMap<string, ToolDisplay>,
  ): void;
}

/** Confirm the published notice itself, rather than an unrelated flushed prompt/footer. */
export function createTranscriptAcknowledgement(
  currentStore: () => ChatStore | undefined,
): TranscriptAcknowledgement {
  // Static removes previously printed children. Their identities remain valid without retaining history.
  const printed = new WeakSet<TranscriptEntry>();
  let frame:
    | {
        readonly transcript: readonly TranscriptEntry[];
        readonly columns: number;
        readonly firstRow: number;
        readonly endRow: number;
        readonly measuredWidth: number;
        readonly color: boolean;
        readonly displays: ReadonlyMap<string, ToolDisplay> | undefined;
      }
    | undefined;
  return {
    clearViewport: () => {
      frame = undefined;
    },
    inlineNotice: (entry) => printed.add(entry),
    viewport: (transcript, columns, firstRow, endRow, measuredWidth, displays) => {
      frame = {
        transcript,
        columns,
        firstRow,
        endRow,
        measuredWidth,
        displays,
        color: currentStore()?.getSnapshot().color ?? false,
      };
    },
    capture: () => {
      const store = currentStore();
      const before = store?.getSnapshot().state.transcript;
      let notices: readonly TranscriptEntry[] = [];
      return {
        published: () => {
          notices =
            store
              ?.getSnapshot()
              .state.transcript.slice(before?.length ?? 0)
              .filter((entry) => entry.role === 'notice') ?? [];
        },
        visible: () => {
          if (currentStore() !== store) return false;
          return notices.every((entry) => {
            if (printed.has(entry)) return true;
            const rendered = frame;
            if (
              rendered === undefined ||
              !Number.isFinite(rendered.columns) ||
              rendered.columns < 1 ||
              !Number.isFinite(rendered.measuredWidth) ||
              rendered.measuredWidth < rendered.columns
            )
              return false;
            const index = rendered.transcript.indexOf(entry);
            if (index < 0) return false;
            // Only acknowledgement walks history; ordinary streaming frames just replace frame metadata.
            const start = wrapTranscript(
              rendered.transcript.slice(0, index),
              rendered.columns,
              rendered.color,
              rendered.displays,
            ).length;
            const end = start + wrapTranscript([entry], rendered.columns, rendered.color).length;
            return start >= rendered.firstRow && end <= rendered.endRow;
          });
        },
      };
    },
  };
}
