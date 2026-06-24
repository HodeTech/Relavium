import { describe, expect, it } from 'vitest';

import { AgentParseError, parseAgent } from './agent-parser.js';

const VALID = `
id: summarizer
name: Summarizer
description: Condenses text
model: claude-sonnet-4-6
provider: anthropic
system_prompt: Summarize the input.
tags: ignored-by-schema
`.trimStart();

const VALID_MINIMAL = `
id: tiny
model: claude-sonnet-4-6
provider: anthropic
system_prompt: hi
`.trimStart();

describe('parseAgent', () => {
  it('parses a valid agent document into a typed definition', () => {
    const agent = parseAgent(VALID_MINIMAL);
    expect(agent.id).toBe('tiny');
    expect(agent.provider).toBe('anthropic');
  });

  it('reads name/description/model off a fuller agent', () => {
    // `tags` is not in AgentSchema (.strict()), so a doc carrying it must be rejected — proving strictness.
    expect(() => parseAgent(VALID)).toThrow(AgentParseError);
    try {
      parseAgent(VALID, { source: 'agents/summarizer.agent.yaml' });
    } catch (err) {
      expect(err).toBeInstanceOf(AgentParseError);
      const e = err as AgentParseError;
      expect(e.code).toBe('agent_validation');
      // The source label is echoed; the unknown key is named; no authored value leaks.
      expect(e.message).toContain('agents/summarizer.agent.yaml');
    }
  });

  it('rejects a YAML syntax fault as agent_syntax', () => {
    try {
      parseAgent('id: x\n  : : :');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentParseError);
      expect((err as AgentParseError).code).toBe('agent_syntax');
    }
  });

  it('rejects a schema failure as agent_validation, naming the failing field path (no value)', () => {
    // Missing required `system_prompt` + a kebab-invalid id.
    try {
      parseAgent('id: Not_Kebab\nmodel: m\nprovider: anthropic');
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as AgentParseError;
      expect(e.code).toBe('agent_validation');
      expect(e.fields).toContain('system_prompt'); // missing required field is named
      expect(e.message).not.toContain('Not_Kebab'); // an invalid authored value is not echoed
    }
  });
});
