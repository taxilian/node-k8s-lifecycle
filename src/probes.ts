import express = require("express");
import ServerTracker, { WebServer } from './serverTracker';

const ReadinessProbeInterval = process.env.READYPROBE_INTERVAL ? parseInt(process.env.READYPROBE_INTERVAL, 10) : 30; // seconds
const ClosingTimeout = process.env.SHUTDOWN_TIMEOUT ? parseInt(process.env.SHUTDOWN_TIMEOUT, 10) : 540; // seconds
const isDev = process.env.NODE_ENV !== 'production';

let shutdownRequested = false;
let shutdownWatchTimeout: NodeJS.Timeout | undefined;

let failCase: Error;
export function setUnrecoverableError(err: Error) {
    failCase = err;
    onException(`Unrecoverable error set:`, err, err.stack);
    if (isDev) {
        // In dev mode just kill it now
        process.exit(1);
    }
}

let onException = console.warn.bind(console);
export function setOnException(fn: typeof onException) {
  onException = fn;
}

export enum Phase {
    Startup = 'starting',
    Running = 'run',
    Phase1 = 'shutdownReq',
    Phase2 = 'shuttingDown',
    Phase3 = 'final',
};
let phase = Phase.Startup;

const HealthCheckURLs = {
  test: '/api/probe/test',
  ready: '/api/probe/ready',
  live: '/api/probe/live',
};

export type isReadyCheck = (...args: any[]) => Promise<boolean>;
const readyChecks: isReadyCheck[] = [];
export function onReadyCheck(fn: isReadyCheck) { readyChecks.push(fn); }

export type stateChangeCb = (state: Phase, prevState: Phase) => void | Promise<void>;
const stateChangeCbs: stateChangeCb[] = [];
export function onStateChange(fn: stateChangeCb) { stateChangeCbs.push(fn); }

export type shutdownCb = () => Promise<any>;
const shutdownCbs: shutdownCb[] = [];
export function onShutdown(fn: shutdownCb) { shutdownCbs.push(fn); }

export type readyToShutdownCb = () => Promise<boolean>;
const shutdownCheckCbs: readyToShutdownCb[] = [];
export function addShutdownReadyCheck(fn: readyToShutdownCb) { shutdownCheckCbs.push(fn); }

let httpTrackers: ServerTracker[] = [];
export function addHttpServer(server: ServerTracker | WebServer) {
    if (server instanceof ServerTracker) {
        httpTrackers.push(server);
    } else {
        const tracker = new ServerTracker(server, {
            healthCheckUrls: Object.values(HealthCheckURLs),
        });
        httpTrackers.push(tracker);
    }
}

async function updatePhase(newPhase: Phase) {
    if (phase === newPhase) {
        return;
    }
    const old = phase;
    phase = newPhase;
    const promises = stateChangeCbs.map(cb => cb(phase, old));
    try {
        await Promise.all(promises);
    } catch {}
}

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

export function getProbeRouter(urls: Partial<typeof HealthCheckURLs> = {}, RouterConstructor = express.Router) {
  for (const k of Object.keys(urls)) {
    // @ts-ignore: TS can't tell if this is safe, but it is
    HealthCheckURLs[k] = urls[k];
  }
  const probeRouter = RouterConstructor();

  if (HealthCheckURLs.test) {
    probeRouter.get(HealthCheckURLs.test, async (req, res) => {
        const timeout = req.query.t ? parseInt(req.query.t as string) : 10000;
        res.write(`Waiting for ${timeout} ...\n`);
        await delay(timeout);
    
        res.write(`Done`);
        res.end();
    });
  }
  
  probeRouter.get(HealthCheckURLs.ready, async (req, res) => {
    // console.log("READY check:", failCase, shutdownRequested);
      try {
          if (failCase || shutdownRequested) {
              // As soon as shutdown is requested, start returning invalid for the readiness;
              // we should also be "unready" any time there is a fail case, which also will
              // fail liveness
              return res.status(500).send("Service is closing");
          } else if (!httpTrackers.length) {
              // This shouldn't be possible
              return res.status(500).send("Server not ready");
          }
          const allReadyChecks = await Promise.all(readyChecks.map(fn => fn()));
          const readyChecksPassed = allReadyChecks.every(Boolean);
  
          const httpStarted = httpTrackers.every(t => t.isListening);
          if (!readyChecksPassed) {
              return res.status(500).send("Ready check(s) failed");
          } else if (!httpStarted) {
              return res.status(500).send("HTTP server not ready");
          }
          if (phase === Phase.Startup) { await updatePhase(Phase.Running); }
          return res.send("ready");
      } catch (err: any) {
          onException("Error in readiness probe: ", err, err?.stack);
          return res.status(500).send("Unexpected error: " + err?.toString());
      }
  });
  probeRouter.get(HealthCheckURLs.live, (req, res) => {
      if (failCase) {
          // There was an unrecoverable error
          return res.status(500).send(`Unrecoverable error: ${failCase.message}`);
      }
      return res.send("alive");
  });
  return probeRouter;
}

export async function startShutdown() {
    // if (isDev) {
    //     console.warn("In Dev mode -- shutting down immediately");
    //     process.exit(1);
    // }
    console.log("Requesting shutdown");
    // This will make the readiness endpoint start returning "not ready"
    shutdownRequested = true;
    await updatePhase(Phase.Phase1);

    // Then we're going to wait for ReadinessProbeInterval * 1.5 to give
    // plenty of time for it to stop sending us new requests before the next phase
    setTimeout(shutdownPhase2, ReadinessProbeInterval * 1.5 * 1000);
}



// Watch for the connection count to drop to zero
async function shutdownConnectionWatch() {
    shutdownWatchTimeout = void 0;
    try {
        const remaining = httpTrackers.reduce((memo, c) => memo + c.connectionCount, 0);
        const active = httpTrackers.reduce((memo, c) => memo + c.activeConnectionCount, 0);
        const userShutdownChecks = await Promise.all(shutdownCheckCbs.map(cb => cb()));
        const userChecksFailed = userShutdownChecks.some(c => c === false);
        if (!active && !userChecksFailed) {
            console.log("All connections closed!");
            finishShutdown();
        } else {
          if (active) {
            console.log(`Pending shutdown, waiting on ${remaining} connections (${active} active)`);
          }
          if(userChecksFailed) {
            console.log(`Pending shutdown, waiting on user shutdown checks`);
          }
          throw new Error();
        }
    } catch {
        shutdownWatchTimeout = setTimeout(shutdownConnectionWatch, 1000).unref();
    }
}

/**
 * Stops accepting new connections, but does not
 * (yet) terminate existing connections
 */
 async function shutdownPhase2() {
    console.log("Beginning phase 2 shutdown, no longer accepting connections");
    await updatePhase(Phase.Phase2);

    for (const t of httpTrackers) {
        t.requestShutdown();
    }

    // Check every second to see if we're able to shut down -- once all connections
    // are closed we can safely do so
    shutdownWatchTimeout = setTimeout(shutdownConnectionWatch, 1000).unref();

    setTimeout(async () => {
        // If we ever get to this point we're just going to force close everything
        console.warn("Close timeout reached, forcing to close");
        finishShutdown();
    }, ClosingTimeout * 1000).unref();
}

async function finishShutdown() {
    if (shutdownWatchTimeout) {
        clearTimeout(shutdownWatchTimeout);
    }
    console.log("Finishing shut-down...");

    try {
        // Make sure we're in the final phase
        await updatePhase(Phase.Phase3);

        // Force close any remaining connections
        for (const t of httpTrackers) {
            t.forceClose();
        }
        // Run any registered shutdown handlers
        await Promise.all(shutdownCbs.map(cb => cb()));

        console.log("Application stopped, as long as all running tasks are stopped");

        // At this point it should be shut down within 5 seconds; if it isn't then
        // we just kill it
        setTimeout(forceShutdown, 5000).unref();
    } catch (err) {
        console.warn("Error shutting down: ", err);
        process.exit(1);
    }
}

let intCalled = false;
process.on('SIGTERM', function() {
    if (intCalled) {
        console.warn("Second SIGTERM received, stopping now");
        forceShutdown(-127);
    }
    startShutdown();
    intCalled = true;
});

function forceShutdown(code: any) {
    console.log("Failed to shut down gracefully, shutting down hard now");
    // If we hit this, dump out what was still keeping the process alive
    process.exit(code);
    process.abort();
}
