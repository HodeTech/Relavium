import { ownUsageEvidence, type KnownUsageQuantities, type UsageEvidence } from '@relavium/shared';

/** Tests inspect known quantities only after validating and narrowing the new evidence contract. */
export function knownUsage(value: UsageEvidence): KnownUsageQuantities {
  const evidence = ownUsageEvidence(value);
  if (evidence.kind === 'complete') return evidence.usage;
  if (evidence.kind === 'partial') return evidence.known;
  throw new Error('The fixture did not report any usage quantities');
}
