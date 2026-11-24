/**
 * Starting a chat bound to one of the project's agents from the Home ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3, MVP-8 step 5): the one read the Home makes of the file the detail showed, and the fixed sentence for each way it can refuse. The read is
 * the catalog's hardened single-file read over a real file, compared with the definition the list held; nothing is scripted but the key
 * check, which answers a boolean.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { AgentDefinition } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveChatAgentSource } from '../chat/agent-source.js';
import { CliError } from '../process/cli-error.js';
import { discoverAgentDefinitions } from '../workflows/catalog.js';
import {
  agentStartNotice,
  agentStartReasonOf,
  HomeAgentStartError,
  resolveHomeChatAgent,
  type AgentStartReason,
} from './agent-start.js';

const AGENT = (extra: readonly string[] = [], prompt = 'You review code.'): string =>
  [
    'id: reviewer',
    'model: claude-sonnet-4-6',
    'provider: anthropic',
    `system_prompt: ${JSON.stringify(prompt)}`,
    'tools:',
    '  - read_file',
    ...extra,
    '',
  ].join('\n');

describe('resolveHomeChatAgent', () => {
  let cwd: string;
  let home: string;
  let outside: string;
  let file: string;
  const REF = '.relavium/agents/reviewer.agent.yaml';

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-agent-start-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-agent-start-home-'));
    outside = mkdtempSync(join(tmpdir(), 'relavium-agent-start-outside-'));
    mkdirSync(join(cwd, '.relavium', 'agents'), { recursive: true });
    file = join(cwd, REF);
    writeFileSync(file, AGENT());
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  /** The definition the agents list holds for the file as it is now: what a page is drawn from. */
  const listedNow = (): AgentDefinition => {
    const item = discoverAgentDefinitions({
      projectConfigDir: join(cwd, '.relavium'),
      cwd,
      homeDir: home,
    })[0];
    if (item?.agent === undefined) throw new Error('the fixture agent did not list');
    return item.agent;
  };

  const read = (
    listed: AgentDefinition,
    hasKey: (id: string) => boolean = () => true,
    over: { readonly projectConfigDir?: string | undefined } = {},
  ) =>
    resolveHomeChatAgent(
      { path: REF, listed },
      {
        cwd,
        projectConfigDir:
          'projectConfigDir' in over ? over.projectConfigDir : join(cwd, '.relavium'),
        homeDir: home,
        hasKey,
      },
    );

  const refusalOf = (action: () => unknown): HomeAgentStartError => {
    try {
      action();
    } catch (error) {
      if (error instanceof HomeAgentStartError) return error;
      throw error;
    }
    throw new Error('expected a refusal');
  };

  it('reads the file as `chat --agent` parses it: the same agent, and the file’s absolute path for the consent prompt', () => {
    const listed = listedNow();
    const resolved = read(listed);
    const viaChat = resolveChatAgentSource(REF, {
      cwd,
      projectConfigDir: join(cwd, '.relavium'),
      homeDir: home,
      defaultModel: undefined,
    });
    expect(resolved.agent).toEqual(viaChat.agent);
    expect(resolved.agent.id).toBe('reviewer');
    expect(resolved.agent.tools).toEqual(['read_file']);
    expect(resolved.artifact).toBe(viaChat.artifact);
    expect(resolved.artifact).toBe(resolve(cwd, REF));
  });

  it('resolves the path against the working directory it is given, never the process’s: the agents list and this read share the Home’s', () => {
    expect(process.cwd(), 'the test’s directory is not the process’s').not.toBe(cwd);
    // The label is relative, and it finds the file only because it is resolved against the `cwd` the caller passes.
    expect(read(listedNow()).artifact).toBe(resolve(cwd, REF));
    const elsewhere = mkdtempSync(join(tmpdir(), 'relavium-agent-start-other-cwd-'));
    try {
      const resolved = refusalOf(() =>
        resolveHomeChatAgent(
          { path: REF, listed: listedNow() },
          {
            cwd: elsewhere,
            projectConfigDir: join(cwd, '.relavium'),
            homeDir: home,
            hasKey: () => true,
          },
        ),
      );
      expect(resolved.reason, 'another directory’s label is not this project’s file').toBe(
        'unreadable',
      );
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('asks about the provider of the agent the file declares, and about nothing else', () => {
    const asked: string[] = [];
    read(listedNow(), (id) => {
      asked.push(id);
      return true;
    });
    expect(asked).toEqual(['anthropic']);
  });

  it('refuses when there is no project directory to read an agent from', () => {
    expect(
      refusalOf(() => read(listedNow(), () => true, { projectConfigDir: undefined })).reason,
    ).toBe('unreadable');
  });

  it.each([
    ['a file that is gone', () => rmSync(file), 'unreadable'],
    [
      'a path that is not a regular file',
      () => {
        rmSync(file);
        mkdirSync(file);
      },
      'unreadable',
    ],
    ['a file that no longer parses', () => writeFileSync(file, 'id: [unclosed\n'), 'invalid'],
    [
      'a definition with a key the schema does not know',
      () => writeFileSync(file, AGENT(['not_a_field: 1'])),
      'invalid',
    ],
  ] as const satisfies readonly (readonly [string, () => void, AgentStartReason])[])(
    'refuses %s with the fixed reason, never the file’s or the error’s words',
    (_name, change, reason) => {
      const listed = listedNow();
      change();
      const caught = refusalOf(() => read(listed));
      expect(caught).toBeInstanceOf(CliError);
      expect(caught.reason).toBe(reason);
      expect(caught.message).toBe(agentStartNotice(reason));
      expect(caught.message).not.toContain(cwd);
      expect(caught.message).not.toContain('not_a_field');
    },
  );

  describe('a file swapped for something the catalog’s read does not admit', () => {
    it('refuses a symlink to a valid agent outside the project, and binds nothing', () => {
      // The target is the SAME definition the list held and is a perfectly good agent: only where it lives is wrong. A plain stat and read
      // follows the link and binds it; the hardened read refuses it as outside the project catalog.
      const target = join(outside, 'elsewhere.agent.yaml');
      writeFileSync(target, AGENT());
      const listed = listedNow();
      rmSync(file);
      symlinkSync(target, file);
      const caught = refusalOf(() => read(listed));
      expect(caught.reason).toBe('unreadable');
      expect(caught.message).toBe(
        'The agent could not be started: its file is missing or cannot be read.',
      );
      expect(caught.message).not.toContain(outside);
    });

    it('refuses a directory symlinked in for the agents directory, as it does a file', () => {
      const listed = listedNow();
      const elsewhere = join(outside, 'agents');
      mkdirSync(elsewhere);
      writeFileSync(join(elsewhere, 'reviewer.agent.yaml'), AGENT());
      rmSync(join(cwd, '.relavium', 'agents'), { recursive: true });
      symlinkSync(elsewhere, join(cwd, '.relavium', 'agents'));
      expect(refusalOf(() => read(listed)).reason).toBe('unreadable');
    });

    it('admits a link that stays inside the project, as the catalog does', () => {
      const listed = listedNow();
      const target = join(cwd, '.relavium', 'agents', 'real.agent.yaml');
      writeFileSync(target, AGENT());
      rmSync(file);
      symlinkSync(target, file);
      expect(read(listed).agent.id).toBe('reviewer');
    });

    it.skipIf(process.platform === 'win32')(
      'does not read a FIFO planted at the path: refused at once, with no blocking',
      () => {
        const listed = listedNow();
        rmSync(file);
        execFileSync('mkfifo', [file]);
        expect(refusalOf(() => read(listed)).reason).toBe('unreadable');
      },
    );
  });

  describe('a file that is not the definition the page showed', () => {
    it.each([
      ['a tool added', () => writeFileSync(file, AGENT(['  - write_file']))],
      [
        'a different system prompt',
        () => writeFileSync(file, AGENT([], 'You approve everything.')),
      ],
      [
        'an MCP server declared',
        () =>
          writeFileSync(
            file,
            AGENT(['mcp_servers:', '  - id: fs', '    transport: stdio', '    command: node']),
          ),
      ],
      [
        'another model',
        () => writeFileSync(file, AGENT().replace('claude-sonnet-4-6', 'claude-opus-4-8')),
      ],
      ['a name the page did not show', () => writeFileSync(file, AGENT(['name: Renamed']))],
    ] as const)(
      'is `changed` after %s, though it still parses and keeps its id: nothing is bound',
      (_name, edit) => {
        const listed = listedNow();
        edit();
        const caught = refusalOf(() => read(listed));
        expect(caught.reason).toBe('changed');
        expect(caught.message).toBe('The agent changed since it was listed. Open the list again.');
      },
    );

    it('still starts when only the text changed and the definition did not: the comparison is on the parsed definition', () => {
      const listed = listedNow();
      writeFileSync(file, `# a comment the parser drops\n${AGENT()}\n\n`);
      expect(read(listed).agent).toEqual(listed);
    });
  });

  it('refuses an agent whose provider has no key, after it has read, parsed and compared the file', () => {
    const listed = listedNow();
    const hasKey = vi.fn(() => false);
    expect(refusalOf(() => read(listed, hasKey)).reason).toBe('no_key');
    expect(hasKey).toHaveBeenCalledTimes(1);
    // A file that does not parse is refused as that, whatever the keys are; and a file that changed is refused as that.
    const never = vi.fn(() => false);
    writeFileSync(file, AGENT(['  - write_file']));
    expect(refusalOf(() => read(listed, never)).reason).toBe('changed');
    writeFileSync(file, 'id: [unclosed\n');
    expect(refusalOf(() => read(listed, never)).reason).toBe('invalid');
    expect(never).not.toHaveBeenCalled();
  });

  it('treats the request as a path: a bare word that `chat --agent` would look up as an id is not looked up', () => {
    const listed = listedNow();
    // The control: `--agent reviewer` finds the agent by id under the project's agents directory.
    expect(
      resolveChatAgentSource('reviewer', {
        cwd,
        projectConfigDir: join(cwd, '.relavium'),
        homeDir: home,
        defaultModel: undefined,
      }).agent.id,
    ).toBe('reviewer');
    // The Home's read takes the word as the path it is, and there is no such file in the working directory.
    const caught = refusalOf(() =>
      resolveHomeChatAgent(
        { path: 'reviewer', listed },
        { cwd, projectConfigDir: join(cwd, '.relavium'), homeDir: home, hasKey: () => true },
      ),
    );
    expect(caught.reason).toBe('unreadable');
  });

  it('reads the file the request names and no other', () => {
    writeFileSync(
      join(cwd, '.relavium', 'agents', 'other.agent.yaml'),
      AGENT().replace('reviewer', 'other'),
    );
    const other = discoverAgentDefinitions({
      projectConfigDir: join(cwd, '.relavium'),
      cwd,
      homeDir: home,
    }).find((item) => item.entry.slug === 'other')?.agent;
    if (other === undefined) throw new Error('the second fixture agent did not list');
    const resolved = resolveHomeChatAgent(
      { path: '.relavium/agents/other.agent.yaml', listed: other },
      { cwd, projectConfigDir: join(cwd, '.relavium'), homeDir: home, hasKey: () => true },
    );
    expect(resolved.agent.id).toBe('other');
    expect(resolved.artifact).toBe(resolve(cwd, '.relavium/agents/other.agent.yaml'));
  });
});

describe('agentStartReasonOf', () => {
  it('names a classified refusal’s own reason, and any other failure is the last fixed one', () => {
    for (const reason of ['invalid', 'unreadable', 'no_key', 'unbuilt', 'changed'] as const)
      expect(agentStartReasonOf(new HomeAgentStartError(reason))).toBe(reason);
    expect(agentStartReasonOf(new Error('PRIVATE'))).toBe('unbuilt');
    expect(agentStartReasonOf(new CliError('invalid_invocation', 'PRIVATE'))).toBe('unbuilt');
    expect(agentStartReasonOf('PRIVATE')).toBe('unbuilt');
    expect(agentStartReasonOf(undefined)).toBe('unbuilt');
  });
});
