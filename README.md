# k8s-lifecycle

A TypeScript/Node.js library that helps implement Kubernetes lifecycle management correctly, ensuring graceful shutdowns and proper health check handling for seamless deployments, scaling, and restarts.

## Installation

```bash
npm install k8s-lifecycle
```

Note: Express is an optional peer dependency. The library will auto-detect and use Express if available, but you can also use it with Fastify or other frameworks.

## Why Use This Library?

Kubernetes lifecycle events appear simple at first, but implementing them correctly is crucial for zero-downtime deployments. This library handles the complexity of:

- **Graceful shutdowns** that prevent dropped connections
- **Proper health check timing** to ensure traffic stops before your app does
- **Connection tracking** to wait for active requests to complete
- **Automatic signal handling** for Kubernetes termination

## Quick Start

### Using with Express

```javascript
const express = require('express');
const http = require('http');
const { 
    getProbeRouter,
    addHttpServer,
    onShutdown,
    onReadyCheck
} = require('k8s-lifecycle');

const app = express();

// Add the probe endpoints to your Express app
const probeRouter = getProbeRouter({
    test: '/health/test',   // Optional test endpoint
    ready: '/health/ready',  // Readiness probe endpoint
    live: '/health/live',    // Liveness probe endpoint
});

app.use(probeRouter);

// Add custom readiness checks (optional)
onReadyCheck(async () => {
    // Return true if your app is ready to receive traffic
    return isDatabaseConnected && isRedisReady;
});

// Add cleanup handlers for graceful shutdown
onShutdown(async () => {
    await mongoose.disconnect();
    await redisClient.quit();
    clearInterval(backgroundJobInterval);
});

// Create your server and register it with k8s-lifecycle
const server = http.createServer(app);
addHttpServer(server);

server.listen(3000, () => {
    console.log('Server listening on port 3000');
});
```

### Using with Fastify

```javascript
const fastify = require('fastify')({ logger: true });
const { 
    addHttpServer,
    onShutdown,
    onReadyCheck,
    isReady,      // Simple boolean check
    isHealthy     // Simple boolean check
} = require('k8s-lifecycle');

// Use the simple check functions with Fastify routes
fastify.get('/health/ready', async () => {
    const ready = await isReady();
    if (!ready) {
        throw { statusCode: 503, message: 'Service not ready' };
    }
    return { status: 'ready' };
});

fastify.get('/health/live', async () => {
    const healthy = isHealthy();
    if (!healthy) {
        throw { statusCode: 503, message: 'Service unhealthy' };
    }
    return { status: 'healthy' };
});

// Add custom readiness checks
onReadyCheck(async () => {
    return isDatabaseConnected;
});

// Register shutdown handler
onShutdown(async () => {
    await fastify.close();
});

// Start and register server
fastify.listen({ port: 3000, host: '0.0.0.0' }, (err) => {
    if (err) process.exit(1);
    addHttpServer(fastify.server);
});
```

### Using with Any Framework

The library provides simple check functions that work with any framework:

```javascript
const { isReady, isHealthy, checkReadiness, checkLiveness } = require('k8s-lifecycle');

// Simple boolean checks
app.get('/health', async (req, res) => {
    const ready = await isReady();
    const healthy = isHealthy();
    
    if (ready && healthy) {
        res.status(200).json({ status: 'ok' });
    } else {
        res.status(503).json({ status: 'degraded', ready, healthy });
    }
});

// Or use detailed check results
app.get('/ready', async (req, res) => {
    const result = await checkReadiness();
    res.status(result.statusCode).send(result.message);
});
```

## Running the Examples

The repository includes complete working examples:

```bash
# Express with traditional router approach
node examples/express-example.js

# Express with generic handlers (simpler)
node examples/express-simple.js

# Fastify example
node examples/fastify-example.js

# Fastify with simple boolean checks
node examples/fastify-native-simple.js
```

All examples demonstrate:
- Setting up health check endpoints
- Custom readiness checks
- Graceful shutdown handlers
- Simulated database connections
- Error handling

Test the health endpoints:
```bash
# Readiness check
curl http://localhost:3000/health/ready

# Liveness check
curl http://localhost:3000/health/live

# Combined health check (Fastify native example)
curl http://localhost:3002/health
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

### Probe Check Functions

#### `isReady(): Promise<boolean>`
Simple boolean check for readiness. Returns `true` if the service is ready to accept traffic.

```typescript
const ready = await isReady();
```

#### `isHealthy(): boolean`
Simple boolean check for liveness. Returns `true` if the service is healthy.

```typescript
const healthy = isHealthy();
```

#### `checkReadiness(): Promise<ProbeCheckResult>`
Detailed readiness check with status code and message.

```typescript
const result = await checkReadiness();
// result = { healthy: true, message: 'ready', statusCode: 200 }
```

#### `checkLiveness(): ProbeCheckResult`
Detailed liveness check with status code and message.

```typescript
const result = checkLiveness();
// result = { healthy: true, message: 'alive', statusCode: 200 }
```

### Express Integration

#### `getProbeRouter(urls?, RouterFactoryOrConstructor?)`
Creates a router with health check endpoints. Auto-detects Express if no factory is provided.

```typescript
const probeRouter = K8sLifecycle.getProbeRouter({
  test: '/api/probe/test',   // Optional, defaults provided
  ready: '/api/probe/ready',
  live: '/api/probe/live',
});
```

### Generic Handlers

#### `probeHandlers`
Framework-agnostic handlers that return check results.

```typescript
// Express example
app.get('/health', async (req, res) => {
    const result = await probeHandlers.readiness();
    res.status(result.statusCode).send(result.message);
});

// Fastify example
fastify.get('/health', async (request, reply) => {
    const result = await probeHandlers.readiness();
    reply.code(result.statusCode).send(result.message);
});

// Available handlers:
probeHandlers.readiness() // Returns ProbeCheckResult
probeHandlers.liveness()  // Returns ProbeCheckResult
probeHandlers.health()     // Returns combined health status
```

### Core Functions

#### `addHttpServer(server)`
Registers an HTTP/HTTPS server for lifecycle management.

```typescript
K8sLifecycle.addHttpServer(server);
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