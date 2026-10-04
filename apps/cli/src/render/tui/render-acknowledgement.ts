/** Ink render acknowledgement requires a live component and the exact writable output in its context. */
import { useApp, useStdout } from 'ink';
import { useCallback, useLayoutEffect, useRef } from 'react';

import type { NoticeFlush } from '../../engine/effect-retention.js';
import type { SuspendPort } from '../suspend.js';
import type { TranscriptAcknowledgement } from './transcript-acknowledgement.js';

const OUTPUT_FAILED = 'The terminal output closed before display could be acknowledged.';

function canWrite(output: NodeJS.WriteStream): boolean {
  return (
    output.writable &&
    (!('destroyed' in output) || output.destroyed !== true) &&
    (!('writableEnded' in output) || output.writableEnded !== true) &&
    (!('writableFinished' in output) || output.writableFinished !== true) &&
    (!('errored' in output) || output.errored === null || output.errored === undefined)
  );
}

/** Call after the component's input hooks, so successful passive setup precedes activation. */
export function useVisibleRenderFlush(
  onError: ((error: Error) => void) | undefined,
  suspendPort?: SuspendPort,
  transcript?: TranscriptAcknowledgement,
): NoticeFlush {
  const app = useApp();
  const { stdout } = useStdout();
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    let sawFailureEvent = false;
    const failed = (): void => {
      sawFailureEvent = true;
      if (!mounted.current) return;
      mounted.current = false;
      onError?.(new Error(OUTPUT_FAILED));
    };
    const release = (): void => {
      stdout.removeListener('close', failed);
      stdout.removeListener('error', failed);
      stdout.removeListener('close', release);
      stdout.removeListener('error', release);
    };
    stdout.on('close', failed);
    stdout.on('error', failed);
    if (!canWrite(stdout)) {
      mounted.current = false;
      onError?.(new Error(OUTPUT_FAILED));
    }
    return () => {
      mounted.current = false;
      if ('destroyed' in stdout && stdout.destroyed === true && !sawFailureEvent) {
        // A synchronous destroyed-state check can unwind React before Node emits its queued error.
        // Keep this owned error sink until that event/close, then release every listener. If destruction
        // already finished, Node's queued error/close runs before this next-tick release.
        stdout.once('close', release);
        stdout.once('error', release);
        if ('closed' in stdout && stdout.closed === true) process.nextTick(release);
      } else release();
    };
  }, [stdout, onError]);
  return useCallback(
    async (publish?: () => void | Promise<void>) => {
      const acknowledge = async (): Promise<void> => {
        if (!mounted.current || !canWrite(stdout)) throw new Error(OUTPUT_FAILED);
        const publication = transcript?.capture();
        await publish?.();
        publication?.published();
        await app.waitUntilRenderFlush();
        // A newly mounted viewport seeds a blank window, then measures its allocated height.
        // Flush that follow-up layout once; an actually clipped notice still refuses immediately.
        if (publication !== undefined && !publication.visible()) await app.waitUntilRenderFlush();
        // Ink can resolve its flush promise through a fallback yield when stdout cannot write.
        if (!mounted.current || !canWrite(stdout)) throw new Error(OUTPUT_FAILED);
        if (publication !== undefined && !publication.visible())
          throw new Error(
            'The published terminal notice was not visible; audit evidence was retained.',
          );
      };
      if (suspendPort === undefined) await acknowledge();
      else await suspendPort.withActiveTerminal(acknowledge);
    },
    [app, stdout, suspendPort, transcript],
  );
}
