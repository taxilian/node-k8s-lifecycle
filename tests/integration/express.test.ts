import express from 'express';
import http from 'http';
import request from 'supertest';

describe('Express Integration', () => {
    let app: express.Application;
    let server: http.Server;
    let K8sLifecycle: any;

    beforeEach(() => {
        // Clear module cache to get fresh instance
        jest.resetModules();
        K8sLifecycle = require('../../src');
        
        app = express();
        server = http.createServer(app);
    });

    afterEach((done) => {
        if (server.listening) {
            server.close(done);
        } else {
            done();
        }
    });

    describe('getProbeRouter', () => {
        it('should create probe endpoints with default URLs', async () => {
            const probeRouter = K8sLifecycle.getProbeRouter();
            app.use(probeRouter);

            const testResponse = await request(app).get('/api/probe/test?t=100');
            expect(testResponse.status).toBe(200);
            expect(testResponse.text).toContain('Waiting for 100');
            expect(testResponse.text).toContain('Done');

            const readyResponse = await request(app).get('/api/probe/ready');
            expect(readyResponse.status).toBe(503); // Not ready until server is added

            const liveResponse = await request(app).get('/api/probe/live');
            expect(liveResponse.status).toBe(200);
            expect(liveResponse.text).toBe('alive');
        });

        it('should create probe endpoints with custom URLs', async () => {
            const probeRouter = K8sLifecycle.getProbeRouter({
                test: '/health/test',
                ready: '/health/ready',
                live: '/health/live'
            });
            app.use(probeRouter);

            const readyResponse = await request(app).get('/health/ready');
            expect(readyResponse.status).toBe(503);

            const liveResponse = await request(app).get('/health/live');
            expect(liveResponse.status).toBe(200);
        });

        it('should work with custom router constructor', async () => {
            const probeRouter = K8sLifecycle.getProbeRouter({}, express.Router);
            app.use(probeRouter);

            const liveResponse = await request(app).get('/api/probe/live');
            expect(liveResponse.status).toBe(200);
        });
    });

    describe('Server tracking', () => {
        it('should track server and report ready when listening', async () => {
            const probeRouter = K8sLifecycle.getProbeRouter();
            app.use(probeRouter);

            // Start server
            await new Promise<void>((resolve) => {
                server.listen(0, () => resolve());
            });

            // Add server to lifecycle
            K8sLifecycle.addHttpServer(server);

            // Wait a bit for server to be registered
            await new Promise(resolve => setTimeout(resolve, 100));

            const readyResponse = await request(app).get('/api/probe/ready');
            expect(readyResponse.status).toBe(200);
            expect(readyResponse.text).toBe('ready');
        });
    });

    describe('Custom readiness checks', () => {
        it('should fail readiness when custom check returns false', async () => {
            const probeRouter = K8sLifecycle.getProbeRouter();
            app.use(probeRouter);

            let isReady = false;
            K8sLifecycle.onReadyCheck(async () => isReady);

            await new Promise<void>((resolve) => {
                server.listen(0, () => resolve());
            });
            K8sLifecycle.addHttpServer(server);

            // Should fail when custom check returns false
            let readyResponse = await request(app).get('/api/probe/ready');
            expect(readyResponse.status).toBe(503);
            expect(readyResponse.text).toBe('Ready check(s) failed');

            // Should succeed when custom check returns true
            isReady = true;
            readyResponse = await request(app).get('/api/probe/ready');
            expect(readyResponse.status).toBe(200);
        });
    });

    describe('Unrecoverable errors', () => {
        it('should fail liveness check when unrecoverable error is set', async () => {
            // Set NODE_ENV to production to avoid process.exit in test
            const originalEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'production';
            
            // Reload the module with new environment
            jest.resetModules();
            const K8s = require('../../src');
            
            const probeRouter = K8s.getProbeRouter();
            app.use(probeRouter);

            // Initially should be alive
            let liveResponse = await request(app).get('/api/probe/live');
            expect(liveResponse.status).toBe(200);

            // Set unrecoverable error
            K8s.setUnrecoverableError(new Error('Test error'));

            // Should now fail
            liveResponse = await request(app).get('/api/probe/live');
            expect(liveResponse.status).toBe(503);
            expect(liveResponse.text).toContain('Unrecoverable error: Test error');
            
            // Restore original env
            process.env.NODE_ENV = originalEnv;
        });
    });
});