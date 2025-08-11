/**
 * Simple Fastify example using k8s-lifecycle's probe check functions
 * This shows the easiest way to integrate with Fastify's native routing
 */

const fastify = require('fastify')({ logger: true });
const { 
    addHttpServer,
    onShutdown,
    onReadyCheck,
    isReady,
    isHealthy
} = require('k8s-lifecycle');

const port = process.env.PORT || 3002;

// Simulate database connection state
let isDatabaseConnected = false;

// Simple native Fastify routes using the boolean check functions
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

// Or use with Fastify's built-in health check pattern
fastify.get('/health', async () => {
    const ready = await isReady();
    const healthy = isHealthy();
    
    return {
        status: ready && healthy ? 'ok' : 'degraded',
        checks: {
            ready,
            healthy,
            database: isDatabaseConnected
        }
    };
});

// Add custom readiness checks
onReadyCheck(async () => {
    return isDatabaseConnected;
});

// Register shutdown handler
onShutdown(async () => {
    console.log('Shutting down...');
    await fastify.close();
});

// Start the server
const start = async () => {
    try {
        // Simulate database connection
        setTimeout(() => {
            isDatabaseConnected = true;
            console.log('Database connected');
        }, 2000);
        
        await fastify.listen({ port, host: '0.0.0.0' });
        
        // Register the server with k8s-lifecycle
        addHttpServer(fastify.server);
        
        console.log(`Server listening on port ${port}`);
        console.log('Health endpoints:');
        console.log(`  - http://localhost:${port}/health/ready`);
        console.log(`  - http://localhost:${port}/health/live`);
        console.log(`  - http://localhost:${port}/health`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();