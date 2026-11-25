/**
 * The deep tier's consented run and the origin it is frozen on ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §8): `providerEndpointOrigin` reads the resolver's pinned destination and nothing else, and `runConsentedProviderChecks` contacts exactly the
 * named providers at exactly the named origins, reading a key only after its destination was checked, and its abort reaches the request.
 */
import { describe, expect, it } from 'vitest';

import {
  createProviderResolver,
  providerEndpointOrigin,
  type ProviderResolver,
} from '../engine/providers.js';
import { recordingProvider, stubResolver } from '../popups/doctor.test-support.js';
import {
  ENDPOINT_CHANGED_DETAIL,
  KEY_GONE_DETAIL,
  runConsentedProviderChecks,
} from './doctor-deep.js';

/** What a target that was not contacted says, pinned by literal: each tells the person that nothing was sent. */
const ENDPOINT_CHANGED =
  'not contacted: its endpoint changed after the confirmation was shown, so nothing was sent';
const KEY_GONE =
  'not contacted: its key could not be read after the confirmation, so nothing was sent';

const KEY = ['sk', 'ant', 'consent', 'ABCDEF123456'].join('-');

const lifecycle = (signal: AbortSignal = new AbortController().signal) => ({
  signal,
  work: { retainWork: <T>(factory: () => Promise<T>): Promise<T> => factory() },
  assertAdmitting: (): void => undefined,
});

describe('providerEndpointOrigin', () => {
  it('reads the origin from the resolver’s pinned destination, an official one and a custom one', () => {
    const resolver = createProviderResolver({}, undefined, {
      providerStore: {
        list: () => [
          {
            id: 'synthetic-openai',
            name: 'openai',
            displayName: 'openai',
            baseUrl: 'https://gateway.example:8443/v1',
            defaultHeaders: {},
            isActive: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      validatedFetch: () => Promise.reject(new Error('no egress in this test')),
    });
    expect(providerEndpointOrigin(resolver, 'anthropic')).toBe('https://api.anthropic.com');
    expect(providerEndpointOrigin(resolver, 'openai')).toBe('https://gateway.example:8443');
  });

  it.each([
    'Custom endpoint configuration is invalid.',
    'Configured custom endpoint (origin unavailable).',
    'Custom endpoint: http://plain.example',
    'Custom endpoint: https://gateway.example/v1',
    'Official endpoint: https://user:pass@api.example',
    'Custom endpoint: https://gateway.example extra',
    // Not a URL at all, in the words the origin is written in (the whole text must be exactly the pinned form, and its address must parse).
    'Custom endpoint: not a url',
    'Custom endpoint: notaurl',
    // Text before the pinned form is not the pinned form.
    'prefix Custom endpoint: https://x',
    'prefix Official endpoint: https://api.anthropic.com',
  ])('is unknown for anything but an exact https origin: %s', (context) => {
    const resolver: ProviderResolver = {
      resolveProvider: () => undefined,
      keyFor: () => KEY,
      endpointContext: () => context,
    };
    expect(providerEndpointOrigin(resolver, 'openai')).toBeUndefined();
  });

  it('never falls back on the provider’s known base URL for a resolver that pins a custom destination it cannot name', () => {
    const resolver: ProviderResolver = {
      resolveProvider: () => undefined,
      keyFor: () => KEY,
      endpointKind: () => 'custom',
    };
    expect(providerEndpointOrigin(resolver, 'openai')).toBeUndefined();
  });
});

describe('runConsentedProviderChecks', () => {
  it('contacts exactly the named providers, with their own key', async () => {
    const anthropic = recordingProvider('anthropic');
    const openai = recordingProvider('openai');
    const seam = stubResolver({
      keys: { anthropic: KEY, openai: KEY },
      providers: { anthropic, openai },
    });
    const checks = await runConsentedProviderChecks(
      [{ providerId: 'anthropic', origin: 'https://api.anthropic.com' }],
      { resolver: seam.resolver, lifecycle: lifecycle() },
    );
    expect(checks.map((entry) => [entry.id, entry.status])).toEqual([['provider:anthropic', 'ok']]);
    expect(anthropic.requests.map((request) => request.key)).toEqual([KEY]);
    expect(openai.requests).toEqual([]);
    expect(seam.keyFor).toHaveBeenCalledTimes(1);
  });

  it('refuses a destination that is not the one named, and reads no key for it', async () => {
    const anthropic = recordingProvider('anthropic');
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    seam.origins.anthropic = 'https://moved.example';
    const checks = await runConsentedProviderChecks(
      [{ providerId: 'anthropic', origin: 'https://api.anthropic.com' }],
      { resolver: seam.resolver, lifecycle: lifecycle() },
    );
    expect(checks[0]).toMatchObject({ status: 'fail', detail: ENDPOINT_CHANGED });
    expect(anthropic.requests).toEqual([]);
    expect(seam.keyFor).not.toHaveBeenCalled();
  });

  it('refuses a destination the resolver can no longer name at all, and reads no key for it', async () => {
    const anthropic = recordingProvider('anthropic');
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    // The resolver’s pinned destination became the one it says when a custom endpoint was refused: no origin can be read from it.
    delete seam.origins.anthropic;
    expect(providerEndpointOrigin(seam.resolver, 'anthropic')).toBeUndefined();
    const checks = await runConsentedProviderChecks(
      [{ providerId: 'anthropic', origin: 'https://api.anthropic.com' }],
      { resolver: seam.resolver, lifecycle: lifecycle() },
    );
    expect(checks[0]).toMatchObject({ status: 'fail', detail: ENDPOINT_CHANGED });
    expect(anthropic.requests).toEqual([]);
    expect(seam.keyFor).not.toHaveBeenCalled();
  });

  it('says when the key is gone since the line, and sends nothing', async () => {
    const anthropic = recordingProvider('anthropic');
    const seam = stubResolver({ keys: {}, providers: { anthropic } });
    const checks = await runConsentedProviderChecks(
      [{ providerId: 'anthropic', origin: 'https://api.anthropic.com' }],
      { resolver: seam.resolver, lifecycle: lifecycle() },
    );
    expect(checks[0]).toMatchObject({ status: 'fail', detail: KEY_GONE });
    expect(anthropic.requests).toEqual([]);
  });

  it('a target whose adapter is gone is a failed row that says so, and nothing is read or sent, never a throw', async () => {
    // The destination is the one named and the key is there, but the resolver has no adapter for the provider any more.
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: {} });
    const checks = await runConsentedProviderChecks(
      [{ providerId: 'anthropic', origin: 'https://api.anthropic.com' }],
      { resolver: seam.resolver, lifecycle: lifecycle() },
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      id: 'provider:anthropic',
      label: 'Anthropic',
      status: 'fail',
      detail: 'no adapter',
    });
    expect(seam.keyFor).not.toHaveBeenCalled();
  });

  it('the two sentences that say a target was not contacted are these words, and each says that nothing was sent', () => {
    expect(ENDPOINT_CHANGED_DETAIL).toBe(ENDPOINT_CHANGED);
    expect(KEY_GONE_DETAIL).toBe(KEY_GONE);
    for (const detail of [ENDPOINT_CHANGED_DETAIL, KEY_GONE_DETAIL])
      expect(detail).toMatch(/^not contacted: .*, so nothing was sent$/u);
  });

  it('its abort reaches the request at once', async () => {
    const controller = new AbortController();
    const anthropic = recordingProvider('anthropic', () => new Promise(() => {}));
    const seam = stubResolver({ keys: { anthropic: KEY }, providers: { anthropic } });
    const pending = runConsentedProviderChecks(
      [{ providerId: 'anthropic', origin: 'https://api.anthropic.com' }],
      { resolver: seam.resolver, lifecycle: lifecycle(controller.signal) },
    );
    expect(anthropic.requests).toHaveLength(1);
    controller.abort();
    expect(anthropic.requests[0]?.signal?.aborted).toBe(true);
    const checks = await pending;
    expect(checks[0]).toMatchObject({ status: 'fail', detail: 'key test stopped' });
  });
});
