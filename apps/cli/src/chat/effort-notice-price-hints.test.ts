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
      "m has no price, so the cost cap ($0.05) does not apply to it. Price it with `relavium models pricing 'm' --provider PROVIDER_ID --input USD_PER_MTOK --output USD_PER_MTOK`, or set budget.strict_cost_cap to refuse an unpriced model.",
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
      "m has no audio, image, video rate, so the cost cap ($0.05) could not be applied to its audio, image, video output — its token cost still counts. Add one with `relavium models pricing 'm' --provider PROVIDER_ID --audio USD_PER_SECOND --image USD_PER_IMAGE --video USD_PER_SECOND`, or set budget.strict_cost_cap to refuse it instead.",
    );
  });
});
