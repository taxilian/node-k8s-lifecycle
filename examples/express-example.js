const express = require('express');
const http = require('http');
const { 
    getProbeRouter,
    addHttpServer,
    onShutdown,
    onReadyCheck,
    setUnrecoverableError
} = require('k8s-lifecycle');

const app = express();
const port = process.env.PORT || 3000;

// Simulate database connection state
let isDatabaseConnected = false;
let isRedisConnected = false;

// Add the probe endpoints to your Express app
const probeRouter = getProbeRouter({
    test: '/health/test',   // Optional test endpoint
    ready: '/health/ready',  // Readiness probe endpoint
    live: '/health/live',    // Liveness probe endpoint
});

app.use(probeRouter);

// Add custom readiness checks
onReadyCheck(async () => {
    // Return true only if all dependencies are ready
    return isDatabaseConnected && isRedisConnected;
});

// Add your application routes
app.get('/', (_req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString()
    });
});

app.get('/error', (_req, res) => {
    // Simulate an unrecoverable error
    const error = new Error('Simulated unrecoverable error');
    setUnrecoverableError(error);
    res.status(500).json({ error: 'Unrecoverable error triggered' });
});

// Create server and register with k8s-lifecycle
const server = http.createServer(app);
addHttpServer(server);

// Add cleanup handlers for graceful shutdown
onShutdown(async () => {
    console.log('Starting graceful shutdown...');
    
    // Close database connections
    if (isDatabaseConnected) {
        console.log('Closing database connection...');
        isDatabaseConnected = false;
    }
    
    // Close Redis connection
    if (isRedisConnected) {
        console.log('Closing Redis connection...');
        isRedisConnected = false;
    }
    
    console.log('Cleanup complete');
});

// Simulate async startup
async function connectToDependencies() {
    console.log('Connecting to database...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    isDatabaseConnected = true;
    console.log('Database connected');
    
    console.log('Connecting to Redis...');
    await new Promise(resolve => setTimeout(resolve, 500));
    isRedisConnected = true;
    console.log('Redis connected');
}

// Start the server
server.listen(port, async () => {
    console.log(`Express server listening on port ${port}`);
    console.log(`Health endpoints available at:`);
    console.log(`  - http://localhost:${port}/health/test`);
    console.log(`  - http://localhost:${port}/health/ready`);
    console.log(`  - http://localhost:${port}/health/live`);
    
    // Connect to dependencies after server starts
    await connectToDependencies();
    console.log('Server is fully ready to accept traffic');
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    setUnrecoverableError(error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    if (reason instanceof Error) {
        setUnrecoverableError(reason);
    }
});