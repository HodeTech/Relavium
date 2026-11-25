/**
 * The `/doctor` popup's words ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §8,
 * MVP-11 §4.4): the heading of the dominant outcome in the glyph table's roles and plain forms, the status word beside every glyph, the full
 * scrub of what a repository or a provider wrote, remedies that exist on the surface that shows them (and no shell command), and a consent line
 * that is never cut.
 */
import { describe, expect, it } from 'vitest';

import { withGlyphForm } from '../render/tui/glyphs.js';
import { displayWidth } from '../render/tui/viewport.js';
import { check } from './doctor.test-support.js';
import {
  CONSENT_LEAD,
  CONSENT_MCP,
  DOCTOR_TEXT_COLUMNS,
  checksContent,
  consentContent,
  detailContent,
  doctorCopyText,
  doctorHeading,
  doctorText,
  providerKeysCheck,
  providersRemedy,
} from './doctor-popup.js';
import { naturalBodyRows, popupBody } from './frame-model.js';

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
