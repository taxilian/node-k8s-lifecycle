import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { 
  addHttpServer, 
  isReady, 
  isHealthy, 
  onShutdown 
} from '../src';

const fastify: FastifyInstance = Fastify({ logger: true });

// Add the server to lifecycle management
addHttpServer(fastify.server);

// Simple health check routes using boolean checks
fastify.get('/health/ready', async (_request: FastifyRequest, reply: FastifyReply) => {
  const ready = await isReady();
  return reply.code(ready ? 200 : 503).send({ ready });
});

fastify.get('/health/live', async (_request: FastifyRequest, reply: FastifyReply) => {
  const healthy = isHealthy();
  return reply.code(healthy ? 200 : 503).send({ healthy });
});

// Main application route
fastify.get('/', async () => {
  return { hello: 'world' };
});

// Register shutdown cleanup
onShutdown(async () => {
  console.log('Shutting down Fastify server...');
  await fastify.close();
});

// Start the server
const start = async (): Promise<void> => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
    console.log('Server is ready');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();