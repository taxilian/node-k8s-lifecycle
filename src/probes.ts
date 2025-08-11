import ServerTracker, { WebServer } from './serverTracker';

export const ReadinessProbeInterval = process.env.READYPROBE_INTERVAL ? parseInt(process.env.READYPROBE_INTERVAL, 10) : 30; // seconds
export const ClosingTimeout = process.env.SHUTDOWN_TIMEOUT ? parseInt(process.env.SHUTDOWN_TIMEOUT, 10) : 540; // seconds
export const ConnectionCheckInterval = 1000; // ms - how often we check for connection closure
export const ForceExitTimeout = 5000; // ms - how long to wait before force exit after Phase 3
const isDev = process.env.NODE_ENV !== 'production';

function keys<T extends Record<string | number | symbol, unknown>>(obj: T): (keyof T)[] {
    return Object.keys(obj || {}) as (keyof T)[];
}

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

export type isReadyCheck = (...args: unknown[]) => Promise<boolean>;
const readyChecks: isReadyCheck[] = [];
export function onReadyCheck(fn: isReadyCheck) { readyChecks.push(fn); }

export type stateChangeCb = (state: Phase, prevState: Phase) => void | Promise<void>;
const stateChangeCbs: stateChangeCb[] = [];
export function onStateChange(fn: stateChangeCb) { stateChangeCbs.push(fn); }

export type shutdownCb = () => Promise<void | unknown>;
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
    const results = await Promise.allSettled(promises);
    
    // Log any errors from state change callbacks
    results.forEach((result, index) => {
        if (result.status === 'rejected') {
            onException(`Error in state change callback ${index}:`, result.reason);
        }
    });
}

const delay = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

export interface ProbeRequest {
    query?: any;
    url?: string;
}

export interface ProbeResponse {
    statusCode?: number;
    writeHead?: (statusCode: number, headers?: any) => void;
    write: (chunk: any) => void;
    end: (chunk?: any) => void;
    status?: (code: number) => ProbeResponse;
    send?: (data: any) => void;
}

export type ProbeHandler = (req: ProbeRequest, res: ProbeResponse) => void | Promise<void>;

// Simple probe check functions that return boolean for easy integration
export async function isReady(): Promise<boolean> {
    if (failCase || shutdownRequested) {
        return false;
    } else if (!httpTrackers.length) {
        return false;
    }
    
    const allReadyChecks = await Promise.allSettled(readyChecks.map(fn => fn()));
    const readyChecksPassed = allReadyChecks.every(result => 
        result.status === 'fulfilled' && result.value === true
    );

    const httpStarted = httpTrackers.every(t => t.isListening);
    if (!readyChecksPassed || !httpStarted) {
        return false;
    }
    
    if (phase === Phase.Startup) { 
        await updatePhase(Phase.Running); 
    }
    
    return true;
}

export function isHealthy(): boolean {
    return !failCase;
}

// Detailed probe check functions that return status and message
export interface ProbeCheckResult {
    healthy: boolean;
    message: string;
    statusCode: number;
}

export async function checkReadiness(): Promise<ProbeCheckResult> {
    if (failCase || shutdownRequested) {
        return { healthy: false, message: "Service is closing", statusCode: 503 };
    } else if (!httpTrackers.length) {
        return { healthy: false, message: "Server not ready", statusCode: 503 };
    }
    
    const allReadyChecks = await Promise.allSettled(readyChecks.map(fn => fn()));
    const readyChecksPassed = allReadyChecks.every(result => 
        result.status === 'fulfilled' && result.value === true
    );

    const httpStarted = httpTrackers.every(t => t.isListening);
    if (!readyChecksPassed) {
        return { healthy: false, message: "Ready check(s) failed", statusCode: 503 };
    } else if (!httpStarted) {
        return { healthy: false, message: "HTTP server not ready", statusCode: 503 };
    }
    
    if (phase === Phase.Startup) { 
        await updatePhase(Phase.Running); 
    }
    
    return { healthy: true, message: "ready", statusCode: 200 };
}

export function checkLiveness(): ProbeCheckResult {
    if (failCase) {
        return { 
            healthy: false, 
            message: `Unrecoverable error: ${failCase.message}`, 
            statusCode: 503 
        };
    }
    return { healthy: true, message: "alive", statusCode: 200 };
}

export interface ProbeRouter {
    get(path: string, handler: ProbeHandler): void;
    [key: string]: any; // Allow additional properties for Express compatibility
}

export type RouterFactory = () => ProbeRouter;

function createProbeHandlers() {
    const testHandler: ProbeHandler = async (req, res) => {
        const timeout = req.query?.t ? parseInt(req.query.t as string) : 10000;
        res.write(`Waiting for ${timeout} ...\n`);
        await delay(timeout);
        res.write(`Done`);
        res.end();
    };

    const readyHandler: ProbeHandler = async (_req, res) => {
        try {
            const result = await checkReadiness();
            sendResponse(res, result.statusCode, result.message);
        } catch (err: any) {
            onException("Error in readiness probe: ", err, err?.stack);
            sendResponse(res, 500, "Unexpected error: " + err?.toString());
        }
    };

    const liveHandler: ProbeHandler = (_req, res) => {
        const result = checkLiveness();
        sendResponse(res, result.statusCode, result.message);
    };

    return { testHandler, readyHandler, liveHandler };
}

function sendResponse(res: ProbeResponse, statusCode: number, message: string) {
    if (res.status && res.send) {
        // Express-like response
        const statusRes = res.status(statusCode);
        if (statusRes && statusRes.send) {
            statusRes.send(message);
        }
    } else if (res.writeHead) {
        // Node.js raw response
        res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
        res.end(message);
    } else {
        // Fallback
        res.statusCode = statusCode;
        res.end(message);
    }
}

// Try to get Express Router if available
function getExpressRouter(): RouterFactory | null {
    try {
        const express = require('express');
        return express.Router;
    } catch (e) {
        return null;
    }
}

export function getProbeRouter(urls: Partial<typeof HealthCheckURLs> = {}, RouterFactoryOrConstructor?: RouterFactory | any): any {
    for (const k of keys(urls)) {
        HealthCheckURLs[k] = urls[k]!;
    }
    
    let routerFactory: RouterFactory;
    
    if (!RouterFactoryOrConstructor) {
        // No factory provided, try to auto-detect Express
        const expressRouter = getExpressRouter();
        if (!expressRouter) {
            throw new Error('No router factory provided and Express is not installed. Please install express or provide a router factory function.');
        }
        routerFactory = expressRouter;
    } else if (typeof RouterFactoryOrConstructor === 'function') {
        // It's either a factory function or a constructor
        routerFactory = RouterFactoryOrConstructor;
    } else {
        throw new Error('RouterFactoryOrConstructor must be a function');
    }
    
    const probeRouter = routerFactory();
    const { testHandler, readyHandler, liveHandler } = createProbeHandlers();
    
    if (HealthCheckURLs.test) {
        probeRouter.get(HealthCheckURLs.test, testHandler);
    }
    probeRouter.get(HealthCheckURLs.ready, readyHandler);
    probeRouter.get(HealthCheckURLs.live, liveHandler);
    
    return probeRouter;
}



// Generic handlers that work with any framework supporting async route handlers
export const probeHandlers = {
    // Returns the check result - framework can decide how to handle it
    readiness: async (): Promise<ProbeCheckResult> => {
        return await checkReadiness();
    },
    
    liveness: (): ProbeCheckResult => {
        return checkLiveness();
    },
    
    // Combined health check
    health: async (): Promise<{ ready: boolean; healthy: boolean; status: string }> => {
        const ready = await isReady();
        const healthy = isHealthy();
        return {
            ready,
            healthy,
            status: ready && healthy ? 'ok' : 'degraded'
        };
    }
};



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
        const userShutdownChecks = await Promise.allSettled(shutdownCheckCbs.map(cb => cb()));
        const userChecksFailed = userShutdownChecks.some(result => 
            result.status === 'rejected' || (result.status === 'fulfilled' && result.value === false)
        );
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
        shutdownWatchTimeout = setTimeout(shutdownConnectionWatch, ConnectionCheckInterval).unref();
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
    shutdownWatchTimeout = setTimeout(shutdownConnectionWatch, ConnectionCheckInterval).unref();

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
        const shutdownResults = await Promise.allSettled(shutdownCbs.map(cb => cb()));
        
        // Log any errors from shutdown callbacks
        shutdownResults.forEach((result, index) => {
            if (result.status === 'rejected') {
                onException(`Error in shutdown callback ${index}:`, result.reason);
            }
        });

        console.log("Application stopped, as long as all running tasks are stopped");

        // At this point it should be shut down within 5 seconds; if it isn't then
        // we just kill it
        setTimeout(forceShutdown, ForceExitTimeout).unref();
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

function forceShutdown(code?: number | string | null) {
    console.log("Failed to shut down gracefully, shutting down hard now");
    // If we hit this, dump out what was still keeping the process alive
    process.exit(code);
}