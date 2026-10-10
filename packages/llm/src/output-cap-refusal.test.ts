import { describe, expect, it } from 'vitest';

import {
  assertOutputCapPlanMatches,
  InvalidOutputCapPlanError,
  outputCapNativeOptions,
  outputCapPlanForRequest,
  prepareOutputCapPlan,
  prepareOutputCapRequest,
  type OutputCapIdentity,
} from './output-cap.js';
import type { LlmRequest } from './types.js';

const privateContent = 'offline-private-credential-and-content';
const failInspection = (): never => {
  throw new Error(privateContent, { cause: { privateContent } });
};
const identity: OutputCapIdentity = {
  model: 'gpt-5.4-pro',
  provider: 'openai',
  endpoint: 'official',
  maxTokens: undefined,
  providerOptions: { max_tokens: 33 },
};
const request: LlmRequest = { model: identity.model, messages: [] };

function throwingOptions(): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  Object.defineProperty(options, 'max_tokens', { enumerable: true, get: failInspection });
  return options;
}

function expectFixedRefusal(action: () => unknown): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(InvalidOutputCapPlanError);
  if (!(failure instanceof InvalidOutputCapPlanError)) throw new Error('missing typed refusal');
  expect(failure.message).toBe(new InvalidOutputCapPlanError().message);
  expect(failure.code).toBe('invalid_output_cap_plan');
  expect(Object.hasOwn(failure, 'cause')).toBe(false);
  expect(`${failure.message}\n${failure.stack}\n${JSON.stringify(failure)}`).not.toContain(
    privateContent,
  );
}

describe('output cap inspection refuses without retaining caller throwables (ADR-0101)', () => {
  it('protects factory identity access before native JSON capture', () => {
    expectFixedRefusal(() =>
      prepareOutputCapPlan({
        ...identity,
        get model() {
          return failInspection();
        },
      }),
    );
  });

  it('protects factory cap getters and proxy descriptor inspection', () => {
    expectFixedRefusal(() =>
      prepareOutputCapPlan({ ...identity, providerOptions: throwingOptions() }),
    );
    expectFixedRefusal(() =>
      prepareOutputCapPlan({
        ...identity,
        providerOptions: new Proxy({}, { getOwnPropertyDescriptor: failInspection }),
      }),
    );
  });

  it.each(['getter', 'own-keys'] as const)(
    'protects native option copying against %s failures',
    (kind) => {
      const plan = prepareOutputCapPlan(identity);
      const options =
        kind === 'getter' ? throwingOptions() : new Proxy({}, { ownKeys: failInspection });
      expectFixedRefusal(() => outputCapNativeOptions(plan, options));
    },
  );

  it.each(['getter', 'descriptor'] as const)(
    'protects genuine plan binding against %s failures',
    (kind) => {
      const plan = prepareOutputCapPlan(identity);
      const options =
        kind === 'getter'
          ? throwingOptions()
          : new Proxy({}, { getOwnPropertyDescriptor: failInspection });
      expectFixedRefusal(() =>
        assertOutputCapPlanMatches(plan, { ...identity, providerOptions: options }),
      );
    },
  );

  it('protects request plan lookup before factory construction', () => {
    expectFixedRefusal(() =>
      outputCapPlanForRequest(
        {
          ...request,
          get providerOptions() {
            return failInspection();
          },
        },
        'openai',
        'official',
      ),
    );
  });

  it('protects existing plan collection lookup', () => {
    expectFixedRefusal(() =>
      outputCapPlanForRequest(
        {
          ...request,
          get preparedOutputCaps() {
            return failInspection();
          },
        },
        'openai',
        'official',
      ),
    );
  });

  it.each(['getter', 'own-keys'] as const)(
    'protects request staging against native %s failures',
    (kind) => {
      const options =
        kind === 'getter' ? throwingOptions() : new Proxy({}, { ownKeys: failInspection });
      expectFixedRefusal(() =>
        prepareOutputCapRequest({ ...request, providerOptions: options }, 'openai', 'official'),
      );
    },
  );

  it('protects root request access during staging', () => {
    expectFixedRefusal(() =>
      prepareOutputCapRequest(
        {
          ...request,
          get providerOptions() {
            return failInspection();
          },
        },
        'openai',
        'official',
      ),
    );
  });

  it('stages an ordinary cap accessor once, retaining cap and unrelated data without freezing caller options', () => {
    let reads = 0;
    const options = {
      get max_tokens() {
        reads++;
        return 33;
      },
      temperature: 0.2,
    };
    const staged = prepareOutputCapRequest(
      { ...request, providerOptions: options },
      'openai',
      'official',
    );
    expect(reads).toBe(1);
    expect(staged.plan.effectiveCap).toBe(33);
    expect(staged.request.providerOptions).toEqual({ max_tokens: 33, temperature: 0.2 });
    expect(Object.isFrozen(options)).toBe(false);
    expect(prepareOutputCapRequest(staged.request, 'openai', 'official').plan).toBe(staged.plan);
    expect(reads).toBe(1);
  });
});
