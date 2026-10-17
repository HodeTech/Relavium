import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertExit, ndjson, poll, startOwned } from './process.mjs';

export async function assertInstalledChat(context) {
  const { root, Database, cli, environment, calls } = context;
  const home = join(root, 'chat-home'),
    cwd = join(root, 'chat-workspace');
  mkdirSync(home);
  mkdirSync(cwd);
  mkdirSync(join(cwd, '.relavium'));
  writeFileSync(
    join(cwd, '.relavium/project.toml'),
    '[chat]\nmax_turns = 4\nauto_compact = false\n',
  );
  writeFileSync(
    join(cwd, 'probe.agent.yaml'),
    'id: packaged-chat\nprovider: openai\nmodel: gpt-4o-mini\nsystem_prompt: Synthetic offline packaged chat.\ntools: []\nmax_tokens: 64\n',
  );
  const prompts = ['packaged-user-one', 'packaged-user-two'];
  const replies = ['packaged-assistant-one', 'packaged-assistant-two'];
  const dbPath = join(home, '.relavium/history.db');
  const snapshot = () => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return {
        sessions: db.prepare('SELECT * FROM agent_sessions').all(),
        messages: db.prepare('SELECT * FROM session_messages ORDER BY sequence_number').all(),
        costs: db.prepare('SELECT * FROM session_costs').all(),
      };
    } finally {
      db.close();
    }
  };
  const runs = [];
  const before = calls().length;
  async function drive(args, index) {
    const env = environment(home, {
      RELAVIUM_OPENAI_API_KEY: 'sk-relavium-synthetic-package-smoke',
      RELAVIUM_PACKAGE_SMOKE_PROMPT: prompts[index],
      RELAVIUM_PACKAGE_SMOKE_REPLY: replies[index],
    });
    const owned = startOwned(cli(args), { cwd, env });
    let lastReadError;
    try {
      owned.child.stdin.write(prompts[index] + '\n');
      await poll(
        () => {
          assert.equal(
            owned.isSettled(),
            false,
            `Chat exited before a completed turn: ${owned.output().stderr}`,
          );
          return ndjson(owned.output().stdout.split('\n').slice(0, -1).join('\n')).some(
            (event) => event.type === 'session:turn_completed',
          );
        },
        20000,
        'Actual installed AgentSession did not complete a turn',
      );
      const events = ndjson(owned.output().stdout);
      const completed = events.filter((event) => event.type === 'session:turn_completed');
      assert.equal(completed.length, 1);
      assert.equal(completed[0].error, undefined);
      assert.ok(owned.output().stdout.includes(replies[index]));
      await poll(
        () => {
          try {
            return snapshot().messages.some(
              (row) => row.role === 'assistant' && JSON.stringify(row).includes(replies[index]),
            );
          } catch (error) {
            lastReadError = String(error);
            return false;
          }
        },
        5000,
        `Assistant reply not persisted before end: ${lastReadError}`,
      );
      assert.equal(owned.isSettled(), false, 'Stdin must remain held until assistant persistence');
      owned.child.stdin.end('/exit\n');
      const result = await owned.result();
      assertExit(result, 4);
      runs.push({
        args,
        exit: result.code,
        events: ndjson(result.stdout).map((event) => event.type),
        exitSentAfterPersist: true,
        outputBytes: result.bytes,
      });
    } finally {
      await owned.close();
    }
  }
  await drive(['chat', '--agent', './probe.agent.yaml', '--json'], 0);
  const first = snapshot();
  assert.equal(first.sessions.length, 1);
  assert.equal(first.messages.length, 2);
  const id = first.sessions[0].id;
  await drive(['chat-resume', id, '--json'], 1);
  const final = snapshot();
  assert.equal(final.sessions.length, 1);
  assert.equal(final.sessions[0].id, id);
  assert.equal(final.sessions[0].status, 'ended');
  assert.deepEqual(
    final.messages.map((row) => [row.sequence_number, row.role]),
    [
      [0, 'user'],
      [1, 'assistant'],
      [2, 'user'],
      [3, 'assistant'],
    ],
  );
  for (const [index, marker] of [prompts[0], replies[0], prompts[1], replies[1]].entries())
    assert.ok(JSON.stringify(final.messages[index]).includes(marker));
  const observed = calls().slice(before);
  const dispatches = observed.filter((call) => call.operation === 'sdk-fetch');
  assert.equal(dispatches.length, 2);
  assert.ok(
    dispatches[1].body.messages.some(
      (message) => message.role === 'user' && message.content === prompts[0],
    ),
  );
  assert.ok(
    dispatches[1].body.messages.some(
      (message) => message.role === 'assistant' && message.content === replies[0],
    ),
  );
  const attempts = observed.filter((call) => call.operation === 'keyring.Entry');
  assert.equal(attempts.length, 2);
  for (const attempt of attempts)
    assert.deepEqual(
      [attempt.service, attempt.account, attempt.denied],
      ['relavium', 'openai:default', true],
    );
  assert.equal(
    observed.filter((call) => call.denied && call.operation !== 'keyring.Entry').length,
    0,
  );
  const session = final.sessions[0];
  assert.equal(session.total_input_tokens, 22);
  assert.equal(session.total_output_tokens, 14);
  assert.equal(session.total_cost_microcents, 1170);
  assert.equal(session.usage_unverified, 0);
  assert.equal(session.usage_pending_invocations, 0);
  assert.equal(session.usage_unknown_calls, 0);
  assert.equal(session.usage_mutation_revision, session.usage_ack_revision);
  assert.equal(final.costs.length, 1);
  assert.equal(final.costs[0].call_count, 2);
  assert.equal(final.costs[0].cost_microcents, session.total_cost_microcents);
  return {
    sessionId: id,
    runs,
    dispatches: 2,
    keyringDeniedAttempts: 2,
    forbiddenNetworkOrProcessCalls: 0,
    transcript: final.messages,
    usage: session,
    costs: final.costs,
    sdkRequests: dispatches,
  };
}
