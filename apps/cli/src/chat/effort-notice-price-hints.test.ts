import { describe, expect, it } from 'vitest';

import { unpricedModelNote } from './effort-notice.js';

/**
 * The remedy the unpriced-model notice prints is a command the person pastes, and its flags and unit words come from the
 * pricing field table (`commands/pricing-fields.ts`), the one the shell parses. These tests pin the printed command byte
 * for byte, so a flag or a unit word changed in the table changes the notice here on purpose and not by accident (the
 * sentences around it are pinned by `effort-notice.test.ts`).
 */
describe('the price flags of the unpriced-model notice', () => {
  it('names the token pair for a model with no price, in the order the shell takes them', () => {
    expect(unpricedModelNote('m', 5_000_000, 'budget.strict_cost_cap')).toBe(
      "m has no price, so the cost cap ($0.0500) does not apply to it. Price it with `relavium models pricing 'm' --provider PROVIDER_ID --input-price USD_PER_MTOK --output-price USD_PER_MTOK`, or set budget.strict_cost_cap to refuse an unpriced model.",
    );
  });

  it.each([
    ['image', '--image USD_PER_IMAGE'],
    ['audio', '--audio USD_PER_SECOND'],
    ['video', '--video USD_PER_SECOND'],
  ] as const)('names the %s rate in its billed unit', (modality, hint) => {
    const note = unpricedModelNote('m', 5_000_000, 'budget.strict_cost_cap', [modality]);
    expect(note).toContain(`--provider PROVIDER_ID ${hint}\``);
  });

  it('lists several modalities sorted by name, each with its own unit', () => {
    expect(
      unpricedModelNote('m', 5_000_000, 'budget.strict_cost_cap', ['video', 'image', 'audio']),
    ).toBe(
      "m has no audio, image, video rate, so the cost cap ($0.0500) could not be applied to its audio, image, video output — its token cost still counts. Add one with `relavium models pricing 'm' --provider PROVIDER_ID --audio USD_PER_SECOND --image USD_PER_IMAGE --video USD_PER_SECOND`, or set budget.strict_cost_cap to refuse it instead.",
    );
  });
});

/**
 * The shell's remedy names the command's PRIMARY flags (`--input-price`, `--output-price`): `--input` and `--output` are still
 * accepted but deprecated, so a remedy that printed them would name a spelling the command's own help marks as old (MVP-11,
 * ADR-0145 §7.4). The interactive chat names no flag at all: it points at the Home's `/pricing` (OD-20, ADR-0122 §6).
 */
describe('the unpriced-model notice names no shell command inside the TUI', () => {
  it('names the primary spellings, never a deprecated one, in the shell wording', () => {
    const shell = unpricedModelNote('m', 5_000_000, 'budget.strict_cost_cap');
    expect(shell).toContain('--input-price USD_PER_MTOK --output-price USD_PER_MTOK');
    expect(shell).not.toMatch(/--input\b(?!-price)|--output\b(?!-price)/u);
  });

  it('points a chat at /pricing on the Home and names no command, flag or quoting', () => {
    const tui = unpricedModelNote('m', 5_000_000, '[chat] strict_cost_cap', undefined, 'tui');
    expect(tui).toBe(
      'm has no price, so the cost cap ($0.0500) does not apply to it. Price it from the Home with /pricing, or set [chat] strict_cost_cap to refuse an unpriced model.',
    );
    const media = unpricedModelNote(
      'm',
      5_000_000,
      '[chat] strict_cost_cap',
      ['image', 'audio'],
      'tui',
    );
    expect(media).toBe(
      'm has no audio, image rate, so the cost cap ($0.0500) could not be applied to its audio, image output — its token cost still counts. Add one from the Home with /pricing, or set [chat] strict_cost_cap to refuse it instead.',
    );
    for (const note of [tui, media]) expect(note).not.toMatch(/relavium|--|PROVIDER_ID|`/u);
  });

  it('keeps the model id sanitized in the TUI wording too (the id is still named, once)', () => {
    const note = unpricedModelNote(
      'evil\u001b]0;x\u0007id',
      5_000_000,
      '[chat] strict_cost_cap',
      undefined,
      'tui',
    );
    expect(note).not.toContain('\u001b');
    expect(note).not.toContain('\u0007');
  });
});
