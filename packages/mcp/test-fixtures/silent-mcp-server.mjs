// A stdio child that SPAWNS but never speaks MCP — the fixture the connect-cancellation e2e needs.
//
// The orphan window ADR-0088 §1.3 is really about is the CONNECT: the SDK spawns the child inside
// `transport.start()`, so between the spawn and a completed `initialize` there is a live process and no
// finished client. A cold `npx` holds that window open for up to 120 s with the terminal silent, which is
// exactly when a user reaches for Ctrl-C.
//
// Every other fixture here completes the handshake, so none of them can hold that window open. This one
// answers nothing at all: it reads stdin and drops it, and holds the loop with a timer. It also traps the
// polite signals, so a test that observes the child dying is observing the HOST reaping it rather than the
// terminal's process group doing the work.
import process from 'node:process';

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    // Deliberately nothing — see above.
  });
}
process.stdin.resume();
process.stdin.on('data', () => {
  // Read and discard: never reply, so `initialize` can never complete.
});
setInterval(() => {}, 1_000);
