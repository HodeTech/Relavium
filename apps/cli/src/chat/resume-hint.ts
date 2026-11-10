/** Saved ids are untrusted. Only shell-neutral ids can become a copyable command argument. */
export function resumeHint(sessionId: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(sessionId)
    ? `Continue in relavium with /resume, or: relavium chat resume ${sessionId}\n`
    : 'Continue in relavium with /resume, or use the relavium chat resume picker.\n';
}
