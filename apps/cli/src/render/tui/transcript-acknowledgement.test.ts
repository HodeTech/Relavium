import { describe, expect, it } from 'vitest';

import { createChatStore } from './chat-store.js';
import { createTranscriptAcknowledgement } from './transcript-acknowledgement.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

describe('transcript publication acknowledgement', () => {
  it('requires the exact newly printed notice, even when its text matches an earlier notice', () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const proof = createTranscriptAcknowledgement(() => store);
    store.notice('same notice');
    const old = store.getSnapshot().state.transcript[0];
    if (old === undefined) throw new Error('missing first notice');
    proof.inlineNotice(old);
    const publication = proof.capture();
    store.notice('same notice');
    publication.published();
    expect(publication.visible()).toBe(false);
    const next = store.getSnapshot().state.transcript[1];
    if (next === undefined) throw new Error('missing next notice');
    proof.inlineNotice(next);
    expect(publication.visible()).toBe(true);
  });

  it('refuses a clipped notice and accepts its complete committed viewport window', () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const proof = createTranscriptAcknowledgement(() => store);
    const publication = proof.capture();
    store.notice('first row\nsecond row');
    publication.published();
    const transcript = store.getSnapshot().state.transcript;
    proof.viewport(transcript, 20, 1, 2, 20);
    expect(publication.visible()).toBe(false);
    proof.viewport(transcript, 20, 0, 0, 20);
    expect(publication.visible()).toBe(false);
    proof.viewport(transcript, 20, 0, 2, 10);
    expect(publication.visible()).toBe(false);
    proof.viewport(transcript, 20, 0, 2, 20);
    expect(publication.visible()).toBe(true);
  });

  it('does not acknowledge a new notice from a stale viewport frame', () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const proof = createTranscriptAcknowledgement(() => store);
    store.notice('earlier notice');
    proof.viewport(store.getSnapshot().state.transcript, 40, 0, 1, 40);
    const publication = proof.capture();
    store.notice('effect disclosure');
    publication.published();
    expect(publication.visible()).toBe(false);
  });

  it('refuses a store replacement after publication, even with the same carried notice objects', () => {
    let store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const proof = createTranscriptAcknowledgement(() => store);
    const publication = proof.capture();
    store.notice('effect disclosure');
    publication.published();
    const transcript = store.getSnapshot().state.transcript;
    proof.viewport(transcript, 40, 0, 1, 40);
    expect(publication.visible()).toBe(true);
    store = createChatStore(false, { transcript }, INLINE_TRANSCRIPT_BOUND);
    expect(publication.visible()).toBe(false);
  });
});
