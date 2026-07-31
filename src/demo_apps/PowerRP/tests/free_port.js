/**
 * FREE-PORT ALLOCATION THAT SURVIVES A CONCURRENT SWEEP.
 *
 * THE RACE. The pattern copied into fourteen probes and into run_all.mjs is:
 * listen on port 0, read the port the kernel assigned, CLOSE the socket, then
 * hand the number to a child process that binds it. Between the close and the
 * child's bind there is a window — hundreds of milliseconds, since the child is
 * `uv run server.py` and has an interpreter to boot — in which nothing holds the
 * port. The gate runs browser probes three at a time, each spawning its own
 * backend, so two probes can be handed the SAME number and the loser dies with
 * `OSError: [Errno 48] Address already in use`, then `server never became ready`.
 * That is a TOCTOU bug, and it is why probes that pass alone fail in a batch —
 * the "known: backend port EADDRINUSE right after a prior run" flake.
 *
 * WHY NOT JUST HOLD THE SOCKET OPEN. The child binds the same address, so the
 * parent must let go first; SO_REUSEADDR does not make two live listeners on one
 * port work portably. The window cannot be closed from the allocator's side.
 *
 * WHAT THIS DOES INSTEAD. It cannot eliminate the window, so it makes losing it
 * survivable and RARE: the kernel's port is re-verified as still free immediately
 * before it is returned, and a caller that loses anyway retries with a fresh
 * number instead of dying. Exhausting the retries THROWS, naming the race — a
 * loud failure, never a silent fallback to a port that might be someone else's.
 */

import { createServer as createNetServer } from "node:net";

/** How many distinct ports to try before giving up. Small: a collision needs two
 *  probes to draw the same ephemeral port in the same instant, so even one retry
 *  makes a second collision vanishingly unlikely. */
const PORT_ATTEMPTS = 12;

/**
 * Query. One port the kernel currently considers free, with the socket released.
 *
 * @returns {Promise<number>}
 */
function kernelAssignedPort() {
  return new Promise((done, fail) => {
    const s = createNetServer();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });
}

/**
 * Query. Can we still bind `port` right now?
 *
 * Near-pure (binds and immediately releases a socket; no lasting state). This is
 * the re-check that turns a stale number into a retry instead of an EADDRINUSE
 * in a child process thirty seconds later.
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 *
 * @example await portStillFree(54321)
 * // true  — nothing took it between assignment and now
 * @example await portStillFree(8899)
 * // false — a backend is already listening there; caller draws another
 */
export function portStillFree(port) {
  return new Promise((done) => {
    const s = createNetServer();
    s.on("error", () => done(false));
    s.listen(port, "127.0.0.1", () => s.close(() => done(true)));
  });
}

/**
 * Query. A free TCP port on 127.0.0.1, re-verified free before it is returned.
 *
 * Drop-in replacement for the hand-rolled `freePort()` in the probes: same
 * signature, same usage, one fewer race. It still cannot guarantee the port is
 * free by the time a spawned child binds it — nothing can — so a caller whose
 * child may lose the window should use `withFreePort` and retry.
 *
 * @returns {Promise<number>} A port that was free moments ago.
 * @throws {Error} If no port survives re-verification, naming the race.
 *
 * @example await freePort()
 * // 54873 — assigned by the kernel, then re-checked as still bindable
 */
export async function freePort() {
  for (let i = 0; i < PORT_ATTEMPTS; i++) {
    const port = await kernelAssignedPort();
    if (await portStillFree(port)) return port;
  }
  throw new Error(
    `freePort: ${PORT_ATTEMPTS} kernel-assigned ports were all taken again before they could be used. ` +
    "That means something is claiming ports as fast as they are handed out — a runaway probe fleet, " +
    "or far too much concurrency. Not retrying silently: a wrong port fails later and much less clearly.",
  );
}

/**
 * Command. Run `attempt(port)` on a free port, retrying on a lost-port bind race.
 *
 * For callers that hand the port to a CHILD process, where the bind happens
 * long after allocation and can still lose. `attempt` must reject if the port
 * turns out to be taken; any other rejection is re-thrown immediately, so a real
 * failure is never retried into a confusing loop.
 *
 * @param {(port: number) => Promise<T>} attempt Receives the port; rejects on EADDRINUSE.
 * @param {(err: Error) => boolean} [isPortRace] Classifies an error as the race.
 * @returns {Promise<T>} Whatever `attempt` resolves to.
 * @template T
 *
 * @example await withFreePort(async (port) => startBackendOn(port));
 * // starts on 54873; if that port was stolen mid-boot, transparently retries on 55014
 */
export async function withFreePort(attempt, isPortRace = defaultIsPortRace) {
  let last;
  for (let i = 0; i < PORT_ATTEMPTS; i++) {
    const port = await freePort();
    try {
      return await attempt(port);
    } catch (e) {
      if (!isPortRace(e)) throw e; // a REAL failure — surface it, do not retry
      last = e;
      console.log(`  (port ${port} was taken between allocation and bind — retrying on a new one)`);
    }
  }
  throw new Error(`withFreePort: lost the port race ${PORT_ATTEMPTS} times; last error: ${last?.message ?? last}`);
}

/**
 * Pure function. Does this error look like "the port was already taken"?
 *
 * @param {Error} err
 * @returns {boolean}
 *
 * @example defaultIsPortRace(new Error("OSError: [Errno 48] Address already in use"))
 * // true — the python backend's message when it loses the race
 * @example defaultIsPortRace(new Error("server never became ready at http://…"))
 * // true — the probe-side symptom of the same loss
 * @example defaultIsPortRace(new Error("CHECK FAILED: overlay renders the full text"))
 * // false — a real assertion failure is never retried
 */
export function defaultIsPortRace(err) {
  const s = String(err?.message ?? err);
  return /EADDRINUSE|Address already in use|Errno 48|server never became ready/i.test(s);
}
