/**
 * What a host hands the `/doctor` popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §8), and the one way a host opens it. This module is the EAGER half: types, the parse of a typed `/doctor` line, and a loader that brings in
 * the popup's code (`doctor-session.ts`, `doctor-popup.ts`) only when the person first asks for it, so the Home's first paint and a chat's start
 * never wait for it (the bundle splits on the dynamic import).
 *
 * The hosts route and open, and hold no popup logic: the Home controller and the chat hosts recognise the line ({@link parseDoctorLine}) in the
 * same place they open a sheet for `/permissions`, BEFORE the line is counted as a submit (so the popup host's open gate never sees the
 * command's own line as a turn in flight), and call {@link openDoctor}.
 */

import type { ProviderId } from '@relavium/llm';

import type { DoctorProbes } from '../chat/doctor.js';
import type { Surface } from '../render/surface.js';
import type { InvocationWorkOwner } from '../process/invocation-work-owner.js';
import type { PopupOrigin } from './frame-model.js';
import type { PopupContext, PopupHost } from './popup-host.js';
import type { PopupPortBase, PopupWorkOwner } from './popup-work.js';

/** Where the popup is read: the bare Home, the chat the Home hosts, or a stand-alone `relavium chat`. Decides the words of a remedy. */
export type DoctorSurface = Exclude<Surface, 'shell'>;

/**
 * The owner the deep tier's run is entered on: the owner every popup's work starts on ({@link PopupWorkOwner}) and, for the deep tier, its signal
 * (which aborts the run) and its retained work (which holds each request until it settles).
 */
export type DoctorWorkOwner = PopupWorkOwner &
  Pick<InvocationWorkOwner, 'signal' | 'work' | 'assertAdmitting'>;

/** A remedy a row's detail can offer on a surface that has it. Today one: the provider setup, which is the Home's alone (OD-2). */
export interface DoctorRemedy {
  readonly kind: 'providers';
}

/**
 * **The seam for the provider popup** (a later unit of MVP-11 turns `/providers` into a popup): when a host wires this, the detail step of a
 * `provider keys` warning or a failed provider row on the HOME offers `Enter` as one more step, which calls it to open the provider popup as a
 * CHILD of the doctor popup (`context.openChild`, depth two, its own settle time, buffers and abort; `Esc` on it returns to the doctor with its
 * state intact). It returns whether the child opened. Until then no host wires it, and the detail step names `/providers` in words.
 */
export type DoctorRemedyOpener = (remedy: DoctorRemedy, context: PopupContext) => boolean;

/** A provider's key presence as the host last sampled it (a boolean, never a value), for the provider-keys row to fall back on. */
export interface DoctorKeySample {
  readonly id: ProviderId;
  readonly usable: boolean;
}

/** What a host hands the popup. Built once per surface; nothing in it is read until the popup runs a check. */
export interface DoctorPort extends PopupPortBase {
  /**
   * The host this doctor belongs to (one per terminal host: the Home, or a stand-alone chat's process). A completed deep result and a deep
   * run in flight are kept under it for the process, so reopening the popup shows the result and cannot stack a second run.
   */
  readonly scope: object;
  readonly surface: DoctorSurface;
  /**
   * Whose MCP rows a kept deep result may show again: the Home's (`home`, which has none) or a chat session's id. Provider rows are the host's
   * and are shown from any surface of it; MCP rows only in the session that reported them.
   */
  readonly resultKey: string;
  /** The quick tier's probes (the keychain's reachability, the configuration, the tools, the global artifacts), the provider seam and, in a
   *  chat, the session's read-only MCP report. The same probes the text report runs. */
  readonly probes: DoctorProbes;
  /** The owner of the quick tier's work and of the deep tier's run. Its `clipboard` and `plainGlyphs` are the copy's ({@link PopupPortBase}). */
  readonly workOwner?: DoctorWorkOwner | undefined;
  /** The key presence the host already sampled (the Home samples it when it opens and after a provider run); a check past its bound falls back on it. */
  readonly cachedKeys?: (() => readonly DoctorKeySample[] | undefined) | undefined;
  /** The seam for the provider popup ({@link DoctorRemedyOpener}); absent today. */
  readonly openRemedy?: DoctorRemedyOpener | undefined;
}

/**
 * A typed `/doctor` line the popup answers: `/doctor`, or `/doctor --deep` (which opens the popup with its confirmation line already open), white
 * space around the words ignored. Any other form is `undefined` and goes on to the command's own dispatch, which says what is wrong with it.
 */
export function parseDoctorLine(line: string): { readonly deep: boolean } | undefined {
  const [name, ...tokens] = line.trim().split(/\s+/u);
  if (name !== '/doctor') return undefined;
  if (!tokens.every((token) => token === '--deep')) return undefined;
  return { deep: tokens.length > 0 };
}

/** What a host asks for when it opens the doctor. */
export interface DoctorOpenRequest {
  readonly host: PopupHost;
  readonly port: DoctorPort;
  /** Open on the confirmation line (a typed `/doctor --deep`): it still needs its chord. */
  readonly deep: boolean;
  readonly origin: PopupOrigin;
  /** A MONOTONIC clock (production: `performance.now`); a test injects its own. */
  readonly now?: (() => number) | undefined;
  /** How the checks give the event loop back between two reads (production: a macrotask); a test injects its own. */
  readonly yieldToLoop?: (() => Promise<void>) | undefined;
}

/**
 * Open the doctor popup over `request.host`, loading its code on first use. The promise settles once the popup is open or refused (the host's
 * gate says why in one notification); it rejects only when the code could not be loaded, which the caller reports as a fault of its own.
 */
export async function openDoctor(request: DoctorOpenRequest): Promise<void> {
  const { openDoctorPopup } = await import('./doctor-session.js');
  openDoctorPopup(request);
}
