import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { 
  addHttpServer, 
  probeHandlers, 
  onShutdown, 
  onStateChange, 
  Phase 
} from '../src';

const fastify: FastifyInstance = Fastify({ logger: true });

// Add the server to lifecycle management
addHttpServer(fastify.server);

// Register health check routes
fastify.get('/api/probe/ready', async (_request: FastifyRequest, reply: FastifyReply) => {
  const result = await probeHandlers.readiness();
  return reply.code(result.statusCode).send({ message: result.message });
});

fastify.get('/api/probe/live', async (_request: FastifyRequest, reply: FastifyReply) => {
  const result = probeHandlers.liveness();
  return reply.code(result.statusCode).send({ message: result.message });
});

fastify.get('/api/probe/test', async (_request: FastifyRequest, reply: FastifyReply) => {
  return reply.code(200).send({ status: 'ok' });
});

// Main application route
fastify.get('/', async () => {
  return { hello: 'world' };
});

// Register lifecycle callbacks
onStateChange((phase: Phase) => {
  console.log(`State changed to: ${Phase[phase]}`);
});

onShutdown(async () => {
  console.log('Cleaning up resources...');
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