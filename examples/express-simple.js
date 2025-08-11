/**
 * Simple Express example using k8s-lifecycle's generic probe handlers
 * Shows how to use the framework-agnostic handlers with Express
 */

const express = require('express');
const http = require('http');
const { 
    addHttpServer,
    onShutdown,
    onReadyCheck,
    probeHandlers,
    isReady,
    isHealthy
} = require('k8s-lifecycle');

const app = express();
const port = process.env.PORT || 3003;

// Simulate database connection state
let isDatabaseConnected = false;

// Method 1: Using the simple boolean checks
app.get('/health/ready', async (_req, res) => {
    const ready = await isReady();
    res.status(ready ? 200 : 503).json({ 
        status: ready ? 'ready' : 'not ready' 
    });
});

app.get('/health/live', (_req, res) => {
    const healthy = isHealthy();
    res.status(healthy ? 200 : 503).json({ 
        status: healthy ? 'healthy' : 'unhealthy' 
    });
});

// Method 2: Using the generic handlers
app.get('/health/ready-detailed', async (_req, res) => {
    const result = await probeHandlers.readiness();
    res.status(result.statusCode).send(result.message);
});

app.get('/health/live-detailed', async (_req, res) => {
    const result = probeHandlers.liveness();
    res.status(result.statusCode).send(result.message);
});

// Method 3: Combined health endpoint
app.get('/health', async (_req, res) => {
    const health = await probeHandlers.health();
    const statusCode = health.status === 'ok' ? 200 : 503;
    res.status(statusCode).json(health);
});

// Add custom readiness checks
onReadyCheck(async () => {
    return isDatabaseConnected;
});

// Register shutdown handler
onShutdown(async () => {
    console.log('Shutting down Express server...');
    server.close();
});

// Create and start server
const server = http.createServer(app);

server.listen(port, async () => {
    // Register server with k8s-lifecycle
    addHttpServer(server);
    
    console.log(`Express server listening on port ${port}`);
    console.log('Health endpoints:');
    console.log(`  Simple checks:`);
    console.log(`    - http://localhost:${port}/health/ready`);
    console.log(`    - http://localhost:${port}/health/live`);
    console.log(`  Detailed checks:`);
    console.log(`    - http://localhost:${port}/health/ready-detailed`);
    console.log(`    - http://localhost:${port}/health/live-detailed`);
    console.log(`  Combined:`);
    console.log(`    - http://localhost:${port}/health`);
    
    // Simulate database connection after 2 seconds
    setTimeout(() => {
        isDatabaseConnected = true;
        console.log('Database connected - service is now ready');
    }, 2000);
});