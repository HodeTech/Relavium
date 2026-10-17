/** ADR-0113: native conversion order preserves an actual workflow's output-schema success. */
import type { RunEvent } from '@relavium/shared';
import { expect, it } from 'vitest';

import { createExpressionSandbox } from '../expression/sandbox.js';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';
import { createStandardNodeExecutor } from './node-handlers/dispatcher.js';

it('retains successful clean schema validation after delayed diagnostic hydration', async () => {
  const workflow = parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'conversion-order',
        nodes: [
          {
            id: 'derive',
            type: 'transform',
            transform:
              '(() => {let n=0;return {get name(){n++;return undefined},get message(){return n}};})()',
            output_schema: {
              type: 'object',
              properties: { message: { type: 'number', const: 1 } },
              required: ['message'],
              additionalProperties: false,
            },
          },
          { id: 'out', type: 'output' },
        ],
        edges: [{ from: 'derive', to: 'out' }],
      },
    }),
  );
  const engine = new WorkflowEngine({
    host: createInMemoryHost(),
    executor: createStandardNodeExecutor({ sandbox: await createExpressionSandbox() }),
  });
  const handle = engine.start({ workflow, inputs: {} });
  const events: RunEvent[] = [];
  for await (const event of handle.events) events.push(event);
  expect(events.at(-1), 'NATIVE_HYDRATION_WORKFLOW_SUCCESS').toMatchObject({
    type: 'run:completed',
    outputs: { out: { message: 1 } },
  });
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'node:completed', nodeId: 'derive', output: { message: 1 } }),
  );
});
