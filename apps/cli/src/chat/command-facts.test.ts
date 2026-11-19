import { describe, expect, it } from 'vitest';

import {
  codeCarrier,
  commandCardFacts,
  namesProtectedPath,
  programName,
  type CommandFactsInput,
} from './command-facts.js';

/** ADR-0118 §1: the code-carrier table, the protected-path warning, and the answers a command card offers. */
describe('the program name', () => {
  it.each([
    ['bash', 'bash'],
    ['/usr/bin/BASH', 'bash'],
    ['C:\\Tools\\Python.EXE', 'python'],
    ['./scripts/Build.sh', 'build.sh'],
    ['', ''],
  ])('%s is %s: the base name, case-folded, without a trailing .exe', (program, name) => {
    expect(programName(program)).toBe(name);
  });
});

describe('the code-carrier table', () => {
  it.each(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd'])(
    'a shell (%s) is a carrier in any invocation, even with no arguments',
    (shell) => {
      expect(codeCarrier([shell])).toBe('shell');
      expect(codeCarrier([shell, 'script.sh'])).toBe('shell');
    },
  );

  it.each(['python', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'osascript'])(
    'an interpreter (%s) is a carrier only when an argument is exactly an inline-code flag',
    (interpreter) => {
      for (const flag of ['-c', '-e', '-E', '-p', '-r', '--eval', '--command', '--print'])
        expect(codeCarrier([interpreter, flag, 'x']), flag).toBe('inline-code');
      expect(codeCarrier([interpreter, 'build.js'])).toBeUndefined();
      expect(codeCarrier([interpreter, '-m', 'pytest'])).toBeUndefined();
      expect(codeCarrier([interpreter, '--version'])).toBeUndefined();
      expect(codeCarrier([interpreter, '-cx'])).toBeUndefined(); // the table is exact, not a prefix match
    },
  );

  it.each([
    'env',
    'sudo',
    'doas',
    'xargs',
    'nohup',
    'nice',
    'timeout',
    'time',
    'stdbuf',
    'exec',
    'command',
    'ssh',
    'watch',
  ])('a wrapper (%s) is a carrier itself: the wrapped command is not parsed', (wrapper) => {
    expect(codeCarrier([wrapper, 'ls'])).toBe('wrapper');
    expect(codeCarrier([wrapper])).toBe('wrapper');
  });

  it('find is a carrier only with -exec, -execdir, -ok or -okdir', () => {
    for (const flag of ['-exec', '-execdir', '-ok', '-okdir'])
      expect(codeCarrier(['find', '.', flag, 'rm', '{}', ';']), flag).toBe('wrapper');
    expect(codeCarrier(['find', '.', '-name', '*.ts'])).toBeUndefined();
  });

  it('is compared by base name, case-folded, without .exe, so a path or a spelling does not slip past', () => {
    expect(codeCarrier(['/usr/bin/env', 'ls'])).toBe('wrapper');
    expect(codeCarrier(['C:\\Windows\\System32\\CMD.EXE', '/c', 'dir'])).toBe('shell');
    expect(codeCarrier(['/opt/py/PYTHON3', '-c', 'print(1)'])).toBe('inline-code');
  });

  it.each([['ls', '-la'], ['git', 'status'], ['npm', 'test'], ['cat', 'a b'], ['make']])(
    'an ordinary command (%s) is not a carrier',
    (...argv) => {
      expect(codeCarrier(argv)).toBeUndefined();
    },
  );

  it('an empty argv is nothing', () => {
    expect(codeCarrier([])).toBeUndefined();
  });
});

describe('a protected path named in an argument (resolved lexically against the working directory)', () => {
  const cwd = '/work/project';

  it.each([
    [['cat', '.env']],
    [['cat', '.env.production']],
    [['cat', '.ssh/id_rsa']],
    [['cat', '../.ssh/config']],
    [['cat', '/home/me/.aws/credentials']],
    [['cat', '.docker/config.json']],
    [['cat', '.git/config']],
    [['cp', 'a', '.relavium/config.toml']],
    [['tool', '--env-file=.env']],
    [['tool', '--config=sub/../.env']],
  ])('%j names one', (argv) => {
    expect(namesProtectedPath(argv, cwd)).toBe(true);
  });

  it.each([
    [['cat', 'README.md']],
    [['ls', '-la']],
    [['cat', 'src/env.ts']],
    [['npm', 'run', 'build', '--', '--mode=production']],
    [['cat', '']],
    [['tool', '--flag=']],
  ])('%j does not', (argv) => {
    expect(namesProtectedPath(argv, cwd)).toBe(false);
  });

  it('is resolved against the cwd it was given: ../.env from a subdirectory is the parent’s .env, and is protected either way', () => {
    expect(namesProtectedPath(['cat', '../.env'], '/work/project/sub')).toBe(true);
    expect(namesProtectedPath(['cat', 'x/../y'], '/work/project')).toBe(false);
  });

  it('is resolved against the directory the command RUNS in: id_rsa inside .ssh is protected there and not in a plain directory', () => {
    expect(namesProtectedPath(['cat', 'id_rsa'], '/home/me/.ssh')).toBe(true);
    expect(namesProtectedPath(['cat', 'config'], '/work/project/.git')).toBe(true);
    expect(namesProtectedPath(['cat', 'id_rsa'], '/home/me/keys')).toBe(false);
  });

  it('ignores an argument with a NUL byte instead of throwing', () => {
    expect(namesProtectedPath(['cat', 'a\0.env'], cwd)).toBe(false);
  });
});

describe('the facts and the answers a command card offers', () => {
  const base: CommandFactsInput = {
    argv: ['npm', 'test'],
    commandAdmitted: false,
    remembered: false,
    cwd: '/work/project',
    sessionOffered: true,
    rememberAvailable: true,
  };

  it('an ordinary unknown command: Once, Session and Remember', () => {
    expect(commandCardFacts(base)).toEqual({
      standing: 'not-pre-approved',
      runsCode: false,
      protectedPath: false,
      cwd: '/work/project',
      offers: { session: true, remember: true },
    });
  });

  it.each([
    [{ commandAdmitted: true }, 'allowlisted'],
    [{ remembered: true }, 'remembered'],
    [{ commandAdmitted: true, remembered: true }, 'allowlisted'],
    [{}, 'not-pre-approved'],
  ] as const)('standing for %j is %s', (change, standing) => {
    expect(commandCardFacts({ ...base, ...change }).standing).toBe(standing);
  });

  it('a code carrier is answered Once or Session: Remember is not offered', () => {
    const facts = commandCardFacts({ ...base, argv: ['bash', '-c', 'make deploy'] });
    expect(facts.runsCode).toBe(true);
    expect(facts.offers).toEqual({ session: true, remember: false });
  });

  it('a command that names a protected path is answered Once only', () => {
    const facts = commandCardFacts({ ...base, argv: ['cat', '.env'] });
    expect(facts.protectedPath).toBe(true);
    expect(facts.offers).toEqual({ session: false, remember: false });
  });

  it('Remember is not offered when the store cannot write one, and Session when the host does not offer it', () => {
    expect(commandCardFacts({ ...base, rememberAvailable: false }).offers).toEqual({
      session: true,
      remember: false,
    });
    expect(commandCardFacts({ ...base, sessionOffered: false }).offers).toEqual({
      session: false,
      remember: true,
    });
  });
});

describe('the protected-path check reads an argument that carries an = (round 1 test review)', () => {
  const cwd = '/work/project';
  it.each([
    [['dd', 'if=.env']], // a bare key=value, not only a --flag=value
    [['tool', '--config=sub/../.env']],
    [['tool', '.ssh/id=rsa']], // the whole argument is a path that happens to contain an =
  ])('%j names one', (argv) => {
    expect(namesProtectedPath(argv, cwd)).toBe(true);
  });

  it.each([
    [['tool', 'mode=production']],
    [['tool', 'a=b=c']],
    [['tool', '=']],
    [['tool', '--x=']],
  ])('%j does not', (argv) => {
    expect(namesProtectedPath(argv, cwd)).toBe(false);
  });

  it('a protected working directory makes an empty-looking argument protected too, and an empty value is skipped', () => {
    expect(namesProtectedPath(['tool', '--x='], '/home/me/.ssh')).toBe(true);
    expect(namesProtectedPath(['tool', 'ok'], '/home/me/.ssh')).toBe(true);
  });
});

describe('a Windows spelling of a program name does not hide a shell (round 1 security sitting)', () => {
  it.each([
    'cmd.exe.',
    'cmd.exe ',
    'CMD.EXE',
    'cmd.exe::$DATA',
    'C:\\Windows\\System32\\cmd.exe...',
    'powershell.exe ',
  ])('%j is the shell cmd/powershell', (program) => {
    expect(codeCarrier([program, '/c', 'dir'])).toBe('shell');
  });
  it('and an ordinary name with a dot is not a carrier', () => {
    expect(codeCarrier(['build.sh'])).toBeUndefined();
    expect(programName('node_modules/.bin/tsc.')).toBe('tsc');
  });
});

describe('Remember is not offered for a command that is already pre-approved', () => {
  const base = {
    argv: ['npm', 'test'],
    commandAdmitted: false,
    remembered: false,
    cwd: '/work/project',
    sessionOffered: true,
    rememberAvailable: true,
  };
  it('on the allowlist or already remembered: Session is still offered, Remember is not', () => {
    expect(commandCardFacts({ ...base, commandAdmitted: true }).offers).toEqual({
      session: true,
      remember: false,
    });
    expect(commandCardFacts({ ...base, remembered: true }).offers).toEqual({
      session: true,
      remember: false,
    });
    expect(commandCardFacts(base).offers.remember).toBe(true);
  });
});
