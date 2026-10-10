import { expect, it } from 'vitest';
import { makeLlmError } from '@relavium/llm';
import type { RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { AgentTurnError } from './agent-turn.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';

for (const outcome of ['protocol', 'transport', 'pending'] as const)
  it(`preserves a poll primary failure while exposing cleanup-only faults (${outcome})`, async () => {
    const base = createInMemoryHost();
    let polls = 0,
      executions = 0,
      cleanupFaults = 0;
    const host: typeof base = {
      ...base,
      setTimer: (ms, fire, kind) => {
        const disarm = base.setTimer(ms, fire, kind);
        return () => {
          disarm();
          if (kind === 'deadline' && polls > 0 && cleanupFaults === 0) {
            cleanupFaults++;
            throw new Error('PRIVATE-POLL-CLEANUP');
          }
        };
      },
    };
    const handle = new WorkflowEngine({
      host,
      executor: {
        execute: () => {
          executions++;
          return Promise.resolve({
            kind: 'media_job',
            job: {
              jobId: 'offline-job',
              provider: 'openai',
              model: 'offline-media',
              modality: 'image',
              units: 1,
            },
          });
        },
        pollMediaJob: () => {
          polls++;
          if (outcome === 'protocol')
            return Promise.reject(new AgentTurnError('internal', 'PRIVATE-POLL-PROTOCOL', false));
          if (outcome === 'transport') return Promise.reject(new Error('PRIVATE-POLL-TRANSPORT'));
          return Promise.resolve({ state: 'pending' });
        },
      },
    }).start({
      workflow: parseWorkflow(
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'poll-cleanup-precedence',
            agents: [
              { id: 'a', provider: 'openai', model: 'offline-media', system_prompt: 'offline' },
            ],
            nodes: [
              {
                id: 'work',
                type: 'agent',
                agent_ref: 'a',
                prompt_template: 'offline',
                output_modalities: ['image'],
              },
            ],
            edges: [],
          },
        }),
      ),
    });
    const events: RunEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') base.fireTimers();
    }
    expect(executions).toBe(1);
    expect(polls).toBe(1);
    expect(cleanupFaults).toBe(1);
    expect(events.find((event) => event.type === 'node:failed')).toMatchObject({
      error: { code: outcome === 'protocol' ? 'internal' : 'provider_unavailable' },
    });
    expect(events.at(-1)?.type).toBe('run:failed');
    expect(JSON.stringify(events)).not.toContain('PRIVATE-POLL-');
    await handle.depart();
    expect(await host.runLeases.read(handle.runId)).toBeUndefined();
    expect(base.armedCount() + base.deadlineCount() + base.livenessCount()).toBe(0);
  });

for (const kind of ['auth', 'context_overflow'] as const)
  for (const inject of [false, true])
    it(`retains a returned ${kind} poll refusal over secondary cleanup (${inject})`, async () => {
      const base = createInMemoryHost();
      let polls = 0,
        executions = 0,
        cleanupFaults = 0;
      const host: typeof base = {
        ...base,
        setTimer: (ms, fire, role) => {
          const disarm = base.setTimer(ms, fire, role);
          return () => {
            disarm();
            if (inject && role === 'deadline' && polls > 0 && cleanupFaults === 0) {
              cleanupFaults++;
              throw new Error('PRIVATE-RETURNED-POLL-CLEANUP');
            }
          };
        },
      };
      const handle = new WorkflowEngine({
        host,
        executor: {
          execute: () => {
            executions++;
            return Promise.resolve({
              kind: 'media_job',
              job: {
                jobId: 'offline-job',
                provider: 'openai',
                model: 'offline-media',
                modality: 'image',
                units: 1,
              },
            });
          },
          pollMediaJob: () => {
            polls++;
            return Promise.resolve({
              state: 'failed',
              error: makeLlmError({ kind, provider: 'openai', message: 'synthetic poll refusal' }),
            });
          },
        },
      }).start({
        workflow: parseWorkflow(
          JSON.stringify({
            schema_version: '1.0',
            workflow: {
              id: 'returned-poll-refusal',
              agents: [
                { id: 'a', provider: 'openai', model: 'offline-media', system_prompt: 'offline' },
              ],
              nodes: [
                {
                  id: 'work',
                  type: 'agent',
                  agent_ref: 'a',
                  prompt_template: 'offline',
                  output_modalities: ['image'],
                },
              ],
              edges: [],
            },
          }),
        ),
      });
      const events: RunEvent[] = [];
      for await (const event of handle.events) {
        events.push(event);
        if (event.type === 'run:paused') base.fireTimers();
      }
      expect({ polls, executions, cleanupFaults }).toEqual({
        polls: 1,
        executions: 1,
        cleanupFaults: inject ? 1 : 0,
      });
      expect(events.find((e) => e.type === 'node:failed')).toMatchObject({
        error: {
          code: kind === 'auth' ? 'provider_auth' : 'context_overflow',
          retryable: false,
        },
      });
      expect(events.at(-1)?.type).toBe('run:failed');
      expect(JSON.stringify(events)).not.toContain('PRIVATE-RETURNED');
      await handle.depart();
      expect(await host.runLeases.read(handle.runId)).toBeUndefined();
      expect(base.armedCount() + base.deadlineCount() + base.livenessCount()).toBe(0);
    });
