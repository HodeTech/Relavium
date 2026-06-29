import type { ManagerSkippedTool } from '@relavium/mcp';
import type { McpServerRef } from '@relavium/shared';

import { loadResolvedConfig } from '../config/load.js';
import type { ProviderResolver } from '../engine/providers.js';
import { assembleToolEnv } from '../engine/tool-host/assemble.js';
import { createOsKeychainStore } from '../secrets/os-keychain.js';
import type { KeychainStore } from '../secrets/keychain.js';
import { buildProviderProbe, mcpSessionChecks } from './doctor-deep.js';
import type { DoctorProbes } from './doctor.js';

/**
 * Assemble the production {@link DoctorProbes} from the host's real ports (2.5.C S5). Pure CONSTRUCTION — every
 * probe is a closure, so building the set touches no keychain / network / config (a read happens only when
 * `/doctor` actually runs). Surfaces inject this once and hand it to the chat replCtx + the Home; a test injects
 * a fake `DoctorProbes` instead, so neither path needs a real keychain or a live provider.
 *
 * The MCP tier is read-only — it reports the SESSION's already-connected status (the bound agent's `mcp_servers`
 * + the manager's `mcpSkipped`), never a fresh connect/spawn (a security-review finding — see doctor-deep.ts).
 */

/** A never-set keychain account — reading it tests REACHABILITY (returns `null` if reachable, throws if not). */
const DOCTOR_KEYCHAIN_PROBE = 'doctor:reachability-probe';

export interface DoctorHostInputs {
  readonly cwd: string;
  readonly configPath?: string;
  /** The provider seam — the `--deep` probe validates each provider whose key resolves (keychain ∪ env). */
  readonly resolver: ProviderResolver;
  /** The bound agent's declared `mcp_servers` — the `--deep` MCP tier REPORTS these (all connected in a live
   *  session), never connects them. Empty (default) ⇒ "none configured". */
  readonly agentMcpServers?: readonly McpServerRef[];
  /** The tools the MCP manager dropped at discovery (`built.mcpSkipped`) — surfaced as warnings. */
  readonly mcpSkipped?: readonly ManagerSkippedTool[];
  /** The keychain to probe — defaults to the real OS keychain; a test injects an in-memory / faulting store. */
  readonly keychain?: KeychainStore;
}

export function assembleDoctorProbes(inputs: DoctorHostInputs): DoctorProbes {
  return {
    keychain: () => {
      // Reachability only: read a never-set account. `null` ⇒ reachable; a `KeychainUnavailableError` ⇒ down.
      const store = inputs.keychain ?? createOsKeychainStore();
      store.get(DOCTOR_KEYCHAIN_PROBE);
    },
    config: () => {
      loadResolvedConfig({
        cwd: inputs.cwd,
        ...(inputs.configPath === undefined ? {} : { configPath: inputs.configPath }),
      });
    },
    // The wired host capability arms (2.5.A: fs + process). Arm PRESENCE is independent of the fs-scope tier, so
    // the report is faithful with the safe `sandboxed` default — no dependency on the live session's tier.
    toolHost: assembleToolEnv({
      profile: 'chat-read-only',
      fsScopeTier: 'sandboxed',
      workspaceDir: inputs.cwd,
    }).host,
    deepProviders: buildProviderProbe({ resolver: inputs.resolver }),
    deepMcp: () =>
      Promise.resolve(mcpSessionChecks(inputs.agentMcpServers ?? [], inputs.mcpSkipped ?? [])),
  };
}
