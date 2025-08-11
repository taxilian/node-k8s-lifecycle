# k8s-lifecycle API Reference

## Simple Check Functions

These functions provide simple boolean or detailed results for health checks, compatible with any framework.

### `isReady(): Promise<boolean>`
Returns `true` if the service is ready to accept traffic.

```javascript
const ready = await isReady();
if (!ready) {
  // Service not ready
}
```

### `isHealthy(): boolean`
Returns `true` if the service is healthy (no unrecoverable errors).

```javascript
const healthy = isHealthy();
if (!healthy) {
  // Service unhealthy
}
```

### `checkReadiness(): Promise<ProbeCheckResult>`
Returns detailed readiness status with HTTP status code.

```javascript
const result = await checkReadiness();
// { healthy: true, message: 'ready', statusCode: 200 }
// { healthy: false, message: 'Server not ready', statusCode: 503 }
```

### `checkLiveness(): ProbeCheckResult`
Returns detailed liveness status with HTTP status code.

```javascript
const result = checkLiveness();
// { healthy: true, message: 'alive', statusCode: 200 }
// { healthy: false, message: 'Unrecoverable error: ...', statusCode: 503 }
```

## Generic Handlers

### `probeHandlers`
Framework-agnostic handlers that return check results.

```javascript
// Get readiness result
const readiness = await probeHandlers.readiness();

// Get liveness result  
const liveness = probeHandlers.liveness();

// Get combined health status
const health = await probeHandlers.health();
// { ready: true, healthy: true, status: 'ok' }
// { ready: false, healthy: true, status: 'degraded' }
```

## Express Integration

### `getProbeRouter(urls?, RouterFactory?)`
Creates an Express-compatible router with health endpoints.

```javascript
const probeRouter = getProbeRouter({
  test: '/health/test',   // Optional
  ready: '/health/ready',
  live: '/health/live'
});
app.use(probeRouter);
```

## Lifecycle Management

### `addHttpServer(server)`
Registers an HTTP/HTTPS server for connection tracking during shutdown.

```javascript
const server = http.createServer(app);
addHttpServer(server);
```

### `onReadyCheck(fn)`
Adds a custom readiness check. Must return `true` when ready.

```javascript
onReadyCheck(async () => {
  return databaseConnected && cacheReady;
});
```

### `onShutdown(fn)`
Adds a cleanup handler called during graceful shutdown.

```javascript
onShutdown(async () => {
  await database.close();
  await cache.disconnect();
});
```

### `addShutdownReadyCheck(fn)`
Adds a check to determine if shutdown can complete.

```javascript
addShutdownReadyCheck(async () => {
  return activeJobs.length === 0;
});
```

### `onStateChange(fn)`
Monitors lifecycle state transitions.

```javascript
onStateChange((newState, oldState) => {
  console.log(`State: ${oldState} → ${newState}`);
});
```

### `setUnrecoverableError(error)`
Marks the service as unhealthy (liveness checks will fail).

```javascript
try {
  await criticalOperation();
} catch (error) {
  setUnrecoverableError(error);
}
```

### `startShutdown()`
Manually triggers graceful shutdown.

```javascript
startShutdown();
```

## Types

### `ProbeCheckResult`
```typescript
interface ProbeCheckResult {
  healthy: boolean;
  message: string;
  statusCode: number;
}
```

### `Phase` enum
```typescript
enum Phase {
  Startup = 'starting',
  Running = 'run',
  Phase1 = 'shutdownReq',
  Phase2 = 'shuttingDown',
  Phase3 = 'final'
}
```

## Framework Examples

### Express
```javascript
const express = require('express');
const { isReady, isHealthy } = require('k8s-lifecycle');

app.get('/health', async (req, res) => {
  const ready = await isReady();
  const healthy = isHealthy();
  
  res.status(ready && healthy ? 200 : 503).json({
    ready,
    healthy,
    status: ready && healthy ? 'ok' : 'degraded'
  });
});
```

### Fastify
```javascript
const fastify = require('fastify')();
const { checkReadiness, checkLiveness } = require('k8s-lifecycle');

fastify.get('/health/ready', async () => {
  const result = await checkReadiness();
  if (!result.healthy) {
    throw { statusCode: result.statusCode, message: result.message };
  }
  return { status: 'ready' };
});
```

### Koa
```javascript
const Koa = require('koa');
const { probeHandlers } = require('k8s-lifecycle');

router.get('/health', async (ctx) => {
  const health = await probeHandlers.health();
  ctx.status = health.status === 'ok' ? 200 : 503;
  ctx.body = health;
});
```

### Hapi
```javascript
const Hapi = require('@hapi/hapi');
const { isReady, isHealthy } = require('k8s-lifecycle');

server.route({
  method: 'GET',
  path: '/health',
  handler: async (request, h) => {
    const ready = await isReady();
    const healthy = isHealthy();
    
    return h.response({
      ready,
      healthy,
      status: ready && healthy ? 'ok' : 'degraded'
    }).code(ready && healthy ? 200 : 503);
  }
});
```