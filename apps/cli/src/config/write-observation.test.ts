import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readStartingMode,
  StartingModeAuthority,
  startingModeConfigObserver,
  type ChatModeSelection,
} from '../chat/starting-mode.js';
import {
  ConfigWriteRefusedError,
  prepareChatModeHintShown,
  prepareDefaultChatMode,
  prepareGlobalPreferences,
  prepareKeychainUnavailableAcknowledged,
  prepareStandardEnvKeyConsent,
  type ConfigReadObserver,
  type PreparedConfigWrite,
} from './write.js';

interface Writer {
  readonly name: string;
  readonly prepare: (
    home: string,
    target: string,
    observer: ConfigReadObserver,
  ) => PreparedConfigWrite;
}

const writers: readonly Writer[] = [
  {
    name: 'model preferences',
    prepare: (home, target, observer) =>
      prepareGlobalPreferences({ defaultModel: 'operator-model' }, home, target, observer),
  },
  {
    name: 'standard-key consent',
    prepare: (home, target, observer) =>
      prepareStandardEnvKeyConsent('anthropic', home, target, observer),
  },
  {
    name: 'keychain acknowledgement',
    prepare: (home, target, observer) =>
      prepareKeychainUnavailableAcknowledged(true, home, target, observer),
  },
  {
    name: 'default mode',
    // A proposed narrowing is not a source observation or an operator confirmation.
    prepare: (home, target, observer) => prepareDefaultChatMode('ask', home, target, observer),
  },
  {
    name: 'hint acknowledgement',
    prepare: (home, target, observer) => prepareChatModeHintShown(home, target, observer),
  },
];
const states = ['auto', 'ask', 'absent', 'invalid'] as const;
const AUTO = '[preferences]\ndefault_mode="auto"\n';

describe('actual config writer source observations', () => {
  let root: string;
  let home: string;
  let cwd: string;
  let target: string;
  let authority: StartingModeAuthority;
  let retained: ChatModeSelection;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-writer-observation-'));
    home = join(root, 'operator');
    cwd = join(root, 'workspace');
    target = join(root, 'selected-config.toml');
    mkdirSync(home);
    mkdirSync(cwd);
    writeFileSync(target, AUTO);
    const initial = readStartingMode({ home, cwd, configPath: target });
    authority = new StartingModeAuthority(true, initial);
    retained = authority.resolve(() => initial);
    expect(() => authority.assertDispatch(retained, 'write_file')).not.toThrow();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(writers.flatMap((writer) => states.map((state) => ({ ...writer, state }))))(
    '$name source $state',
    ({ prepare, state }) => {
      if (state === 'absent') rmSync(target);
      else if (state === 'ask') writeFileSync(target, '[preferences]\ndefault_mode="ask"\n');
      else if (state === 'invalid')
        writeFileSync(target, '[preferences]\ndefault_mode="PRIVATE_INVALID_MODE"\n');
      const before = existsSync(target) ? readFileSync(target) : undefined;
      const entries = readdirSync(root);
      let failure: unknown;
      let prepared: PreparedConfigWrite | undefined;
      try {
        prepared = prepare(home, target, startingModeConfigObserver(authority));
      } catch (cause) {
        failure = cause;
      }
      // Preparation observes its actual source; it does not publish the proposed merged value.
      expect(existsSync(target)).toBe(before !== undefined);
      expect(readdirSync(root)).toEqual(entries);
      if (before !== undefined) expect(readFileSync(target)).toEqual(before);
      if (state === 'invalid') expect(failure).toBeInstanceOf(Error);
      else {
        expect(failure).toBeUndefined();
        expect(prepared).toBeDefined();
      }
      if (state === 'auto') {
        expect(() => authority.assertDispatch(retained, 'write_file')).not.toThrow();
      } else {
        const marker =
          state === 'invalid'
            ? 'W2_STARTUP_WRITER_READ_FAILURE'
            : 'W2_STARTUP_WRITER_MODE_OBSERVATION';
        expect(() => authority.assertDispatch(retained, 'write_file'), marker).toThrow('revoked');
        // A later operator-file value is still a read, never a fresh trusted admission.
        writeFileSync(target, AUTO);
        expect(
          () => authority.resolve(() => readStartingMode({ home, cwd, configPath: target })),
          marker,
        ).toThrow('no longer admitted');
      }
    },
  );

  it('directory source inspection revokes before any proposed publication', () => {
    rmSync(target);
    mkdirSync(target);
    let failure: unknown;
    try {
      prepareDefaultChatMode('auto', home, target, startingModeConfigObserver(authority));
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(
      () => authority.assertDispatch(retained, 'write_file'),
      'W2_STARTUP_WRITER_INSPECTION_FAILURE',
    ).toThrow('revoked');
    expect(lstatSync(target).isDirectory()).toBe(true);
    expect(readdirSync(target)).toEqual([]);
  });

  it('parent replaced by a file revokes at actual source inspection', () => {
    const parent = join(root, 'parent');
    const displaced = join(root, 'displaced-parent');
    mkdirSync(parent);
    const nested = join(parent, 'config.toml');
    writeFileSync(nested, AUTO);
    renameSync(parent, displaced);
    writeFileSync(parent, 'owned blocking parent');
    let failure: unknown;
    try {
      prepareDefaultChatMode('auto', home, nested, startingModeConfigObserver(authority));
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(
      () => authority.assertDispatch(retained, 'write_file'),
      'W2_STARTUP_WRITER_INSPECTION_FAILURE',
    ).toThrow('revoked');
    expect(readFileSync(parent, 'utf8')).toBe('owned blocking parent');
    expect(readFileSync(join(displaced, 'config.toml'), 'utf8')).toBe(AUTO);
  });

  it.skipIf(process.platform === 'win32')(
    'symlink write-only refusal preserves prior auto admission',
    () => {
      const actual = join(root, 'actual-config.toml');
      renameSync(target, actual);
      symlinkSync(actual, target);
      expect(() =>
        prepareDefaultChatMode('ask', home, target, startingModeConfigObserver(authority)),
      ).toThrow(ConfigWriteRefusedError);
      expect(() => authority.assertDispatch(retained, 'write_file')).not.toThrow();
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(readFileSync(actual, 'utf8')).toBe(AUTO);
    },
  );
});
