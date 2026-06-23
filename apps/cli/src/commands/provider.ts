import { ProviderIdSchema, type ProviderId } from '@relavium/llm';
import type { ProviderStore } from '@relavium/db';

import { keyHint, type ProviderResolver } from '../engine/providers.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import {
  KeychainUnavailableError,
  keychainAccount,
  type KeychainStore,
} from '../secrets/keychain.js';

/**
 * The `relavium provider` command cores (workstream **2.C**) — register providers and manage their API keys
 * in the OS keychain. Framework-free (no `commander` import): parsed args + injected ports in, output via
 * the {@link CliIo}; a fault throws a typed {@link CliError} (exit 2). The store / keychain / resolver are
 * injected, so the cores unit-test with an in-memory keychain + `:memory:` db and never touch the real
 * keychain. A **full key is never written** to stdout/logs/`--json` — only a {@link keyHint} (last 4).
 *
 * The headless fallback for resolution is the env var (`RELAVIUM_<PROVIDER>_API_KEY`); the `secrets.enc`
 * encrypted-file fallback is deferred past v1.0 (keychain-and-secrets.md).
 */

/** The known providers (each has an `@relavium/llm` adapter) — display name, base URL, and a cheap test model. */
const KNOWN_PROVIDERS: Record<
  ProviderId,
  { displayName: string; baseUrl: string; testModel: string }
> = {
  anthropic: {
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    testModel: 'claude-haiku-4-5',
  },
  openai: {
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    testModel: 'gpt-5.4-mini',
  },
  gemini: {
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    testModel: 'gemini-2.5-flash',
  },
  deepseek: {
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    testModel: 'deepseek-chat',
  },
};

export type ProviderAction = 'list' | 'add' | 'set-key' | 'remove-key' | 'test';

export interface ProviderCommandArgs {
  readonly action: ProviderAction;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly model?: string;
}

export interface ProviderCommandDeps {
  readonly io: CliIo;
  readonly store: ProviderStore;
  readonly keychain: KeychainStore;
  readonly resolver: ProviderResolver;
  /** Read the API key (from stdin in production) — injected so tests supply a fixed key, never a real one. */
  readonly readSecret: () => Promise<string>;
}

/** Validate a provider name against the known `@relavium/llm` providers (`ProviderId`), or fail (exit 2). */
function parseProviderId(name: string): ProviderId {
  const result = ProviderIdSchema.safeParse(name);
  if (!result.success) {
    throw new CliError(
      'invalid_invocation',
      `unknown provider '${name}' — known providers: ${ProviderIdSchema.options.join(', ')}.`,
    );
  }
  return result.data;
}

function requireName(args: ProviderCommandArgs): string {
  if (args.name === undefined || args.name === '') {
    throw new CliError(
      'invalid_invocation',
      `\`relavium provider ${args.action}\` requires a provider name.`,
    );
  }
  return args.name;
}

function providerList(deps: ProviderCommandDeps): void {
  const providers = deps.store.list();
  if (providers.length === 0) {
    deps.io.writeOut(
      'No providers registered. Add a key with `relavium provider set-key <name>`.\n',
    );
    return;
  }
  for (const p of providers) {
    // "key set" is derived from the stored keychain ref (no key read) — never echo the key here.
    deps.io.writeOut(`${p.name}\t${p.baseUrl}\t[${p.apiKeyKeychainRef ? 'key set' : 'no key'}]\n`);
  }
}

function providerAdd(args: ProviderCommandArgs, deps: ProviderCommandDeps): void {
  const id = parseProviderId(requireName(args));
  const meta = KNOWN_PROVIDERS[id];
  const record = deps.store.upsert({
    name: id,
    displayName: meta.displayName,
    baseUrl: args.baseUrl === undefined ? meta.baseUrl : requireHttpsUrl(args.baseUrl),
  });
  deps.io.writeOut(
    `Registered provider '${id}' (${record.baseUrl}). Store a key with \`relavium provider set-key ${id}\`.\n`,
  );
}

async function providerSetKey(args: ProviderCommandArgs, deps: ProviderCommandDeps): Promise<void> {
  const id = parseProviderId(requireName(args));
  const meta = KNOWN_PROVIDERS[id];
  const key = await deps.readSecret(); // from stdin — never an argv flag
  const account = keychainAccount(id);
  deps.keychain.set(account, key); // KeychainUnavailableError surfaces (no silent plaintext fallback)
  // Register the row only if it's new — never overwrite a base URL the user set via `provider add --base-url`.
  if (deps.store.get(id) === undefined) {
    deps.store.upsert({ name: id, displayName: meta.displayName, baseUrl: meta.baseUrl });
  }
  deps.store.setKeychainRef(id, account); // the ref, NEVER the key value
  deps.io.writeOut(`Stored ${id} key ${keyHint(key)} in the OS keychain.\n`);
}

function providerRemoveKey(args: ProviderCommandArgs, deps: ProviderCommandDeps): void {
  const id = parseProviderId(requireName(args));
  const removed = deps.keychain.delete(keychainAccount(id));
  deps.store.clearKeychainRef(id);
  deps.io.writeOut(
    removed ? `Removed ${id} key from the OS keychain.\n` : `No ${id} key was stored.\n`,
  );
}

async function providerTest(args: ProviderCommandArgs, deps: ProviderCommandDeps): Promise<void> {
  const id = parseProviderId(requireName(args));
  const provider = deps.resolver.resolveProvider(id);
  if (provider === undefined) {
    throw new CliError('invalid_invocation', `no adapter for provider '${id}'.`);
  }
  const key = deps.resolver.keyFor(id); // keychain → env var → error; never logged
  const model = args.model ?? KNOWN_PROVIDERS[id].testModel;
  try {
    await provider.generate(
      {
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxTokens: 1,
      },
      key,
    );
  } catch (err) {
    // A clean failure. @relavium/llm already scrubs secrets from its error messages, but the key is in
    // scope HERE, so defensively redact any occurrence before surfacing — and do NOT attach `err` as the
    // cause (it could carry the key in a nested field that `--verbose` might render).
    const raw = err instanceof Error ? err.message : String(err);
    const scrubbed = raw.split(key).join(keyHint(key));
    throw new CliError('invalid_invocation', `${id}: key test failed — ${scrubbed}`);
  }
  deps.io.writeOut(`${id}: key works (${model}).\n`);
}

/**
 * Validate a user-supplied provider base URL: a parseable **HTTPS** URL (fail-fast at `add`). HTTPS-only
 * matches the at-routing-time gate (`@relavium/llm`'s `assertHttpsBaseUrl`, security-review.md §Network) and
 * keeps a plaintext `http:` endpoint from ever being persisted; the private/loopback/metadata range-block
 * stays at the routing-time gate (it needs host resolution this fail-fast deliberately does not do). The
 * value is stored **verbatim** (not `url.href`-normalized) to preserve the user's exact endpoint/trailing
 * slash; the routing-time gate re-parses it via `new URL()` anyway.
 */
function requireHttpsUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError('invalid_invocation', `invalid base URL: '${raw}'.`);
  }
  if (url.protocol !== 'https:') {
    throw new CliError('invalid_invocation', `base URL must be HTTPS, got '${raw}'.`);
  }
  return raw;
}

/** Dispatch a `relavium provider <action>` to its core, mapping a keychain-unavailable backend to exit 2. */
export async function runProviderCommand(
  args: ProviderCommandArgs,
  deps: ProviderCommandDeps,
): Promise<ExitCode> {
  try {
    switch (args.action) {
      case 'list':
        providerList(deps);
        break;
      case 'add':
        providerAdd(args, deps);
        break;
      case 'set-key':
        await providerSetKey(args, deps);
        break;
      case 'remove-key':
        providerRemoveKey(args, deps);
        break;
      case 'test':
        await providerTest(args, deps);
        break;
    }
    return EXIT_CODES.success;
  } catch (err) {
    // An unavailable keychain (locked / no Secret Service) is an environment fault → a clean exit-2 message.
    if (err instanceof KeychainUnavailableError) {
      throw new CliError('invalid_invocation', err.message, { cause: err });
    }
    throw err;
  }
}
