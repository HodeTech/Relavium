/** Predeclared semantic case identities and assertion signatures; not inferred from red results. */
export const causalWitnesses = {
  'native-whole-zero': {
    file: 'packages/llm/src/conformance/usage-evidence.test.ts',
    id: 'native usage evidence through actual offline SDK HTTP openai generate: omitted usage and empty usage cannot become complete zero',
    marker: 'USAGE_CAUSAL_NATIVE_OMISSION',
  },
  'native-required-zero': {
    file: 'packages/llm/src/conformance/usage-evidence.test.ts',
    id: 'native usage evidence through actual offline SDK HTTP openai generate: omitted usage and empty usage cannot become complete zero',
    marker: 'USAGE_CAUSAL_NATIVE_OMISSION',
  },
  'native-gross-as-net': {
    file: 'packages/llm/src/conformance/usage-evidence.test.ts',
    id: 'native usage evidence through actual offline SDK HTTP openai generate: omitted usage and empty usage cannot become complete zero',
    marker: 'USAGE_CAUSAL_NATIVE_OMISSION',
  },
  'borrowed-terminal': {
    file: 'packages/llm/src/usage-observation.test.ts',
    id: 'every evidence arm is owned before the terminal confirming read complete/stop: provider aliases cannot rewrite the held observation',
    marker: 'USAGE_CAUSAL_OWNED_TERMINAL',
  },
  'discard-prior-observation': {
    file: 'packages/llm/src/conformance/cumulative-usage.test.ts',
    id: 'installed SDK cumulative evidence never erases independent observations openai/stop/false: later incomplete usage retains earlier known quantities without becoming complete',
    marker: 'USAGE_CAUSAL_RETAINED_COUNTERS',
  },
  'omit-terminal-observation': {
    file: 'packages/llm/src/fallback-held-usage.test.ts',
    id: 'held terminal accounting survives the real attempt race stop/cancel/positive: preserves only the first valid observation once',
    marker: 'USAGE_CAUSAL_HELD_TERMINAL',
  },
  'omit-consumer-return-settlement': {
    file: 'packages/llm/src/fallback-consumer-return.test.ts',
    id: 'consumer return settles the engaged attempt return after text observes owned evidence once and closes all raw work',
    marker: 'USAGE_CAUSAL_CONSUMER_SETTLEMENT',
  },
  'omit-engine-pending': {
    file: 'apps/cli/src/engine/usage-coverage-crash-causal.e2e.test.ts',
    id: 'ADR-0104 invoked crash pending durability run uncapped: actual invocation survives SIGKILL as pending uncertainty',
    marker: 'USAGE_CAUSAL_CRASH_PENDING',
  },
  'omit-session-pending-aggregate': {
    file: 'apps/cli/src/engine/usage-coverage-crash-causal.e2e.test.ts',
    id: 'ADR-0104 invoked crash pending durability session uncapped: actual invocation survives SIGKILL as pending uncertainty',
    marker: 'USAGE_CAUSAL_CRASH_PENDING',
  },
  'remove-complete-receipt-owner': {
    file: 'packages/db/src/session-usage-activation.test.ts',
    id: 'ADR-0104 production session coverage atomically settles only exact live receipts through the sole cost writer',
    marker: 'USAGE_CAUSAL_RECEIPT_OWNER',
  },
  'omit-owner-basis': {
    file: 'ordinary-gate',
    id: 'current-ordinary-gate-refusal',
    marker: 'USAGE_OWNER_BASIS_REPLAY_NOT_REFUSED',
  },
  'omit-session-entry-taint': {
    file: 'session-roundtrip',
    id: 'zero-cost',
    marker: 'USAGE_SESSION_REVISION_TAINT_LOST',
  },
  'unqualified-reported-cost': {
    file: 'apps/cli/src/render/usage-coverage.test.ts',
    id: 'usage coverage across live and persisted cost projections uses the durable missing-price counter without adding queued observations twice',
    marker: 'USAGE_CAUSAL_REPORTED_UNCERTAINTY',
  },
  'unconditional-free-zero': {
    file: 'apps/cli/src/render/tui/format.test.ts',
    id: 'formatCostShort — coverage-qualified Home amounts calls only a verified fully priced zero free, preserving the canonical conversion',
    marker: 'USAGE_CAUSAL_VERIFIED_FREE',
  },
  'retain-completed-identity': {
    file: 'packages/shared/src/usage-coverage-fold.test.ts',
    id: "usage correlation owned across public identity mutation settles complete usage after 'producerId' mutation",
    marker: 'USAGE_CAUSAL_RETIRED_IDENTITY',
  },
  'borrowed-invocation-identity': {
    file: 'packages/shared/src/usage-coverage-fold.test.ts',
    id: "usage correlation owned across public identity mutation settles complete usage after 'producerId' mutation",
    marker: 'USAGE_CAUSAL_OWNED_IDENTITY',
  },
  'unwrapped-coverage-observer': {
    file: 'packages/core/src/engine/money-port-capabilities.test.ts',
    id: 'claimUsage/false/false/pause: coverage observer failure retains exact origin and engagement',
    marker: 'USAGE_CAUSAL_OBSERVER_ORIGIN',
  },
  'omit-pre-observer-evidence': {
    file: 'packages/core/src/engine/money-port-capabilities.test.ts',
    id: 'false/false: a throwing complete claim preserves observed quantities without inventing an actual ACK',
    marker: 'USAGE_CAUSAL_PRE_OBSERVER_EVIDENCE',
  },
  'usage-less-early-return': {
    file: 'packages/core/src/engine/usage-coverage-activation.test.ts',
    id: 'ADR-0104 production turn accounting retains useful missing output and unknown uncapped coverage',
    marker: 'USAGE_CAUSAL_DISPOSITION_ACK',
  },
  'omit-durable-disposition': {
    file: 'packages/core/src/engine/usage-coverage-activation.test.ts',
    id: 'ADR-0104 production turn accounting retains useful missing output and unknown uncapped coverage',
    marker: 'USAGE_CAUSAL_DISPOSITION_ACK',
  },
  'owner-prefix-receipt-query': {
    file: 'packages/db/src/session-usage-query.test.ts',
    id: 'session settlement exact-identity query shape prices a pending receipt once and performs no extra receipt lookup for duplicate settlement',
    marker: 'USAGE_QUERY_NOT_EXACT_IDENTITY',
  },
  'owner-prefix-receipt-delete': {
    file: 'packages/db/src/session-usage-query.test.ts',
    id: 'session settlement exact-identity query shape prices a pending receipt once and performs no extra receipt lookup for duplicate settlement',
    marker: 'USAGE_QUERY_NOT_EXACT_IDENTITY',
  },
  'owner-prefix-receipt-update': {
    file: 'packages/db/src/session-usage-query.test.ts',
    id: 'session settlement exact-identity query shape refines only the exact incomplete receipt and removes its unknown contribution once',
    marker: 'USAGE_QUERY_NOT_EXACT_IDENTITY',
  },
};
