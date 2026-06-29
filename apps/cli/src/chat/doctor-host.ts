import type { McpServerConfig } from '@relavium/mcp';
import type { McpServerRegistration } from '@relavium/shared';

import { loadResolvedConfig } from '../config/load.js';
import { resolveMcpServerRef, resolveServerConfigs } from '../engine/mcp-servers.js';
import type { ProviderResolver } from '../engine/providers.js';
import { assembleToolEnv } from '../engine/tool-host/assemble.js';
import { sanitizeInline } from '../render/tui/chat-projection.js';
import { createOsKeychainStore } from '../secrets/os-keychain.js';
import type { KeychainStore } from '../secrets/keychain.js';
import type { McpSecretResolver } from '../secrets/mcp-secret.js';
import { buildMcpProbe, buildProviderProbe } from './doctor-deep.js';
import { failCheck, type DoctorCheck, type DoctorProbes } from './doctor.js';

/**
 * Assemble the production {@link DoctorProbes} from the host's real ports (2.5.C S5). Pure CONSTRUCTION — every
 * probe is a closure, so building the set touches no keychain / network / config (a read happens only when
 * `/doctor` actually runs). Surfaces inject this once and hand it to the chat replCtx + the Home; a test injects
 * a fake `DoctorProbes` instead, so neither path needs a real keychain or a live provider/MCP server.
 */

/** A never-set keychain account — reading it tests REACHABILITY (returns `null` if reachable, throws if not). */
const DOCTOR_KEYCHAIN_PROBE = 'doctor:reachability-probe';

export interface DoctorHostInputs {
  readonly cwd: string;
  readonly configPath?: string;
  /** The provider seam — the `--deep` probe validates each provider whose key resolves (keychain ∪ env). */
  readonly resolver: ProviderResolver;
  /** The config `[[mcp_servers]]` registrations — the `--deep` MCP probe connects each (global, both surfaces). */
  readonly mcpRegistrations: readonly McpServerRegistration[];
  /** The MCP named-secret resolver (2.R) — threaded into the server-config build so `{{secrets.*}}` resolve. */
  readonly mcpSecretResolver?: McpSecretResolver;
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
    deepMcp: () => runMcpProbe(inputs),
  };
}

/** Resolve the config registrations to connect-specs LAZILY (only when `--deep` runs) and guard the build: a
 *  malformed registration becomes a single failed check, never a thrown crash through the REPL/Home. */
function runMcpProbe(inputs: DoctorHostInputs): Promise<readonly DoctorCheck[]> {
  let servers: readonly McpServerConfig[];
  try {
    const refs = inputs.mcpRegistrations.map((reg) =>
      resolveMcpServerRef({ ref: reg.name }, inputs.mcpRegistrations),
    );
    servers = resolveServerConfigs(refs, inputs.cwd, inputs.mcpSecretResolver);
  } catch (err) {
    const detail = err instanceof Error ? sanitizeInline(err.message) : 'config error';
    return Promise.resolve([failCheck('mcp', 'MCP servers', detail)]);
  }
  return buildMcpProbe({ servers })();
}
