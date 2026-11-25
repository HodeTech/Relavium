/**
 * The `/doctor` popup's words ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §8,
 * MVP-11 §4.4): the heading of the dominant outcome in the glyph table's roles and plain forms, the status word beside every glyph, the full
 * scrub of what a repository or a provider wrote, remedies that exist on the surface that shows them (and no shell command), and a consent line
 * that is never cut.
 */
import { describe, expect, it } from 'vitest';

import { ENDPOINT_CHANGED_DETAIL, KEY_GONE_DETAIL } from '../chat/doctor-deep.js';
import type { DoctorCheck } from '../chat/doctor.js';
import { KNOWN_PROVIDER_IDS } from '../engine/providers.js';
import { withGlyphForm } from '../render/tui/glyphs.js';
import { displayWidth } from '../render/tui/viewport.js';
import { check } from './doctor.test-support.js';
import {
  CONSENT_LEAD,
  CONSENT_MCP,
  CONSENT_TOO_LONG,
  DOCTOR_LINE_ROWS,
  DOCTOR_STEP,
  DOCTOR_TEXT_COLUMNS,
  checksContent,
  consentContent,
  detailContent,
  doctorChecksControls,
  doctorCopyText,
  doctorHeading,
  doctorRowId,
  doctorSpec,
  doctorText,
  failedProviderRemedy,
  hasRows,
  providerKeysCheck,
  providersRemedy,
  remedyOf,
} from './doctor-popup.js';
import type { DoctorSurface } from './doctor-port.js';
import { naturalBodyRows, popupBody, type PopupContent } from './frame-model.js';

const SURFACES: readonly DoctorSurface[] = ['home', 'home-chat', 'standalone-chat'];

/** A detail step's words as one line of text (its wrapped lines joined, its blank lines gone). */
function said(content: PopupContent): string {
  if (content.kind !== 'report') throw new Error('a report');
  return content.lines.join(' ').replace(/\s+/gu, ' ').trim();
}

/** A hostname of 253 characters (the longest a name can be) in four labels of the longest length, led by `lead`. */
const longestHost = (lead: string): string =>
  [lead.repeat(63), lead.repeat(63), lead.repeat(63), lead.repeat(61)].join('.');
/** The longest `https` origin a custom endpoint can have: that name and the highest port. */
const longestOrigin = (lead: string): string => `https://${longestHost(lead)}:65535`;

describe('the heading of the outcome', () => {
  it('says the dominant outcome in the words of the text report, with a plural that agrees', () => {
    expect(doctorHeading([check('a', 'ok')]).text).toBe('doctor: all checks passed');
    expect(doctorHeading([check('a', 'warn')]).text).toBe('doctor: 1 warning');
    expect(doctorHeading([check('a', 'warn'), check('b', 'warn')]).text).toBe('doctor: 2 warnings');
    expect(doctorHeading([check('a', 'fail'), check('b', 'warn')]).text).toBe(
      'doctor: 1 check failed',
    );
    expect(doctorHeading([check('a', 'fail'), check('b', 'fail')]).text).toBe(
      'doctor: 2 checks failed',
    );
  });

  it.each([
    [false, 'ok', '✓ doctor: all checks passed'],
    [true, 'ok', 'doctor: all checks passed'],
    [false, 'warn', '⚠ doctor: 1 warning'],
    [true, 'warn', '! doctor: 1 warning'],
    [false, 'fail', '✗ doctor: 1 check failed'],
    [true, 'fail', 'x doctor: 1 check failed'],
  ] as const)('drawn with colour off %s, %s: %s', (ascii, status, drawn) => {
    const content = checksContent({ quick: [check('a', status)] });
    const lines = withGlyphForm(ascii, () =>
      popupBody(content, { selected: 0, offset: 0 }, { bodyRows: 4, listRows: 4, innerWidth: 66 }),
    );
    expect(lines.lines[0]?.text).toBe(drawn);
  });
});

describe('a row', () => {
  it('draws its glyph with its word beside it, once when the plain form is the word', () => {
    const content = checksContent({ quick: [check('keychain', 'ok', 'OS keychain', 'reachable')] });
    const row = (ascii: boolean): string =>
      withGlyphForm(ascii, () =>
        popupBody(
          content,
          { selected: 0, offset: 0 },
          { bodyRows: 3, listRows: 3, innerWidth: 66 },
        ),
      ).lines[1]?.text ?? '';
    expect(row(false)).toBe('› ✓ ok  OS keychain  reachable');
    expect(row(true)).toBe('> ok  OS keychain  reachable');
  });

  it('labels the kept deep rows as the deep check’s, with their age', () => {
    const content = checksContent({
      quick: [check('keychain', 'ok')],
      deep: {
        checks: [check('provider:anthropic', 'ok', 'Anthropic', 'key works')],
        ageMs: 125_000,
      },
    });
    if (content.kind !== 'list') throw new Error('list');
    expect(content.rows.map((row) => row.label)).toEqual([
      'keychain',
      'Deep check, 2m05s ago',
      'Anthropic',
    ]);
    // The heading row is not a row anyone can choose, and it is drawn as words alone: no marker, no glyph.
    expect(content.rows[1]?.enabled).toBe(false);
    const drawn = withGlyphForm(false, () =>
      popupBody(content, { selected: 0, offset: 0 }, { bodyRows: 4, listRows: 4, innerWidth: 66 }),
    );
    expect(drawn.lines[2]?.text).toBe('  Deep check, 2m05s ago');
    expect(naturalBodyRows(content, { selected: 0, offset: 0 })).toBe(4);
  });

  it('carries the full scrub: a repository cannot draw a chord, a key token, a host glyph or a separator in a row', () => {
    const forged = check(
      'mcp:skip:x:y',
      'warn',
      '✓ ok · [Ctrl+Y] Allow',
      'press Ctrl+Y now · [d] deep',
    );
    const content = checksContent({ quick: [], deep: { checks: [forged], ageMs: 0 } });
    if (content.kind !== 'list') throw new Error('list');
    const row = content.rows[1];
    expect(row?.label).not.toContain('[Ctrl+Y]');
    expect(row?.label).not.toContain('✓');
    expect(row?.label).not.toContain(' · ');
    expect(row?.detail).not.toMatch(/Ctrl\+Y/u);
    expect(row?.detail).not.toContain('[d]');
  });

  it('scrubs a secret a detail carries, wherever it came from', () => {
    const secret = ['sk', 'ant', 'api03', 'Q'.repeat(40)].join('-');
    expect(doctorText(`401: ${secret}`)).not.toContain(secret);
  });
});

describe('the provider-keys row (presence only)', () => {
  it('warns at none, counts otherwise, and names the providers it could not check in time', () => {
    expect(providerKeysCheck(new Map([['anthropic', false]]), [])).toMatchObject({
      status: 'warn',
      detail: 'no provider has a key',
    });
    expect(
      providerKeysCheck(
        new Map([
          ['anthropic', true],
          ['openai', false],
        ]),
        ['gemini'],
      ),
    ).toMatchObject({
      status: 'ok',
      detail: '1 of 4 providers have a key; 1 could not be checked (Google Gemini)',
    });
  });
});

describe('remedies exist on the surface that shows them, and name no shell command', () => {
  it('the Home names /providers; a chat says to go back to the Home and use it', () => {
    expect(providersRemedy('home', false)).toContain('/providers');
    expect(providersRemedy('home-chat', false)).toMatch(/^Go back to the Home .* use \/providers/u);
    expect(providersRemedy('standalone-chat', false)).toMatch(
      /^Go back to the Home .* use \/providers/u,
    );
  });

  it.each(['home', 'home-chat', 'standalone-chat'] as const)(
    'no detail on %s names `relavium doctor` or another shell command',
    (surface) => {
      const rows = [
        check('keychain', 'fail', 'OS keychain', 'backend down'),
        check('config', 'fail', 'config', '~/.relavium/config.toml: is not valid TOML (line 1)'),
        check('provider-keys', 'warn', 'provider keys', 'no provider has a key'),
        check('tools', 'ok', 'wired tools', 'fs, process'),
      ];
      for (const row of rows) {
        const content = detailContent('quick', row, surface, { offered: false });
        if (content.kind !== 'report') throw new Error('report');
        const text = content.lines.join('\n');
        expect(text).not.toMatch(/relavium\s+[a-z]/u);
        if (row.id === 'provider-keys') expect(text).toContain('/providers');
      }
    },
  );

  it('a failed config names the file and the error position it was given, and no absolute path', () => {
    const content = detailContent(
      'quick',
      check(
        'config',
        'fail',
        'config',
        '~/.relavium/config.toml: is not valid TOML (line 3, column 7)',
      ),
      'home',
      { offered: false },
    );
    if (content.kind !== 'report') throw new Error('report');
    expect(content.lines.join(' ')).toContain('~/.relavium/config.toml');
    expect(content.lines.join(' ')).toContain('line 3, column 7');
  });
});

describe('the consent line', () => {
  it('says what leaves and to whom, by origin, each once, and that MCP servers are not contacted', () => {
    const content = consentContent(
      [
        { providerId: 'openai', origin: 'https://gateway.example' },
        { providerId: 'deepseek', origin: 'https://gateway.example' },
        { providerId: 'anthropic', origin: 'https://api.anthropic.com' },
      ],
      [],
      'home',
    );
    if (content.kind !== 'report') throw new Error('report');
    expect(content.lines).toEqual([
      CONSENT_LEAD,
      '  https://gateway.example',
      '  https://api.anthropic.com',
      CONSENT_MCP,
    ]);
  });

  it('never cuts an origin: a long one is broken across lines that each fit the narrowest popup', () => {
    const origin = `https://${'a'.repeat(120)}.example`;
    const content = consentContent([{ providerId: 'openai', origin }], [], 'home');
    if (content.kind !== 'report') throw new Error('report');
    for (const line of content.lines)
      expect(displayWidth(line)).toBeLessThanOrEqual(DOCTOR_TEXT_COLUMNS);
    expect(content.lines.join('').replace(/\s+/gu, '')).toContain(origin);
  });

  it('says which providers with a key it leaves out, and is empty with nothing to send', () => {
    const content = consentContent([], ['openai'], 'home-chat');
    expect(content.kind).toBe('empty');
    const partial = consentContent(
      [{ providerId: 'anthropic', origin: 'https://api.anthropic.com' }],
      ['openai'],
      'home',
    );
    if (partial.kind !== 'report') throw new Error('report');
    expect(partial.lines.at(-1)).toBe(
      'Not contacted (its key or its endpoint could not be read): OpenAI.',
    );
  });
});

describe('the copied report', () => {
  it('is the rows the popup shows, in the glyph form asked for, the deep rows under their heading', () => {
    const view = {
      quick: [check('keychain', 'ok', 'OS keychain', 'reachable')],
      deep: {
        checks: [check('provider:openai', 'fail', 'OpenAI', 'key test failed')],
        ageMs: 3000,
      },
    };
    expect(doctorCopyText(view, true)).toBe(
      [
        'x doctor: 1 check failed',
        '  ok  OS keychain  reachable',
        '  Deep check, 3s ago',
        '  x failed  OpenAI  key test failed',
      ].join('\n'),
    );
    expect(doctorCopyText(view, false).split('\n')[1]).toBe('  ✓ ok  OS keychain  reachable');
  });
});

describe('the words the popup says, pinned by literal', () => {
  it('the confirmation line says one request PER provider, with that provider’s key, and that MCP is never contacted', () => {
    expect(CONSENT_LEAD).toBe('Sends one small request per provider, with its key, to:');
    expect(CONSENT_MCP).toBe('MCP servers are only reported, never contacted.');
    const content = consentContent(
      [{ providerId: 'anthropic', origin: 'https://api.anthropic.com' }],
      [],
      'home',
    );
    if (content.kind !== 'report') throw new Error('report');
    expect(content.lines[0]).toBe('Sends one small request per provider, with its key, to:');
  });

  it('the line with nothing to send says why: no key at all, or no key whose destination could be read', () => {
    const none = consentContent([], [], 'home');
    const unread = consentContent([], ['openai'], 'home');
    if (none.kind !== 'empty' || unread.kind !== 'empty') throw new Error('empty');
    expect(none.what).toBe('No provider has a key, so the deep check has nothing to send.');
    expect(unread.what).toBe(
      'No provider’s key and endpoint could both be read, so nothing would be sent.',
    );
    expect(none.next).toBe(providersRemedy('home', false));
  });

  it.each([
    ['home', false, 'Open /providers to connect a key or review its source.'],
    ['home', true, 'Press Enter to open /providers and connect a key or review its source.'],
    [
      'home-chat',
      false,
      'Go back to the Home ([Ctrl+C] twice) and use /providers to connect a key or review its source.',
    ],
    [
      'standalone-chat',
      false,
      'Go back to the Home (start Relavium without arguments) and use /providers to connect a key or review its source.',
    ],
  ] as const)('providersRemedy on %s (offered: %s)', (surface, offered, words) => {
    expect(providersRemedy(surface, offered)).toBe(words);
  });

  it.each([
    [
      'home',
      false,
      'If the key is right, check your network; otherwise review it with /providers.',
    ],
    [
      'home',
      true,
      'If the key is right, check your network; otherwise press Enter to open /providers and review it.',
    ],
    [
      'home-chat',
      false,
      'If the key is right, check your network; otherwise go back to the Home ([Ctrl+C] twice) and review it with /providers.',
    ],
    [
      'standalone-chat',
      false,
      'If the key is right, check your network; otherwise go back to the Home (start Relavium without arguments) and review it with /providers.',
    ],
  ] as const)(
    'a failed request says what is true of a wrong key AND of a network that did not answer, on %s (offered: %s)',
    (surface, offered, words) => {
      const failed = check('provider:openai', 'fail', 'OpenAI', 'Connection error.');
      expect(failedProviderRemedy(failed, surface, offered)).toBe(words);
      // The detail step says exactly that, and it does not claim the key is wrong or missing.
      const detail = said(detailContent('deep', failed, surface, { offered, deepAgeMs: 3000 }));
      expect(detail).toContain(words);
      expect(detail).not.toContain('connect a key');
    },
  );

  it.each([ENDPOINT_CHANGED_DETAIL, KEY_GONE_DETAIL])(
    'a provider that was not contacted keeps the remedy of its key and endpoint, not the network’s: %s',
    (detail) => {
      const notContacted = check('provider:openai', 'fail', 'OpenAI', detail);
      for (const surface of SURFACES) {
        expect(failedProviderRemedy(notContacted, surface, false)).toBe(
          providersRemedy(surface, false),
        );
        expect(failedProviderRemedy(notContacted, surface, false)).not.toContain('network');
      }
    },
  );

  it('the detail step sends the person back with Esc and points at [r] where it works, never "Press [r]" on a step that has none', () => {
    const again = 'Esc goes back to the checks, where [r] checks again.';
    const keychain = check('keychain', 'fail', 'OS keychain', 'backend down');
    const config = check('config', 'fail', 'config', 'bad');
    for (const surface of SURFACES) {
      for (const failed of [keychain, config]) {
        const words = said(detailContent('quick', failed, surface, { offered: false }));
        expect(words).toContain(again);
        expect(words).not.toContain('Press [r]');
        expect(words).not.toMatch(/to check again/u);
      }
    }
  });

  it('says what each row means and what to do about it, in these words', () => {
    const rows: readonly [DoctorCheck, readonly string[], readonly string[]][] = [
      [
        check('keychain', 'ok', 'OS keychain', 'reachable'),
        ['Keys stored in the OS keychain can be read.'],
        [],
      ],
      [
        check('keychain', 'fail', 'OS keychain', 'down'),
        [
          'Keys stored in the OS keychain cannot be read until it can be reached. This is a problem of the operating system: unlock the keychain or start its service.',
        ],
        ['Esc goes back to the checks, where [r] checks again.'],
      ],
      [
        check('config', 'ok', 'config', 'valid'),
        ['Every configuration file loads and is valid.'],
        [],
      ],
      [
        check('config', 'fail', 'config', 'bad'),
        ['Fix the file named above at the position it gives.'],
        ['Esc goes back to the checks, where [r] checks again.'],
      ],
      [
        check('provider-keys', 'ok', 'provider keys', '1 of 4 providers have a key'),
        ['No key is shown here, and nothing was sent to check them.'],
        [],
      ],
      [
        check('provider-keys', 'warn', 'provider keys', 'no provider has a key'),
        ['Open /providers to connect a key or review its source.'],
        [],
      ],
      [
        check('tools', 'ok', 'wired tools', 'fs'),
        ['The capabilities a chat’s tools are given. Nothing to do here.'],
        [],
      ],
    ];
    for (const [row, words, extra] of rows) {
      const text = said(detailContent('quick', row, 'home', { offered: false }));
      for (const sentence of [...words, ...extra]) expect(text).toContain(sentence);
      // The row's own words come first: its label and word, then its whole detail.
      expect(text.startsWith(`${row.label}: `)).toBe(true);
      expect(text).toContain(row.detail);
    }
    // Any other row says nothing to do: its label and word, a blank line and its detail, and no more.
    const other = detailContent(
      'quick',
      check('global-artifacts', 'warn', 'global artifacts', 'two files'),
      'home',
      {
        offered: false,
      },
    );
    if (other.kind !== 'report') throw new Error('report');
    expect(other.lines).toEqual(['global artifacts: warning', '', 'two files']);
  });

  it('a deep row says it comes from the deep check, how long ago (in lower case), and what its provider answered', () => {
    const ok = detailContent(
      'deep',
      check('provider:anthropic', 'ok', 'Anthropic', 'key works'),
      'home',
      {
        offered: false,
        deepAgeMs: 125_000,
      },
    );
    expect(said(ok)).toBe(
      'Anthropic: ok key works From the deep check, 2m05s ago. The key worked: the request was answered.',
    );
    const mcp = detailContent('deep', check('mcp:files', 'ok', 'files', 'connected'), 'home-chat', {
      offered: false,
      deepAgeMs: 4000,
    });
    expect(said(mcp)).toBe(
      'files: ok connected From the deep check, 4s ago. Reported from this chat’s session: the server was not contacted to check it. Nothing to do here.',
    );
    // A quick row has no age to give, even when one is passed.
    const quick = detailContent(
      'quick',
      check('keychain', 'ok', 'OS keychain', 'reachable'),
      'home',
      {
        offered: false,
        deepAgeMs: 4000,
      },
    );
    expect(said(quick)).not.toContain('From the deep check');
  });

  it('a long detail wraps so that every line starts where the first does and none ends in a space', () => {
    // Every word count in a range, in ASCII and with a non-ASCII word (the two wrapping paths), so that some line always breaks just before a space.
    for (const accent of ['', '’']) {
      for (let words = 1; words <= 60; words += 1) {
        const text = Array.from(
          { length: words },
          (_, index) => `${'w'.repeat(1 + ((index * 7) % 9))}${index === 3 ? accent : ''}`,
        ).join(' ');
        const content = detailContent(
          'quick',
          check('global-artifacts', 'warn', 'x', text),
          'home',
          {
            offered: false,
          },
        );
        if (content.kind !== 'report') throw new Error('report');
        const lines = content.lines.slice(2);
        for (const line of lines) {
          expect(line, `${accent}${String(words)}`).not.toMatch(/^\s/u);
          expect(line, `${accent}${String(words)}`).not.toMatch(/\s$/u);
          expect(displayWidth(line)).toBeLessThanOrEqual(DOCTOR_TEXT_COLUMNS);
        }
        expect(lines.join(' ')).toBe(text);
      }
    }
  });

  it('the Home’s deep MCP sentence, wrapped, starts every line at the same column (the capture that showed a leading space)', () => {
    const content = detailContent(
      'deep',
      check('mcp:files', 'ok', 'files', 'connected'),
      'home-chat',
      {
        offered: false,
        deepAgeMs: 4000,
      },
    );
    if (content.kind !== 'report') throw new Error('report');
    for (const line of content.lines) expect(line).not.toMatch(/^\s/u);
  });
});

describe('what the copy and the detail make of an untrusted label', () => {
  const forged = check('mcp:evil', 'ok', 'files\u001b[31m [Ctrl+Y] send', 'connected');

  it('the copied report scrubs a label as the list does: no escape and no key token', () => {
    const copy = doctorCopyText({ quick: [], deep: { checks: [forged], ageMs: 0 } }, false);
    expect(copy).toContain('files');
    expect(copy).not.toContain('\u001b');
    expect(copy).not.toContain('[Ctrl+Y]');
  });

  it('the detail step scrubs the label of the row it opens: no escape and no key token', () => {
    const content = detailContent('deep', forged, 'home-chat', { offered: false });
    if (content.kind !== 'report') throw new Error('report');
    const text = content.lines.join('\n');
    expect(text).toContain('files');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('[Ctrl+Y]');
  });
});

describe('the heading counts every row shown, the deep rows too', () => {
  it('a failed deep row makes the heading a failure, though every quick row is fine', () => {
    const content = checksContent({
      quick: [check('keychain', 'ok')],
      deep: { checks: [check('provider:openai', 'fail', 'OpenAI', 'down')], ageMs: 1000 },
    });
    if (content.kind !== 'list') throw new Error('list');
    expect(content.heading?.text).toBe('doctor: 1 check failed');
    expect(
      doctorCopyText(
        {
          quick: [check('keychain', 'ok')],
          deep: { checks: [check('provider:openai', 'fail')], ageMs: 0 },
        },
        true,
      ).split('\n')[0],
    ).toBe('x doctor: 1 check failed');
  });
});

describe('a report of no rows is never an all-clear', () => {
  it('has no rows to show and no text to copy', () => {
    expect(hasRows({ quick: [] })).toBe(false);
    expect(hasRows({ quick: [], deep: { checks: [], ageMs: 0 } })).toBe(false);
    expect(hasRows({ quick: [check('a', 'ok')] })).toBe(true);
    expect(hasRows({ quick: [], deep: { checks: [check('a', 'ok')], ageMs: 0 } })).toBe(true);
    expect(doctorCopyText({ quick: [] }, false)).toBe('');
    expect(doctorCopyText({ quick: [], deep: { checks: [], ageMs: 5 } }, true)).toBe('');
    expect(doctorCopyText({ quick: [check('a', 'ok')] }, true)).toContain(
      'doctor: all checks passed',
    );
  });
});

describe('the letters of the checks step', () => {
  it('lists [r] and [d] always, and [c] only with rows to copy', () => {
    expect(doctorChecksControls(true).map((control) => control.key)).toEqual(['r', 'd', 'c']);
    expect(doctorChecksControls(false).map((control) => control.key)).toEqual(['r', 'd']);
    expect(doctorChecksControls(true).map((control) => control.verb)).toEqual([
      'quick check',
      'deep check',
      'copy',
    ]);
  });

  it('the popup opens on the loading words, so with no copy yet', () => {
    const spec = doctorSpec('home', false);
    expect(spec.steps[DOCTOR_STEP.checks]?.controls?.map((control) => control.key)).toEqual([
      'r',
      'd',
    ]);
    expect(spec.steps[DOCTOR_STEP.checks]?.enter).toBe('details');
    expect(spec.steps[DOCTOR_STEP.detail]?.back).toBe(DOCTOR_STEP.checks);
    expect(spec.steps[DOCTOR_STEP.line]?.back).toBe(DOCTOR_STEP.checks);
  });

  it('the detail step offers Enter only where a remedy opens', () => {
    expect(doctorSpec('home', false, true).steps[DOCTOR_STEP.detail]?.enter).toBe(
      'open /providers',
    );
    expect(doctorSpec('home', false, false).steps[DOCTOR_STEP.detail]?.enter).toBeUndefined();
  });
});

describe('rows and their remedies', () => {
  it('a row’s id carries its tier, so a quick and a deep row of one check are two rows', () => {
    const row = check('provider:openai', 'ok');
    expect(doctorRowId('quick', row)).toBe('quick:provider:openai');
    expect(doctorRowId('deep', row)).toBe('deep:provider:openai');
  });

  it('only the Home opens a remedy, and only for the provider keys warning or a failed deep provider row', () => {
    const noKeys = check('provider-keys', 'warn', 'provider keys', 'no provider has a key');
    const someKeys = check('provider-keys', 'ok', 'provider keys', '1 of 4');
    const failed = check('provider:openai', 'fail');
    const worked = check('provider:openai', 'ok');
    expect(remedyOf('quick', noKeys, 'home')).toEqual({ kind: 'providers' });
    expect(remedyOf('quick', someKeys, 'home')).toBeUndefined();
    expect(remedyOf('deep', failed, 'home')).toEqual({ kind: 'providers' });
    expect(remedyOf('deep', worked, 'home')).toBeUndefined();
    // A quick row is never a provider row, whatever its id says.
    expect(remedyOf('quick', failed, 'home')).toBeUndefined();
    expect(remedyOf('quick', noKeys, 'home-chat')).toBeUndefined();
    expect(remedyOf('deep', failed, 'standalone-chat')).toBeUndefined();
  });
});

describe('the confirmation line fits the page whole, or is not offered (ADR-0148 §7)', () => {
  /** What the popup draws of `content` in its body at the smallest terminal, from the top: its lines, and whether any row is a scroll marker. */
  function drawn(content: PopupContent) {
    const body = popupBody(
      content,
      { selected: 0, offset: 0 },
      { bodyRows: DOCTOR_LINE_ROWS, listRows: DOCTOR_LINE_ROWS, innerWidth: DOCTOR_TEXT_COLUMNS },
    );
    return body.lines;
  }

  const OFFICIAL: Readonly<Record<string, string>> = {
    anthropic: 'https://api.anthropic.com',
    gemini: 'https://generativelanguage.googleapis.com',
  };
  /** Only OpenAI and DeepSeek can be pointed at a custom endpoint; the other two are always their official origin. */
  const originOf = (id: (typeof KNOWN_PROVIDER_IDS)[number]): string =>
    OFFICIAL[id] ?? longestOrigin(id === 'openai' ? 'a' : 'b');

  it('has the body rows of a popup at 80×24', () => {
    expect(DOCTOR_LINE_ROWS).toBe(17);
    expect(DOCTOR_TEXT_COLUMNS).toBe(66);
  });

  it('every way the four providers can be named or left out, with the longest origins a custom endpoint can have, is on the page whole', () => {
    let checked = 0;
    for (let mask = 1; mask < 2 ** KNOWN_PROVIDER_IDS.length; mask += 1) {
      const named = KNOWN_PROVIDER_IDS.filter((_, index) => (mask & (1 << index)) !== 0);
      const left = KNOWN_PROVIDER_IDS.filter((id) => !named.includes(id));
      const content = consentContent(
        named.map((providerId) => ({ providerId, origin: originOf(providerId) })),
        left,
        'standalone-chat',
      );
      if (content.kind !== 'report') throw new Error(`the line is a report (${named.join(',')})`);
      const lines = drawn(content);
      // Every line the answer covers is a row of the page: no scroll marker, no row left out.
      expect(lines.map((line) => line.kind)).not.toContain('marker');
      expect(lines.map((line) => line.text.trimEnd())).toEqual(content.lines);
      expect(lines.length).toBeLessThanOrEqual(DOCTOR_LINE_ROWS);
      // And no origin is shown in part: each one is on the page, in lines that rejoin to it.
      for (const providerId of named)
        expect(content.lines.map((line) => line.trim()).join('')).toContain(originOf(providerId));
      checked += 1;
    }
    expect(checked).toBe(15);
  });

  it('is offered at exactly the rows the page has, and not at one more', () => {
    const three = (['anthropic', 'gemini', 'deepseek'] as const).map((providerId, index) => ({
      providerId,
      origin: longestOrigin(String.fromCharCode(97 + index)),
    }));
    // The lead, three origins of five lines each and the MCP sentence: seventeen lines, the whole body.
    const fits = consentContent(three, [], 'home');
    if (fits.kind !== 'report') throw new Error('report');
    expect(fits.lines).toHaveLength(DOCTOR_LINE_ROWS);
    // One more sentence, of one line (the provider left out is named in the 66 columns), makes eighteen: refused, and nothing is offered.
    const over = consentContent(three, ['openai'], 'home');
    expect(over.kind).toBe('empty');
    expect(
      displayWidth('Not contacted (its key or its endpoint could not be read): OpenAI.'),
    ).toBeLessThanOrEqual(DOCTOR_TEXT_COLUMNS);
  });

  it('four of the longest origins cannot all be named: the line says so and offers nothing', () => {
    const content = consentContent(
      KNOWN_PROVIDER_IDS.map((providerId, index) => ({
        providerId,
        origin: longestOrigin(String.fromCharCode(97 + index)),
      })),
      [],
      'home',
    );
    if (content.kind !== 'empty') throw new Error('empty');
    expect(content.what).toBe('These destinations are too long to confirm, so nothing is sent.');
    expect(content.what).toBe(CONSENT_TOO_LONG);
    expect(content.next).toBe('Esc goes back.');
    expect(displayWidth(content.what)).toBeLessThanOrEqual(DOCTOR_TEXT_COLUMNS);
  });
});
