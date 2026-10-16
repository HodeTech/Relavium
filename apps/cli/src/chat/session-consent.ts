import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { createConsentGate } from '../engine/mcp-consent-gate.js';
import { createBoundConsentPrompter } from '../mcp/consent-prompt.js';
import type { BuildChatSessionOptions } from './session-host.js';
import { runSessionPrompt } from './session-prompt.js';
import type { SessionWorkOwner } from './session-work-owner.js';

/** Captured native consent belongs to the same actual host as the MCP construction it authorizes. */
export function createOwnedSessionConsentGate(
  deps: { readonly io: CliIo; readonly global: GlobalOptions; readonly homeDir: string },
  owner: SessionWorkOwner,
): NonNullable<BuildChatSessionOptions['consentGate']> {
  return createConsentGate({
    ...deps,
    signal: owner.signal,
    prompt: (subject) => {
      const prompt = createBoundConsentPrompter(deps.io);
      return runSessionPrompt(
        owner.invocation,
        deps.io,
        owner.assertAdmitting,
        owner.failure,
        (signal) => prompt(subject, { signal }),
        owner.signal,
      );
    },
  });
}
