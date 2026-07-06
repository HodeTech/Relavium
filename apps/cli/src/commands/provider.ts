import { providerKind, ProviderIdSchema, type ProviderId } from '@relavium/llm';
import type { ProviderRecord, ProviderStore } from '@relavium/db';
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
import type { GlobalOptions } from '../process/options.js';
import { writeRecordLines } from '../render/records.js';
import { stripTerminalControls } from '../render/tui/chat-projection.js';
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
  /** `provider add --pricing-url <url>` (2.5.G S10, ADR-0065 §1) — override the seeded `pricing_reference_url`
   *  (the public pricing page the user consults to hand-enter a price). A display-only pointer, never fetched. */
  readonly pricingUrl?: string;
  /** `provider list --verify` (2.5.G S11, ADR-0065 §6) — additionally run a bounded, key-redacted LIVE probe per
   *  registered provider (reusing `validateProviderKey`) and report its per-provider verification state. Opt-in
   *  because it makes a network request per key; absent ⇒ the fast offline listing (key-set status only). */
  readonly verify?: boolean;
}

export interface ProviderCommandDeps {
  readonly io: CliIo;
  readonly store: ProviderStore;
  readonly keychain: KeychainStore;
  readonly resolver: ProviderResolver;
  /** Read the API key (from stdin in production) — injected so tests supply a fixed key, never a real one. */
  readonly readSecret: () => Promise<string>;
  /** The invocation's global options — read ONLY by `provider list` for the `--json` machine-output contract
   *  (2.5.G S11, ADR-0049). Optional so a non-`list` caller (the onboarding wizard's `set-key`) need not build one;
   *  absent ⇒ human output. */
  readonly global?: GlobalOptions;
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

/** One provider's live verification outcome (2.5.G S11). `verified: null` ⇒ NOT probed (no key resolvable, or
 *  `--verify` was not passed); `true`/`false` ⇒ the probe's result. `detail` is a SHORT, already-key-REDACTED
 *  reason on failure (from `validateProviderKey`), else `null`. */
interface VerifyOutcome {
  readonly verified: boolean | null;
  readonly detail: string | null;
}

/** Live-probe one registered provider's key via the bounded, key-redacted {@link validateProviderKey} seam (shared
 *  with `provider test` + `/doctor --deep`). A provider with NO resolvable key (keychain → env both empty) is
 *  reported `null` (not verifiable), never probed — so `--verify` never hangs on a keyless provider. */
async function verifyProvider(
  record: ProviderRecord,
  deps: ProviderCommandDeps,
): Promise<VerifyOutcome> {
  const parsed = ProviderIdSchema.safeParse(record.name);
  if (!parsed.success) return { verified: false, detail: 'unknown provider' };
  const id = parsed.data;
  const provider = deps.resolver.resolveProvider(id);
  if (provider === undefined) return { verified: false, detail: 'no adapter' };
  let key: string;
  try {
    key = deps.resolver.keyFor(id); // keychain → env var → throws; never logged
  } catch {
    return { verified: null, detail: null }; // no key anywhere ⇒ nothing to verify
  }
  const result = await validateProviderKey(provider, key, KNOWN_PROVIDERS[id].testModel);
  return { verified: result.ok, detail: result.ok ? null : result.detail };
}

/** Collapse a provider-supplied verification detail to one clean line before it reaches the TTY — strip ANSI/C0/C1
 *  control bytes (a rogue provider error must not inject a cursor jump / `\r` line-overwrite) then squeeze
 *  whitespace, so one row stays one line. The stored/`--json` value is untouched (JSON escapes on its own). */
function oneLine(text: string): string {
  return stripTerminalControls(text).replace(/\s+/gu, ' ').trim();
}

async function providerList(args: ProviderCommandArgs, deps: ProviderCommandDeps): Promise<void> {
  const providers = deps.store.list();
  // Probe each provider up front (only when --verify) so the human + --json branches share one outcome set and the
  // output order is deterministic. Sequential over the ≤4 known providers, each bounded by validateProviderKey's
  // own timeout — no unbounded hang. Absent --verify, no probe runs (the fast offline listing).
  const outcomes = new Map<string, VerifyOutcome>();
  if (args.verify) {
    for (const p of providers) outcomes.set(p.name, await verifyProvider(p, deps));
  }

  if (deps.global?.json === true) {
    // ADR-0049 read-command NDJSON, key-free by construction (only the keychain-ref-derived `keySet` + the
    // redacted verify state, NEVER the key). `verified`/`verifyDetail` are `null` unless --verify was passed.
    writeRecordLines(
      deps.io,
      providers.map((p) => {
        const outcome = outcomes.get(p.name);
        return {
          name: p.name,
          baseUrl: p.baseUrl,
          keySet: p.apiKeyKeychainRef !== undefined,
          verified: outcome?.verified ?? null,
          verifyDetail: outcome?.detail ?? null,
        };
      }),
    );
    return;
  }

  if (providers.length === 0) {
    deps.io.writeOut(
      'No providers registered. Add a key with `relavium provider set-key <name>`.\n',
    );
    return;
  }
  for (const p of providers) {
    // "key set" is derived from the stored keychain ref (no key read) — never echo the key here.
    const status = statusColumn(p, args.verify === true, outcomes.get(p.name));
    deps.io.writeOut(`${p.name}\t${p.baseUrl}\t[${status}]\n`);
  }
}

/** The bracketed status column of a `provider list` row: the offline key-set marker, or — under `--verify` — the
 *  live probe result (`verified` / `no key` / `failed — <redacted reason>`). */
function statusColumn(
  record: ProviderRecord,
  verify: boolean,
  outcome: VerifyOutcome | undefined,
): string {
  if (!verify) return record.apiKeyKeychainRef !== undefined ? 'key set' : 'no key';
  if (outcome === undefined || outcome.verified === null) return 'no key';
  return outcome.verified ? 'verified' : `failed — ${oneLine(outcome.detail ?? 'verification failed')}`;
}

function providerAdd(args: ProviderCommandArgs, deps: ProviderCommandDeps): void {
  const id = parseProviderId(requireName(args));
  const meta = KNOWN_PROVIDERS[id];
  let baseUrl: string;
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
  } else {
    // PRESERVE a previously-set custom base_url — a re-run of `relavium provider add <id>` with no `--base-url` must
    // not silently reset it to the SDK default (2.5.G S9 review). A genuinely new row gets the provider's default.
    baseUrl = deps.store.get(id)?.baseUrl ?? meta.baseUrl;
  }
  // The pricing REFERENCE url (2.5.G S10, ADR-0065 §1) — the user-supplied `--pricing-url` (validated), else PRESERVE
  // an existing custom pointer (a re-run without the flag must not reset it), else the provider's default pricing page.
  let pricingUrl: string;
  if (args.pricingUrl !== undefined) {
    pricingUrl = requireHttpsPricingUrl(args.pricingUrl);
  } else {
    pricingUrl = deps.store.get(id)?.pricingReferenceUrl ?? meta.pricingUrl;
  }
  // Store the protocol `kind` for every provider (ADR-0065 §5 — populated for uniformity; the resolver derives it
  // from the closed id today, load-bearing only for a future custom provider).
  const record = deps.store.upsert({
    name: id,
    displayName: meta.displayName,
    baseUrl,
    kind: providerKind(id),
    pricingReferenceUrl: pricingUrl,
  });
  // `record.baseUrl` / `record.pricingReferenceUrl` are validated HTTPS URLs (a custom value round-trips through
  // `new URL().href`, so control bytes are percent-encoded) — terminal-safe to echo without a further sanitize.
  deps.io.writeOut(
    `Registered provider '${id}' (${record.baseUrl}). Store a key with \`relavium provider set-key ${id}\`. Find model prices at ${record.pricingReferenceUrl ?? pricingUrl} and set one with \`relavium models pricing\`.\n`,
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
      // Seed the default pricing pointer too, so a provider registered by `set-key` alone still carries it (2.5.G S10).
      pricingReferenceUrl: meta.pricingUrl,
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

/**
 * Validate a user-supplied `--pricing-url` (2.5.G S10) — a parseable **HTTPS** URL with no embedded credentials.
 * UNLIKE the base URL, a pricing reference is NEVER an egress target (never fetched/DNS-resolved), so the SSRF
 * literal-host block deliberately does NOT apply — it may point at any HTTPS host, incl. an internal wiki. The
 * NORMALIZED `url.href` is returned (not the raw input): `new URL()` percent-encodes any control byte in the
 * path/query/hash and rejects it in the host, so the stored + later-echoed pointer is inherently terminal-safe
 * (no separate sanitize needed at the render boundary). `javascript:` / `http:` / `user:pass@…` are rejected.
 */
function requireHttpsPricingUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError('invalid_invocation', '--pricing-url must be a valid URL.');
  }
  if (url.protocol !== 'https:') {
    throw new CliError('invalid_invocation', '--pricing-url must be HTTPS.');
  }
  if (urlHasCredentials(raw)) {
    throw new CliError('invalid_invocation', '--pricing-url must not embed credentials (user:pass@…).');
  }
  return url.href;
}

/** Dispatch a `relavium provider <action>` to its core, mapping a keychain-unavailable backend to exit 2. */
export async function runProviderCommand(
  args: ProviderCommandArgs,
  deps: ProviderCommandDeps,
): Promise<ExitCode> {
  try {
    switch (args.action) {
      case 'list':
        await providerList(args, deps);
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
