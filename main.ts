// Entry point for the forge. This process IS the trial's server, and its whole
// job is the handshake with the env: bring the app up on a kernel-chosen port,
// tell the env where to find it, then stay alive until the env says the trial
// is over. The forge itself lives in app.ts; this file only runs it.
//
// The env is reached through MAKEFUN_ENV_URL, and the conversation has exactly
// three moves:
//
//   1. POST <env>/register  { "port": <the port we bound> }
//      200 means we are registered. 409 means another entry registered first,
//      which is not ours to fix — we wait like everyone else. 400 or 405 mean
//      our request broke the contract, so retrying is pointless and we quit.
//      Anything else (a dropped connection, a 5xx, the env still booting) is
//      retried until it works.
//   2. GET <env>/done, again and again, until the body reads { "done": true }.
//      The env answers at once every time, so this is a poll loop, and a failed
//      poll is never a reason to quit — the trial simply is not over yet.
//   3. Close the server and exit 0. The harness tears the env down after that.
//
// A SIGTERM or SIGINT (the harness stopping us) closes the server and exits 0
// instead of leaving the port dangling.

import { createApp } from './app.ts';
import type { Server } from 'node:http';

/** One call to the env may take this long before it is abandoned and retried. */
const CALL_TIMEOUT_MS = 30_000;
/** First pause between retries, and the longest pause. */
const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 2_000;

/** A failure that must end the process instead of being retried. */
class FatalProblem extends Error {}

/**
 * The env origin from MAKEFUN_ENV_URL, trailing slashes removed, or null when
 * the variable is missing or not an http(s) URL. A bad origin can never work,
 * so it is a startup failure, not something to poll forever.
 */
function envOrigin(): string | null {
  const raw = (process.env.MAKEFUN_ENV_URL ?? '').trim().replace(/\/+$/, '');
  if (raw === '') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return raw;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Pause before the next retry: doubles from FIRST_RETRY_MS, capped at MAX_RETRY_MS. */
function retryPauseMs(failures: number): number {
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(failures, 3));
}

/**
 * Call `work` until it reports true. A FatalProblem escapes at once; any other
 * failure is treated as transient and retried after a growing pause.
 */
async function repeatUntilTrue(label: string, work: () => Promise<boolean>): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      if (await work()) return;
    } catch (err) {
      if (err instanceof FatalProblem) throw err;
      process.stderr.write(`[forge] ${label} failed (${failures + 1}): ${err instanceof Error ? err.message : String(err)}\n`);
    }
    await sleep(retryPauseMs(failures));
    failures += 1;
  }
}

/**
 * One HTTP call to the env, with a timeout. Returns the response, or null when
 * the call itself never completed (the env is down, the network dropped it).
 */
async function callEnv(origin: string, path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(`${origin}${path}`, {
      ...init,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

/** Register the bound port with the env, retrying until it is accepted. */
async function registerPort(origin: string, port: number): Promise<void> {
  await repeatUntilTrue('register', async () => {
    const res = await callEnv(origin, '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    if (res === null) return false;
    if (res.status === 200 || res.status === 409) return true;
    if (res.status === 400 || res.status === 405) {
      throw new FatalProblem(`register refused with HTTP ${res.status}: ${await res.text()}`);
    }
    return false;
  });
}

/** Poll GET /done until the env says the trial is over. */
async function waitForDone(origin: string): Promise<void> {
  await repeatUntilTrue('done', async () => {
    const res = await callEnv(origin, '/done');
    if (res === null || !res.ok) return false;
    const body = (await res.json().catch(() => null)) as { done?: unknown } | null;
    return body !== null && body.done === true;
  });
}

/**
 * Start the forge on a kernel-chosen port and return the server and the port
 * it bound. Port 0 means the kernel picks; never a fixed port, and never 8080,
 * which belongs to the env.
 */
async function bindEphemeral(): Promise<{ server: Server; port: number }> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new FatalProblem('the forge did not bind a TCP port');
  }
  return { server, port: address.port };
}

/** Close the server, waiting for its connections to drain. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** The whole life of the process: bind, register, wait, shut down. */
async function run(): Promise<void> {
  const origin = envOrigin();
  if (origin === null) {
    throw new FatalProblem('MAKEFUN_ENV_URL is not set (or not an http(s) URL): there is no env to register with');
  }
  const { server, port } = await bindEphemeral();
  process.stdout.write(`[forge] listening on port ${port}\n`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void closeServer(server).then(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await registerPort(origin, port);
  process.stdout.write('[forge] registered; waiting for the env to finish\n');
  await waitForDone(origin);
  await closeServer(server);
  process.stdout.write('[forge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[forge] ${message}\n`);
  process.exit(1);
}
