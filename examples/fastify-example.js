const fastify = require('fastify')({ logger: true });
const { 
    addHttpServer,
    onShutdown,
    onReadyCheck,
    setUnrecoverableError,
    checkReadiness,
    checkLiveness
} = require('k8s-lifecycle');

const port = process.env.PORT || 3001;

// Simulate database connection state
let isDatabaseConnected = false;
let isCacheConnected = false;

// Register health check routes using the check functions
fastify.get('/health/ready', async (_request, reply) => {
    const result = await checkReadiness();
    reply.code(result.statusCode).send(result.message);
});

fastify.get('/health/live', async (_request, reply) => {
    const result = checkLiveness();
    reply.code(result.statusCode).send(result.message);
});

// Add custom readiness checks
onReadyCheck(async () => {
    // Return true only if all dependencies are ready
    return isDatabaseConnected && isCacheConnected;
});

// Add your application routes
fastify.get('/', async () => {
    return { 
        status: 'ok',
        timestamp: new Date().toISOString(),
        server: 'fastify'
    };
});

fastify.get('/error', async (_request, reply) => {
    // Simulate an unrecoverable error
    const error = new Error('Simulated unrecoverable error');
    setUnrecoverableError(error);
    reply.code(500).send({ error: 'Unrecoverable error triggered' });
});

// Add a long-running endpoint to test graceful shutdown
fastify.get('/slow', async (request, _reply) => {
    const delay = parseInt(request.query.delay) || 5000;
    await new Promise(resolve => setTimeout(resolve, delay));
    return { message: `Completed after ${delay}ms` };
});

// Register shutdown handler
onShutdown(async () => {
    console.log('Starting graceful shutdown...');
    
    // Close database connections
    if (isDatabaseConnected) {
        console.log('Closing database connection...');
        isDatabaseConnected = false;
    }
    
    // Close cache connection
    if (isCacheConnected) {
        console.log('Closing cache connection...');
        isCacheConnected = false;
    }
    
    // Close Fastify
    await fastify.close();
    
    console.log('Cleanup complete');
});

// Simulate async startup
async function connectToDependencies() {
    console.log('Connecting to database...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    isDatabaseConnected = true;
    console.log('Database connected');
    
    console.log('Connecting to cache...');
    await new Promise(resolve => setTimeout(resolve, 500));
    isCacheConnected = true;
    console.log('Cache connected');
}

// Start the server
const start = async () => {
    try {
        await fastify.listen({ port, host: '0.0.0.0' });
        
        // Register the server with k8s-lifecycle for connection tracking
        addHttpServer(fastify.server);
        
        console.log(`Fastify server listening on port ${port}`);
        console.log(`Health endpoints available at:`);
        console.log(`  - http://localhost:${port}/health/ready`);
        console.log(`  - http://localhost:${port}/health/live`);
        
        // Connect to dependencies after server starts
        await connectToDependencies();
        console.log('Server is fully ready to accept traffic');
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

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

start();