// Mock Fastify types
interface FastifyInstance {
    server: any;
    get: (path: string, handler: any) => void;
    register: (plugin: any, opts?: any) => void;
    listen: (opts: any) => Promise<void>;
    close: () => Promise<void>;
}

describe('Fastify Integration', () => {
    let fastify: FastifyInstance;
    let routes: Array<{ path: string; handler: any }> = [];
    let K8sLifecycle: any;

    beforeEach(() => {
        // Clear module cache to get fresh instance
        jest.resetModules();
        K8sLifecycle = require('../../src');
        
        routes = [];
        
        // Create a mock Fastify instance
        fastify = {
            server: {
                listening: false,
                close: (cb: () => void) => cb()
            },
            get: (path: string, handler: any) => {
                routes.push({ path, handler });
            },
            register: async (plugin: any, opts?: any) => {
                // Call the plugin function synchronously
                return new Promise<void>((resolve) => {
                    plugin(fastify, opts || {}, () => {
                        // Give time for async route registration
                        setTimeout(resolve, 50);
                    });
                });
            },
            listen: async () => {
                fastify.server.listening = true;
            },
            close: async () => {
                fastify.server.listening = false;
            }
        };
    });

    describe('Simple check functions', () => {
        it('should provide isReady function', async () => {
            const ready = await K8sLifecycle.isReady();
            expect(typeof ready).toBe('boolean');
        });

        it('should provide isHealthy function', () => {
            const healthy = K8sLifecycle.isHealthy();
            expect(typeof healthy).toBe('boolean');
        });

        it('should provide checkReadiness function', async () => {
            const result = await K8sLifecycle.checkReadiness();
            expect(result).toHaveProperty('healthy');
            expect(result).toHaveProperty('message');
            expect(result).toHaveProperty('statusCode');
        });

        it('should provide checkLiveness function', () => {
            const result = K8sLifecycle.checkLiveness();
            expect(result).toHaveProperty('healthy');
            expect(result).toHaveProperty('message');
            expect(result).toHaveProperty('statusCode');
        });
    });

    describe('Generic probe handlers', () => {
        it('should provide readiness handler', async () => {
            const result = await K8sLifecycle.probeHandlers.readiness();
            expect(result).toHaveProperty('healthy');
            expect(result).toHaveProperty('message');
            expect(result).toHaveProperty('statusCode');
        });

        it('should provide liveness handler', () => {
            const result = K8sLifecycle.probeHandlers.liveness();
            expect(result).toHaveProperty('healthy');
            expect(result).toHaveProperty('message');
            expect(result).toHaveProperty('statusCode');
        });

        it('should provide health handler', async () => {
            const result = await K8sLifecycle.probeHandlers.health();
            expect(result).toHaveProperty('ready');
            expect(result).toHaveProperty('healthy');
            expect(result).toHaveProperty('status');
            expect(result.status).toMatch(/^(ok|degraded)$/);
        });
    });
});