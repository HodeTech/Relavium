import { providerKind, ProviderIdSchema, type ProviderId } from '@relavium/llm';
import type { ProviderStore } from '@relavium/db';
import { isPrivateOrLocalHost, urlHasCredentials } from '@relavium/shared';

import {
  KNOWN_PROVIDERS,
  keyHint,
  validateProviderKey,
  type ProviderResolver,
} from '../engine/providers.js';
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
  let baseUrl = meta.baseUrl;
  if (args.baseUrl !== undefined) {
    // A custom `--base-url` is **OpenAI-compatible only** this round (2.5.G S9, ADR-0065 §3) — refuse it on the
    // Anthropic/Gemini protocols with a clear message rather than silently ignoring it (the old dead-config bug).
    if (providerKind(id) !== 'openai-compatible') {
      throw new CliError(
        'invalid_invocation',
        `a custom --base-url is only supported for OpenAI-compatible providers (openai, deepseek); '${id}' uses the ${providerKind(id)} protocol.`,
      );
    }
    baseUrl = requireHttpsUrl(args.baseUrl);
  }
  // Store the protocol `kind` for every provider (ADR-0065 §5 — populated for uniformity; the resolver derives it
  // from the closed id today, load-bearing only for a future custom provider).
  const record = deps.store.upsert({ name: id, displayName: meta.displayName, baseUrl, kind: providerKind(id) });
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
    deps.store.upsert({
      name: id,
      displayName: meta.displayName,
      baseUrl: meta.baseUrl,
      kind: providerKind(id),
    });
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
  // The live ping + the defensive key-redaction live in `validateProviderKey` (the seam), shared with the
  // `/doctor --deep` probe so the secret-scrubbing has one tested home.
  const result = await validateProviderKey(provider, key, model);
  if (!result.ok) {
    throw new CliError('invalid_invocation', `${id}: ${result.detail}`);
  }
  deps.io.writeOut(`${id}: ${result.detail}.\n`);
}

/**
 * Validate a user-supplied provider base URL (fail-fast at `add`, 2.5.G S9): a parseable **HTTPS** URL, with no
 * embedded credentials and no **literal** private/loopback/link-local/metadata host — reusing the SAME shared
 * string-level primitives (`urlHasCredentials` / `isPrivateOrLocalHost`) the adapter's construction-time
 * `assertHttpsBaseUrl` and the `connectValidated` egress gate use, never a second hand-rolled parser (ADR-0029(d)).
 * The literal-host block gives a clear "no private address" error at `add`; the **resolve-time** DNS-rebinding
 * defense (a public hostname resolving to a private IP) stays with `connectValidated` (it needs host resolution
 * this fail-fast deliberately does not do). The value is stored **verbatim** (not `url.href`-normalized) to
 * preserve the user's exact endpoint/trailing slash; the routing-time gate re-parses it via `new URL()` anyway.
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
  if (urlHasCredentials(raw)) {
    throw new CliError('invalid_invocation', 'base URL must not embed credentials (user:pass@…).');
  }
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (isPrivateOrLocalHost(host)) {
    throw new CliError(
      'invalid_invocation',
      'base URL must not be a private, loopback, or link-local address.',
    );
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
