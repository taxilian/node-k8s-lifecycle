# k8s-lifecycle

A TypeScript/Node.js library that helps implement Kubernetes lifecycle management correctly, ensuring graceful shutdowns and proper health check handling for seamless deployments, scaling, and restarts.

## Installation

```bash
npm install k8s-lifecycle
```

Note: This library requires Express as a peer dependency (version 3.0.0 or higher).

## Why Use This Library?

Kubernetes lifecycle events appear simple at first, but implementing them correctly is crucial for zero-downtime deployments. This library handles the complexity of:

- **Graceful shutdowns** that prevent dropped connections
- **Proper health check timing** to ensure traffic stops before your app does
- **Connection tracking** to wait for active requests to complete
- **Automatic signal handling** for Kubernetes termination

## Quick Start

```typescript
import * as K8sLifecycle from 'k8s-lifecycle';
import express from 'express';
import http from 'http';

const app = express();

// Add the probe endpoints to your Express app
const probeRouter = K8sLifecycle.getProbeRouter({
  test: '/api/probe/test',   // Optional test endpoint
  ready: '/api/probe/ready',  // Readiness probe endpoint
  live: '/api/probe/live',    // Liveness probe endpoint
});

app.use(probeRouter);

// Create your server and register it with k8s-lifecycle
const server = http.createServer(app);
K8sLifecycle.add(server);

// Add custom readiness checks (optional)
K8sLifecycle.onReadyCheck(async () => {
  // Return true if your app is ready to receive traffic
  return isDatabaseConnected && isRedisReady;
});

// Add cleanup handlers for graceful shutdown
K8sLifecycle.onShutdown(async () => {
  await mongoose.disconnect();
  await redisClient.quit();
  clearInterval(backgroundJobInterval);
});

server.listen(3000);
```

## How It Works

### The Three Lifecycle Probes

1. **Startup Probe** - Allows longer startup times before switching to liveness checks
2. **Readiness Probe** - Determines if your pod should receive traffic
3. **Liveness Probe** - Determines if your pod is healthy and should keep running

### Graceful Shutdown Process

When Kubernetes wants to terminate your pod, this library orchestrates a three-phase shutdown:

#### Phase 1: Stop Accepting Traffic (`shutdownReq`)
- Readiness endpoint immediately starts returning failures
- Kubernetes stops sending new traffic to your pod
- Existing connections continue to work
- Duration: 1.5 × readiness check interval (configurable)

#### Phase 2: Drain Connections (`shuttingDown`)
- Server stops accepting new connections
- Existing requests are allowed to complete
- Idle connections are closed
- New non-health-check requests receive 503 status with `Connection: close` header
- Websocket clients should be notified to reconnect
- Health check endpoints continue to respond

#### Phase 3: Final Cleanup (`final`)
- All connections have been closed or timeout reached
- Database connections are closed
- Background jobs are cancelled
- Process exits cleanly

### Robust Error Handling

The library uses `Promise.allSettled` for all callback arrays, ensuring that:
- One failing callback doesn't prevent others from running
- All shutdown handlers execute even if some throw errors
- Errors are logged but don't stop the shutdown process

## API Reference

### Core Functions

#### `getProbeRouter(urls?, RouterConstructor?)`
Creates an Express router with health check endpoints.

```typescript
const probeRouter = K8sLifecycle.getProbeRouter({
  test: '/api/probe/test',   // Optional, defaults provided
  ready: '/api/probe/ready',
  live: '/api/probe/live',
});
```

#### `add(server)`
Registers an HTTP/HTTPS server for lifecycle management.

```typescript
K8sLifecycle.add(server);
```

#### `onReadyCheck(fn)`
Adds a custom readiness check. Return `true` if ready, `false` if not.

```typescript
K8sLifecycle.onReadyCheck(async () => {
  return await checkDatabaseConnection();
});
```

#### `onShutdown(fn)`
Adds a cleanup handler for graceful shutdown. This is called when a shutdown has been requested, but the process won't exist until all shutdown readiness checks have passed.

```typescript
K8sLifecycle.onShutdown(async () => {
  await closeAllConnections();
});
```

#### `addShutdownReadyCheck(fn)`
Adds a check to determine if the app is ready to complete shutdown. When a shutdown is requested all onShutdown handlers are called, but if there are things that take time to shut down this function can be used to let it know when it's safe to exit.

```typescript
K8sLifecycle.addShutdownReadyCheck(async () => {
  return pendingJobs.length === 0;
});
```

#### `onStateChange(fn)`
Monitors lifecycle state transitions.

```typescript
K8sLifecycle.onStateChange((newState, oldState) => {
  logger.info(`Lifecycle state changed: ${oldState} → ${newState}`);
});
```

Available states (exported as `Phase` enum):
- `starting` - Initial startup
- `run` - Normal operation
- `shutdownReq` - Phase 1 shutdown
- `shuttingDown` - Phase 2 shutdown
- `final` - Phase 3 shutdown

```typescript
import { Phase } from 'k8s-lifecycle';

K8sLifecycle.onStateChange((newState, oldState) => {
  if (newState === Phase.Phase2) {
    // Handle phase 2 specific logic
  }
});
```

#### `setUnrecoverableError(error)`
Marks the application as unhealthy, causing liveness checks to fail. Any time something happens that you can't recover from, use this. Good examples include the inability to connect to a database or a critical service, errors that leave the application in an inconsistent state, or anything else that means the application will not work without being restarted.

```typescript
K8sLifecycle.setUnrecoverableError(new Error("Lost database connection"));
```

#### `startShutdown()`
Manually triggers graceful shutdown (automatically called on SIGTERM).

#### `setOnException(fn)`
Sets the error logging handler (defaults to `console.warn`).

```typescript
K8sLifecycle.setOnException((msg, ...args) => {
  logger.error(msg, ...args);
});
```

## Environment Variables

- `READYPROBE_INTERVAL` - Readiness check interval in seconds (default: 30)
- `SHUTDOWN_TIMEOUT` - Maximum shutdown duration in seconds (default: 540)
- `NODE_ENV` - When not "production", unrecoverable errors immediately exit

## Best Practices

### 1. Keep Health Checks Lightweight

Don't perform expensive operations in readiness checks. Instead, maintain state:

```typescript
let dbHealthy = true;

// Check periodically in the background
setInterval(async () => {
  try {
    await db.ping();
    dbHealthy = true;
  } catch (err) {
    dbHealthy = false;
  }
}, 5000).unref();

// Use cached state in readiness check
K8sLifecycle.onReadyCheck(async () => dbHealthy);
```

### 2. Handle Long-Running Requests

Ensure your shutdown timeout accounts for your longest operations:

```bash
# For operations that might take up to 5 minutes
export SHUTDOWN_TIMEOUT=360
```

### 3. Clean Up Resources

Prevent your Node.js process from hanging:

```typescript
// Use unref() on timers that shouldn't block shutdown
const timer = setInterval(backgroundTask, 5000);
timer.unref();

// Always clean up in shutdown handler
K8sLifecycle.onShutdown(async () => {
  clearInterval(timer);
  await closeAllConnections();
});
```

### 4. Configure Kubernetes Properly

```yaml
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: app
    livenessProbe:
      httpGet:
        path: /api/probe/live
        port: 3000
      initialDelaySeconds: 30
      periodSeconds: 10
    readinessProbe:
      httpGet:
        path: /api/probe/ready
        port: 3000
      initialDelaySeconds: 5
      periodSeconds: 5
    lifecycle:
      preStop:
        exec:
          command: ["sh", "-c", "sleep 15"]  # Give time for endpoints to update
```

## Troubleshooting

### Process Won't Exit

Common causes:
- Open network connections
- Active timers without `.unref()`
- Unclosed file handles
- Database connections not closed in shutdown handler

### Connections Dropped During Deployment

Ensure:
- Readiness check interval in Kubernetes matches `READYPROBE_INTERVAL`
- preStop hook gives enough time for readiness checks to propagate
- Phase 1 duration is sufficient (1.5 × check interval)

### WebSocket Handling

Notify clients to reconnect during Phase 2:

```typescript
K8sLifecycle.onStateChange((newState) => {
  if (newState === 'shuttingDown') {
    io.emit('reconnect-required');
    io.close();
  }
});
```

## License

ISC

## Recent Improvements

### Version 1.1.0 (Latest)
- **Connection Management**: Added `Connection: close` header during shutdown to prevent connection reuse
- **Robust Error Handling**: All callbacks now use `Promise.allSettled` to ensure execution even if some fail
- **Better TypeScript Support**: Fixed type issues and exported `Phase` enum for better discoverability
- **Error Logging**: Errors in callbacks are now properly logged instead of silently swallowed

## Contributing

Issues and pull requests are welcome at [github.com/taxilian/node-k8s-lifecycle](https://github.com/taxilian/node-k8s-lifecycle).