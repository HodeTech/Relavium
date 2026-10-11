/** One explicit production mechanism per copied-source change; never changes test assertions. */
const llm = (name) => `packages/llm/src/${name}.test.ts`;
const core = (name) => `packages/core/src/engine/${name}.test.ts`;
const db = (name) => `packages/db/src/${name}.test.ts`;
const cli = (name) => `apps/cli/src/${name}.test.ts`;
const native = 'packages/llm/src/adapters/native-usage.ts';
const turn = 'packages/core/src/engine/agent-turn.ts';
const engine = 'packages/core/src/engine/engine.ts';
const receipt = 'packages/db/src/session-usage-receipt.ts';
const fold = 'packages/shared/src/usage-coverage-fold.ts';
const format = 'apps/cli/src/render/tui/format.ts';
const activation = [core('usage-coverage-activation'), core('usage-review-controls')];
const renders = [
  cli('render/usage-coverage'),
  cli('render/tui/format'),
  cli('render/tui/home-projection'),
];
const crash = [cli('engine/usage-coverage-crash-causal.e2e')];
export const mutations = [
  {
    id: 'native-whole-zero',
    group: 1,
    path: native,
    files: [llm('conformance/usage-evidence')],
    before: "ownUsageEvidence({ kind: 'missing', reason: 'not_reported' });",
    after: "ownUsageEvidence({ kind: 'complete', usage: { inputTokens: 0, outputTokens: 0 } });",
  },
  {
    id: 'native-required-zero',
    group: 1,
    path: native,
    files: [llm('conformance/usage-evidence')],
    before: 'if (value === undefined || value === null) return undefined;',
    after: 'if (value === undefined || value === null) return 0;',
  },
  {
    id: 'native-gross-as-net',
    group: 1,
    path: native,
    files: [llm('conformance/usage-evidence')],
    before: "let hit = deepseek ? o.count(field(raw, 'prompt_cache_hit_tokens')) : alias;",
    after: "let hit = deepseek ? o.count(field(raw, 'prompt_cache_hit_tokens')) : (alias ?? 0);",
  },
  {
    id: 'borrowed-terminal',
    group: 2,
    path: 'packages/llm/src/stream-grammar.ts',
    files: [llm('usage-observation')],
    before: `held =\n          chunk.type === 'stop'\n            ? Object.freeze({\n                type: 'stop',\n                stopReason: chunk.stopReason,\n                usage: ownUsageEvidence(chunk.usage),\n              })\n            : Object.freeze({ type: 'error', error: snapshotLlmError(chunk.error) });`,
    after: 'held = chunk;',
  },
  {
    id: 'discard-prior-observation',
    group: 2,
    path: native,
    files: [llm('conformance/cumulative-usage')],
    before: "if (current.kind === 'complete' || previous.kind === 'missing') return current;",
    after:
      "return current;\n  if (current.kind === 'complete' || previous.kind === 'missing') return current;",
  },
  {
    id: 'omit-terminal-observation',
    group: 2,
    path: 'packages/llm/src/stream-grammar.ts',
    files: [llm('fallback-held-usage')],
    before: 'if (usage !== undefined) onTerminalUsage?.(usage);',
    after: 'void usage; void onTerminalUsage;',
  },
  {
    id: 'omit-consumer-return-settlement',
    group: 2,
    path: 'packages/llm/src/fallback-chain.ts',
    files: [llm('fallback-consumer-return'), core('usage-consumer-return')],
    before: 'if (!predecessorSettled && (retentionFailure !== undefined || !attemptExited)) {',
    after: 'if (!predecessorSettled && retentionFailure !== undefined) {',
  },
  {
    id: 'omit-engine-pending',
    group: 3,
    path: engine,
    files: crash,
    nativeChildren: true,
    before: `const acknowledgement = await this.#emitDurable({\n          type: 'cost:usage_pending',\n          runId: this.runId,\n          nodeId: draft.nodeId,\n          model: draft.model,\n          invocation,\n        });\n        if (acknowledgement.kind !== 'persisted')\n          throw new DurableAppendNotPersistedError(acknowledgement);`,
    after: 'void draft;',
  },
  {
    id: 'omit-session-pending-aggregate',
    group: 3,
    path: receipt,
    files: crash,
    nativeChildren: true,
    before: 'changeCoverage(tx, result, 1, 0);',
    after: 'void result;',
  },
  {
    id: 'usage-less-early-return',
    group: 4,
    path: turn,
    files: activation,
    before: "const evidence = record.usage ?? { kind: 'missing', reason: 'not_reported' };",
    after:
      "const evidence = record.usage ?? { kind: 'missing', reason: 'not_reported' };\n    if (evidence.kind !== 'complete') return;",
  },
  {
    id: 'omit-durable-disposition',
    group: 4,
    path: 'packages/core/src/engine/money-durability.ts',
    files: activation,
    before: 'return this.#options.emitUsageDisposition(draft);',
    after: 'return undefined;',
  },
  {
    id: 'remove-complete-receipt-owner',
    group: 4,
    path: receipt,
    files: [db('session-usage-activation')],
    before:
      "if (receipt.sessionId !== sessionId || receipt.model !== model)\n    throw new SessionUsageError('receipt_invalid');",
    after: 'void sessionId; void model;',
  },
  {
    id: 'omit-owner-basis',
    group: 5,
    path: engine,
    mode: 'ordinary-gate',
    marker: 'USAGE_OWNER_BASIS_REPLAY_NOT_REFUSED',
    before: `const acknowledgement = await this.#emitDurable({\n      type: 'cost:coverage_started',\n      runId: this.runId,\n      basis,\n    });\n    if (acknowledgement.kind !== 'persisted')\n      throw new DurableAppendNotPersistedError(acknowledgement);`,
    after: 'void basis;',
  },
  {
    id: 'omit-session-entry-taint',
    group: 6,
    path: 'packages/db/src/session-usage-write.ts',
    mode: 'session-roundtrip',
    marker: 'USAGE_SESSION_REVISION_TAINT_LOST',
    before: `if (entry.revision !== entry.acknowledged) {\n    tx.update(agentSessions)\n      .set({ usageUnverified: true })\n      .where(eq(agentSessions.id, sessionId))\n      .run();\n  }`,
    after: 'void entry;',
  },
  {
    id: 'unqualified-reported-cost',
    group: 7,
    path: format,
    files: renders,
    before: "return notes.length === 0 ? amount : `${amount} known; ${notes.join('; ')}`;",
    after: 'return amount;',
  },
  {
    id: 'unconditional-free-zero',
    group: 7,
    path: format,
    files: renders,
    before:
      'return microcents === 0 &&\n    coverage !== undefined &&\n    isUsageCoverageComplete(coverage) &&\n    unpricedCalls === 0',
    after: 'return microcents === 0',
  },
  {
    id: 'retain-completed-identity',
    group: 8,
    path: fold,
    files: ['packages/shared/src/usage-coverage-fold.test.ts'],
    before: `this.#pending.delete(keyOf(invocation));\n    return true;\n  }\n  /** Fencing`,
    after: `return true;\n  }\n  /** Fencing`,
  },
  {
    id: 'owner-prefix-receipt-query',
    group: 8,
    path: receipt,
    files: [db('session-usage-query'), db('session-usage-activation')],
    marker: 'USAGE_QUERY_NOT_EXACT_IDENTITY',
    positiveFile: db('session-usage-activation'),
    before:
      'const row = tx.select().from(sessionUsageInvocations).where(identityWhere(receipt)).get();',
    after: `const row = tx.select().from(sessionUsageInvocations).where(eq(sessionUsageInvocations.sessionId, receipt.sessionId)).all().find((row) => row.producerId === receipt.invocation.producerId && row.ordinal === receipt.invocation.ordinal);`,
  },
  {
    id: 'borrowed-invocation-identity',
    group: 4,
    path: fold,
    files: ['packages/shared/src/usage-coverage-fold.test.ts'],
    before: `const ownedInvocation: UsageInvocation = {\n      producerId: invocation.producerId,\n      ordinal: invocation.ordinal,\n      dispatchId: invocation.dispatchId,\n      round: invocation.round,\n      chainAttempt: invocation.chainAttempt,\n    };`,
    after: 'const ownedInvocation: UsageInvocation = invocation;',
  },
  {
    id: 'unwrapped-coverage-observer',
    group: 4,
    path: turn,
    files: [core('money-port-capabilities'), core('observer-usage-receipt')],
    before: `claimUsage: (...args) => {\n            try {\n              return claimUsage.call(money, ...args);\n            } catch (error) {\n              return noteObserverFailure(error);\n            }\n          },`,
    after: 'claimUsage: (...args) => claimUsage.call(money, ...args),',
  },
  {
    id: 'omit-pre-observer-evidence',
    group: 4,
    path: turn,
    files: [core('money-port-capabilities'), core('observer-usage-receipt')],
    before: `if (!lateReceipt && record.providerInvoked && evidence.kind === 'complete')\n      usage.observedStopUsage = {\n        input: evidence.usage.inputTokens,\n        output: evidence.usage.outputTokens,\n      };`,
    after: 'void priorObservation;',
  },
];
export const permanentFiles = [
  cli('engine/usage-coverage-crash.e2e'),
  ...crash,
  db('session-usage-process.e2e'),
  'packages/shared/src/usage-coverage-fold.test.ts',
  'packages/shared/src/usage-coverage-scale.test.ts',
  db('session-usage-query'),
  db('session-usage-activation'),
  db('session-usage-scale'),
  cli('engine/fractional-media-history'),
  cli('chat/repl-info'),
  cli('commands/chat-list'),
  cli('commands/chat'),
  cli('commands/logs'),
  cli('render/tui/home-projection'),
  cli('render/tui/run-usage-publication'),
  cli('render/tui/session-view-model'),
  cli('render/tui/workflow-usage-ack'),
];
