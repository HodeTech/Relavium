import { providerKind, ProviderIdSchema, type ProviderId } from '@relavium/llm';
import type { ProviderRecord, ProviderStore } from '@relavium/db';
import { isPrivateOrLocalHost, urlHasCredentials } from '@relavium/shared';

import {
  KNOWN_PROVIDERS,
  keyHint,
  validateProviderKey,
  type ProviderResolver,
} from '../engine/providers.js';
import { CliError, isCliError } from '../process/errors.js';
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
  /** The invocation's global options — read by `provider list` for the `--json` machine-output contract (2.5.G S11,
   *  ADR-0049). Required (like the sibling read commands `list`/`status`/`models`) so a future caller can never
   *  silently drop `--json`; a non-`list` caller (the wizard's `set-key`) passes a throwaway it never reads. */
  readonly global: GlobalOptions;
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

/** One provider's live verification outcome (2.5.G S11). `verified: null` ⇒ NOT verifiable (no key resolvable);
 *  `true`/`false` ⇒ the probe's result. `detail` is a SHORT reason: `'no key'` for the `null` case, an
 *  already-key-REDACTED failure reason (from `validateProviderKey`) for `false`, else `null`. So a `--json`
 *  consumer distinguishes "probed, no key" (`verified:null, verifyDetail:'no key'`) from "not probed"
 *  (`verified:null, verifyDetail:null`, the no-`--verify` record). */
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
  } catch (err) {
    // The ONE expected throw is keyFor's genuine key-absence (`invalid_invocation`) → report "no key" (distinct
    // from "not probed"). Any OTHER error (e.g. a native keychain-binding fault keyFor re-raises) is unexpected —
    // PROPAGATE it (a clean exit-2 fault for the whole command) rather than mislabel every provider "no key".
    if (isCliError(err) && err.code === 'invalid_invocation') {
      return { verified: null, detail: 'no key' };
    }
    throw err;
  }
  const result = await validateProviderKey(provider, key, KNOWN_PROVIDERS[id].testModel);
  // The failure detail is a REMOTE endpoint's error body — clean + bound it at the source so both the human row and
  // the `--json` `verifyDetail` carry the safe value (the key is already redacted by `validateProviderKey`).
  return { verified: result.ok, detail: result.ok ? null : cleanDetail(result.detail) };
}

/** The Unicode bidi-override + zero-width "Trojan Source" family the ASCII-only {@link stripTerminalControls}
 *  MISSES: LRE/RLE/PDF/LRO/RLO (U+202A–E), the isolates LRI/RLI/FSI/PDI (U+2066–9), the zero-width + directional
 *  marks (U+200B–F), the word-joiner (U+2060), and the BOM (U+FEFF). None has a legitimate use in a URL or a probe
 *  detail; left in, they visually reorder/hide text (a spoof), so they are stripped from any provider-supplied
 *  value echoed inline here. NOT added to the shared `stripTerminalControls` — that also renders chat bodies, where
 *  bidi controls ARE legitimate for RTL text. */
const BIDI_ZERO_WIDTH = /[\u200b-\u200f\u2060\u2066-\u2069\u202a-\u202e\ufeff]/gu;

/** C0/C1 control bytes + the {@link BIDI_ZERO_WIDTH} spoof family, as a NON-global tester (safe for `.test`) \u2014 none
 *  is valid in a base URL, so `requireHttpsUrl` REJECTS a raw containing any at `add` time, making the stored value
 *  inherently terminal-safe on every surface (list / `--json` / the add confirmation), not just after a render-strip. */
// eslint-disable-next-line no-control-regex -- intentionally matches C0/C1 control bytes to reject them from a URL
const UNSAFE_URL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2060\u2066-\u2069\u202a-\u202e\ufeff]/u;

/** Neutralize a provider-supplied string for inline echo: strip ANSI/C0/C1 control bytes ({@link stripTerminalControls})
 *  AND the {@link BIDI_ZERO_WIDTH} spoof family, then squeeze whitespace so one row stays one line. Used for a stored
 *  base URL (defense-in-depth over the add-time reject) and — via {@link cleanDetail} — a network-sourced probe detail. */
function stripInline(text: string): string {
  return stripTerminalControls(text).replace(BIDI_ZERO_WIDTH, '').replace(/\s+/gu, ' ').trim();
}

/** As {@link stripInline}, additionally length-BOUNDED — a probe `detail` comes from a remote endpoint's error body
 *  (unbounded), so cap it so one `--verify` row / one NDJSON line can never blow up a terminal or a line consumer.
 *  Cleaned AT THE SOURCE (in {@link verifyProvider} / {@link providerTest}) so BOTH the human and `--json` surfaces
 *  carry the safe value — the `--json` record is then safe without diverging from the raw-value NDJSON convention. */
function cleanDetail(text: string): string {
  const s = stripInline(text);
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

async function providerList(args: ProviderCommandArgs, deps: ProviderCommandDeps): Promise<void> {
  const providers = deps.store.list();
  // Probe each provider up front (only when --verify) so the human + --json branches share one outcome set. Run the
  // probes CONCURRENTLY (each bounded by validateProviderKey's own timeout + AbortController) so the worst case is
  // ONE timeout, not N serialized — the output order is still the deterministic `providers` order (the outcomes are
  // keyed by the unique provider name, read back during rendering). Absent --verify, no probe runs.
  const outcomes = new Map<string, VerifyOutcome>();
  if (args.verify) {
    const probed = await Promise.all(
      providers.map(async (p): Promise<[string, VerifyOutcome]> => [p.name, await verifyProvider(p, deps)]),
    );
    for (const [name, outcome] of probed) outcomes.set(name, outcome);
  }

  if (deps.global.json) {
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
    // "key set" is derived from the stored keychain ref (no key read) — never echo the key here. The base URL is
    // stored VERBATIM (requireHttpsUrl keeps the user's exact endpoint — NOT href-normalized) and add-time REJECTS
    // control/bidi, but a directly-tampered at-rest row (ADR-0050) could still carry one: strip it at the render
    // boundary too (defense-in-depth; the provider name is a closed kebab `ProviderId`, safe raw).
    const status = statusColumn(p, args.verify === true, outcomes.get(p.name));
    deps.io.writeOut(`${p.name}\t${stripInline(p.baseUrl)}\t[${status}]\n`);
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
  // `outcome.detail` is already cleaned + bounded at the source (verifyProvider → cleanDetail).
  return outcome.verified ? 'verified' : `failed — ${outcome.detail ?? 'verification failed'}`;
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
  // Strip the echoed URLs at the render boundary (defense-in-depth): `record.baseUrl` is add-time control/bidi
  // rejected + stored verbatim, `pricingReferenceUrl` is href-normalized — but a directly-tampered at-rest row
  // (ADR-0050) could still carry a spoof byte, so neutralize both before the TTY.
  deps.io.writeOut(
    `Registered provider '${id}' (${stripInline(record.baseUrl)}). Store a key with \`relavium provider set-key ${id}\`. Find model prices at ${stripInline(record.pricingReferenceUrl ?? pricingUrl)} and set one with \`relavium models pricing\`.\n`,
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
  // The detail is a REMOTE endpoint's message — clean + bound it before it reaches the TTY (a rogue endpoint must
  // not inject a cursor jump / bidi spoof via the failure line or the success ping). The key is already redacted.
  if (!result.ok) {
    throw new CliError('invalid_invocation', `${id}: ${cleanDetail(result.detail)}`);
  }
  deps.io.writeOut(`${id}: ${cleanDetail(result.detail)}.\n`);
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
  // FIRST — reject a control/bidi-bearing raw before it is stored OR echoed (incl. in the error messages below,
  // which interpolate `raw`). A legitimate base URL never contains these; rejecting here makes the verbatim-stored
  // value inherently terminal-safe on every surface (2.5.G S11). The reject message omits `raw` (no re-injection).
  if (UNSAFE_URL_CHARS.test(raw)) {
    throw new CliError(
      'invalid_invocation',
      'base URL must not contain control or bidirectional characters.',
    );
  }
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
