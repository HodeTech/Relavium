import { describe, expect, it } from 'vitest';

import { serializeWorkflow, sessionToWorkflow } from './serializer.js';
import { readSessionExportMarker } from './session-marker.js';

const ISO = '2026-11-05T00:00:00.000Z';

describe('readSessionExportMarker', () => {
  it('reads back the session a scaffold was exported from', () => {
    const yaml = serializeWorkflow(
      sessionToWorkflow(
        {
          id: 'sess-42',
          agentSlug: 'coder',
          title: 'My Session',
          context: { workingDir: '/w', fsScopeTier: 'sandboxed' },
          status: 'active',
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCostMicrocents: 0,
          totalConservativeMicrocents: 0,
          createdAt: ISO,
          updatedAt: ISO,
        },
        [],
      ),
    );
    expect(readSessionExportMarker(yaml)).toBe('sess-42');
  });

  it('is undefined for a hand-authored workflow, another marker source, a non-string id, or undecodable text', () => {
    const doc = (relaviumExport: string): string =>
      `schema_version: '1.0'\nworkflow:\n  id: w\n  metadata:\n    relaviumExport: ${relaviumExport}\n  nodes: []\n`;
    expect(readSessionExportMarker("schema_version: '1.0'\nworkflow:\n  id: w\n")).toBeUndefined();
    expect(readSessionExportMarker(doc('{ source: other, sessionId: s }'))).toBeUndefined();
    expect(readSessionExportMarker(doc('{ source: session, sessionId: 7 }'))).toBeUndefined();
    expect(readSessionExportMarker(doc('{ source: session, sessionId: s }'))).toBe('s');
    expect(readSessionExportMarker('workflow: [unclosed')).toBeUndefined();
    // The hardened profile refuses an alias, so a marker cannot be smuggled through one.
    expect(
      readSessionExportMarker(
        `x: &m { source: session, sessionId: s }\nworkflow:\n  metadata:\n    relaviumExport: *m\n`,
      ),
    ).toBeUndefined();
  });
});
