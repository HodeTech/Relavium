import { render } from 'ink';
import { createElement } from 'react';
import type { SessionChatLifetime } from '../chat/session-chat-lifetime.js';
import { SessionInkInput } from '../chat/session-ink-input.js';
import { SessionInkMount } from '../chat/session-ink-mount.js';
import { SessionTerminalOwner } from '../chat/session-terminal-owner.js';
import type { NoticeFlush } from '../engine/effect-retention.js';
import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { resolveRenderMode } from '../render/render-mode.js';
import {
  defaultJobControlLifecycle,
  suspendFullScreen,
  wireJobControl,
  type JobControlBinding,
  type JobControlLifecycle,
} from '../render/suspend.js';
import {
  createNativePromptChannel,
  type NativePromptFlow,
  type NativePromptUi,
} from '../render/tui/native-prompt-channel.js';
import { NativePromptHost } from '../render/tui/native-prompt-host.js';

/** One pre-chat native mount shared by credential setup, session selection and safe restore recovery. */
export async function runStandaloneNativeFlow<T>(
  deps: {
    readonly lifetime: SessionChatLifetime;
    readonly io: CliIo;
    readonly global: Pick<GlobalOptions, 'color' | 'noAltScreen'>;
    readonly altScreen: boolean | undefined;
    readonly jobControlLifecycle?: JobControlLifecycle;
  },
  run: (context: {
    readonly flow: NativePromptFlow;
    readonly ui: NativePromptUi;
    readonly flushVisible: NoticeFlush;
  }) => Promise<T>,
): Promise<T> {
  const { lifetime, io } = deps;
  const owner = lifetime.surface.work;
  owner.assertAdmitting();
  if (
    io.nativeStdin === undefined ||
    io.nativeStdout === undefined ||
    io.nativeStderr === undefined
  )
    throw new CliError('cli_internal', '');
  const stdin = io.nativeStdin;
  const stdout = io.nativeStdout;
  const stderr = io.nativeStderr;
  const native = createNativePromptChannel();
  const ui = native.ui;
  const flow = native.flow;
  let sealed = false;
  let flushVisible: NoticeFlush | undefined;
  let acknowledgeReady: () => void = () => undefined;
  let rejectReady: (cause: unknown) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    acknowledgeReady = resolve;
    rejectReady = reject;
  });
  // A renderer can fail synchronously during acquisition, before the await below is reached.
  void ready.catch(() => undefined);
  const fail = (cause: unknown): void => {
    owner.failure(cause);
    flow.cancel();
    rejectReady(cause);
  };
  const stop = (): void => {
    sealed = true;
    flow.cancel();
    try {
      owner.assertAdmitting();
    } catch (cause) {
      rejectReady(cause);
    }
  };
  const cancelled = (): void => flow.cancel();
  owner.signal.addEventListener('abort', stop, { once: true });
  const removeInterrupt = lifetime.subscribeInterrupt(cancelled);
  let mount: SessionInkMount | undefined;
  let jobOwner: SessionTerminalOwner | undefined;
  try {
    const alternateScreen =
      resolveRenderMode({
        outputMode: 'tui',
        noAltScreenFlag: deps.global.noAltScreen === true,
        configAltScreen: deps.altScreen,
      }) === 'alt';
    const jobNative: { binding?: JobControlBinding } = {};
    jobOwner = new SessionTerminalOwner(lifetime.surface.invocation, owner.assertAdmitting, fail);
    const job = jobOwner.acquire((creation) => {
      creation.adopt({
        seal: () => jobNative.binding?.dispose(),
        release: () => {
          if (jobNative.binding === undefined) throw new CliError('cli_internal', '');
          return jobNative.binding.finish();
        },
      });
      return wireJobControl({
        suspendPort: lifetime.suspendPort,
        lifecycle: deps.jobControlLifecycle ?? defaultJobControlLifecycle,
        adopt: (binding) => {
          jobNative.binding = binding;
        },
        onFailure: owner.cleanupUncertain,
        run: (suspendTerminal, waitForContinue) =>
          suspendFullScreen(
            {
              suspendTerminal,
              writeControl: (text) => io.writeOutAcknowledged(text),
              inkOwnsAltScreen: true,
              altActive: alternateScreen,
              mouseActive: false,
            },
            waitForContinue,
          ),
      });
    });
    mount = new SessionInkMount({
      invocation: lifetime.surface.invocation,
      assertEntering: owner.assertAdmitting,
      failure: fail,
      suspendPort: lifetime.suspendPort,
      stopInput: () => {
        sealed = true;
        flow.cancel();
      },
      drainNative: job.finish,
      input: new SessionInkInput({
        input: stdin,
        invocation: lifetime.surface.invocation,
        failure: fail,
        acknowledge: (text) => io.writeOutAcknowledged(text),
      }),
    });
    mount.acquire(() =>
      render(
        createElement(NativePromptHost, {
          ui,
          color: deps.global.color,
          inputEnabled: () => !sealed,
          suspendPort: mount?.port,
          onSuspend: job.requestSuspend,
          onRendererReady: (flush: NoticeFlush) => {
            flushVisible = flush;
            acknowledgeReady();
          },
          onRendererError: (cause) => fail(new CliError('output_unavailable', '', { cause })),
        }),
        {
          stdin,
          stdout,
          stderr,
          interactive: true,
          alternateScreen,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      ),
    );
    void mount.exited.then(() => {
      if (!sealed) fail(new CliError('cli_internal', ''));
    }, fail);
    await ready;
    owner.assertAdmitting();
    if (flushVisible === undefined) throw new CliError('cli_internal', '');
    return await run({ flow, ui, flushVisible });
  } finally {
    sealed = true;
    try {
      flow.cancel();
      if (ui.getSnapshot().active) await flow.end();
    } finally {
      const closing = [mount?.close() ?? Promise.resolve(), jobOwner?.close() ?? Promise.resolve()];
      try {
        await Promise.all(closing);
      } finally {
        try {
          ui.dispose();
        } finally {
          removeInterrupt();
          owner.signal.removeEventListener('abort', stop);
        }
      }
    }
  }
}
