import type { ModelCatalogEntry } from '@relavium/llm';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { REPL_COMMANDS_BY_NAME } from '../../commands/repl-commands.js';
import { providerDisplayName } from '../../engine/providers.js';
import { ModelPickerView } from './model-picker-view.js';
import type { ModelPickerState } from './model-picker.js';

afterEach(cleanup);

const EMPTY: ModelPickerState = {
  entries: [],
  filter: '',
  selected: 0,
  loading: false,
  currentDefault: undefined,
  refreshedAt: undefined,
  banner: undefined,
  hint: undefined,
  effortTiers: [],
  phase: 'model',
  effortStep: false,
  pending: undefined,
  effortSelected: 0,
  currentEffort: undefined,
};

describe('the /models picker with no models yet (ADR-0146 §6, MVP-11 OD-20)', () => {
  it('points at the Home’s /providers, which is a command, and names no shell command', () => {
    const { lastFrame } = render(
      <ModelPickerView state={EMPTY} color={false} nowMs={0} scope="next-chat" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('no models yet — connect one with /providers on the Home');
    expect(frame).toContain('Ctrl+R');
    expect(frame).not.toMatch(/relavium|provider add|set-key/u);
    // `/providers` is the Home's: the chat registry has no such command, so the sentence says where it lives.
    expect(REPL_COMMANDS_BY_NAME.has('providers')).toBe(false);
  });
});

describe('the /models picker names a provider the way a person reads it (ADR-0145, MVP-11)', () => {
  const entry = (over: Partial<ModelCatalogEntry>): ModelCatalogEntry => ({
    modelId: 'claude-x',
    provider: 'anthropic',
    displayName: 'Claude X',
    pricingSource: 'catalog',
    priceKnown: true,
    available: true,
    deprecated: false,
    ...over,
  });
  const state: ModelPickerState = {
    ...EMPTY,
    entries: [
      entry({}),
      entry({
        modelId: 'gpt-x',
        provider: 'openai',
        available: false,
        unavailableReason: 'no-key',
      }),
    ],
  };

  it('shows the display name in the row and in the no-key chip when the host supplies the names', () => {
    const { lastFrame } = render(
      <ModelPickerView
        state={state}
        color={false}
        nowMs={0}
        providerName={providerDisplayName}
        scope="next-chat"
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Claude X · Anthropic');
    expect(frame).toContain('no key for OpenAI');
    expect(frame).not.toMatch(/ anthropic | openai/u);
  });

  it('keeps the id when the host supplies none (the view imports no engine code)', () => {
    const { lastFrame } = render(
      <ModelPickerView state={state} color={false} nowMs={0} scope="next-chat" />,
    );
    expect(lastFrame() ?? '').toContain('Claude X · anthropic');
  });
});
