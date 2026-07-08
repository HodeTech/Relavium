import { describe, expect, it } from 'vitest';

import { AgentParseError, parseAgent } from './agent-parser.js';
import { MAX_SOURCE_CHARS } from './parser.js';

// Carries `tags`, which AgentSchema (.strict()) does not allow — used to prove the strict rejection.
const INVALID_EXTRA_KEY = `
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

  it('rejects an agent document with an unknown key (the schema is strict)', () => {
    // `tags` is not in AgentSchema (.strict()), so a doc carrying it must be rejected — proving strictness.
    expect(() => parseAgent(INVALID_EXTRA_KEY)).toThrow(AgentParseError);
    try {
      parseAgent(INVALID_EXTRA_KEY, { source: 'agents/summarizer.agent.yaml' });
      expect.unreachable('should have thrown');
    } catch (err) {
      if (!(err instanceof AgentParseError)) throw err; // narrows + fails the test on a wrong type
      expect(err.code).toBe('agent_validation');
      // The unknown key is named via issue.keys (a root-level unrecognized_keys), not collapsed to `agent`.
      expect(err.fields).toContain('tags');
      // The source label is echoed; no authored value leaks.
      expect(err.message).toContain('agents/summarizer.agent.yaml');
    }
  });

  it('rejects a YAML syntax fault as agent_syntax, attaching the fault line/column', () => {
    try {
      parseAgent('id: x\n  : : :', { source: 'agents/broken.agent.yaml' });
      expect.unreachable('should have thrown');
    } catch (err) {
      if (!(err instanceof AgentParseError)) throw err;
      expect(err.code).toBe('agent_syntax');
      // The fault is on line 2 — line/column are attached (1-based) AND folded into the message for actionable
      // diagnostics; the source label rides along. The YAML rule is the message body (secret-free, prettyErrors:false).
      expect(err.line).toBe(2);
      expect(typeof err.column).toBe('number');
      expect(err.message).toContain(`line ${err.line}, column ${err.column}`);
      expect(err.message).toContain('agents/broken.agent.yaml');
    }
  });

  it('does not echo an authored value in a syntax-fault message (secret-free)', () => {
    // A duplicate-key fault: the YAML rule ("Map keys must be unique") names no key/value, so no authored
    // content (here a plausible secret-shaped value) can ride the message.
    try {
      parseAgent('id: sk-live-not-a-real-secret-000\nid: other\nmodel: m');
      expect.unreachable('should have thrown');
    } catch (err) {
      if (!(err instanceof AgentParseError)) throw err;
      expect(err.code).toBe('agent_syntax');
      expect(err.message).not.toContain('sk-live-not-a-real-secret-000');
    }
  });

  it('rejects an anchor/alias with a clear message and no bogus position (maxAliasCount: 0)', () => {
    // Aliases are disabled in the hardened profile → a ReferenceError (not a positioned YAMLParseError), so the
    // message is the clear source-free label and no misleading line/column is attached.
    try {
      parseAgent('id: &x tiny\nmodel: *x\nprovider: anthropic\nsystem_prompt: hi');
      expect.unreachable('should have thrown');
    } catch (err) {
      if (!(err instanceof AgentParseError)) throw err;
      expect(err.code).toBe('agent_syntax');
      expect(err.message).toContain('anchors and aliases are not supported');
      expect(err.line).toBeUndefined();
      expect(err.column).toBeUndefined();
    }
  });

  it('rejects a schema failure as agent_validation, naming the failing field path (no value)', () => {
    // Missing required `system_prompt` + a kebab-invalid id.
    try {
      parseAgent('id: Not_Kebab\nmodel: m\nprovider: anthropic');
      expect.unreachable('should have thrown');
    } catch (err) {
      if (!(err instanceof AgentParseError)) throw err;
      expect(err.code).toBe('agent_validation');
      expect(err.fields).toContain('system_prompt'); // missing required field is named
      expect(err.message).not.toContain('Not_Kebab'); // an invalid authored value is not echoed
    }
  });

  it('prefixes the parent path for a NESTED unrecognized key (retry sub-schema is strict)', () => {
    // An unknown key inside the strict `retry` sub-schema — the field must be `retry.bogus`, not bare `bogus`.
    try {
      parseAgent(
        'id: a\nmodel: m\nprovider: anthropic\nsystem_prompt: hi\nretry:\n  max: 2\n  backoff: linear\n  bogus: 1\n',
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      if (!(err instanceof AgentParseError)) throw err;
      expect(err.code).toBe('agent_validation');
      expect(err.fields).toContain('retry.bogus'); // parent path preserved (not collapsed to `bogus`/`agent`)
    }
  });

  it('rejects a source over the parse limit as agent_syntax', () => {
    try {
      parseAgent('a'.repeat(MAX_SOURCE_CHARS + 1));
      expect.unreachable('should have thrown');
    } catch (err) {
      if (!(err instanceof AgentParseError)) throw err;
      expect(err.code).toBe('agent_syntax');
      expect(err.message).toContain('parse limit');
    }
  });
});
