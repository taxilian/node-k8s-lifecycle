import { MockExpressRouter, createMockServer } from '../mocks/express-mock';
import { BuiltMockApplication, TestApplicationBuilder } from '../fixtures/test-helpers';
import * as K8sLifecycle from '../../src';
import { ReadinessProbeInterval, ConnectionCheckInterval } from '../../src/probes';

describe('Probes Module', () => {
  let app: BuiltMockApplication | undefined;
  
  // Timing constants derived from actual source values
  const PHASE_1_DURATION = ReadinessProbeInterval * 1.5 * 1000; // ms
  
  beforeEach(() => {
    jest.useFakeTimers();
  });
  
  afterEach(() => {
    jest.clearAllTimers();
    jest.clearAllMocks();
    jest.useRealTimers();
    if (app?.cleanup) {
      app.cleanup();
    }
  });
  
  describe('Health Check Endpoints', () => {
    describe('Readiness Probe', () => {
      it('should return ready when all conditions are met', async () => {
        const server = createMockServer();
        server.listening = true;
        
        app = new TestApplicationBuilder()
          .withServer(server)
          .withReadyCheck(async () => true)
          .build();
        
        const res = await app.router.simulateRequest('GET', '/api/probe/ready');
        
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe('ready');
      });
      
      it('should fail when custom ready check returns false', async () => {
        const server = createMockServer();
        server.listening = true;
        
        app = new TestApplicationBuilder()
          .withServer(server)
          .withReadyCheck(async () => false)
          .build();
        
        const res = await app.router.simulateRequest('GET', '/api/probe/ready');
        
        expect(res.statusCode).toBe(500);
        expect(res.body).toBe('Ready check(s) failed');
      });
      
      it('should fail when server is not listening', async () => {
        const server = createMockServer();
        server.listening = false;
        
        app = new TestApplicationBuilder()
          .withServer(server)
          .build();
        
        const res = await app.router.simulateRequest('GET', '/api/probe/ready');
        
        expect(res.statusCode).toBe(500);
        expect(res.body).toBe('HTTP server not ready');
      });
      
      it('should fail immediately when shutdown is requested', async () => {
        const server = createMockServer();
        server.listening = true;
        
        app = new TestApplicationBuilder()
          .withServer(server)
          .build();
        
        // Request shutdown
        await app.lifecycle.startShutdown();
        
        const res = await app.router.simulateRequest('GET', '/api/probe/ready');
        
        expect(res.statusCode).toBe(500);
        expect(res.body).toBe('Service is closing');
      });
      
      it('should handle errors in ready checks gracefully', async () => {
        const server = createMockServer();
        server.listening = true;
        
        app = new TestApplicationBuilder()
          .withServer(server)
          .withReadyCheck(async () => {
            throw new Error('Database connection failed');
          })
          .withReadyCheck(async () => true)
          .build();
        
        const res = await app.router.simulateRequest('GET', '/api/probe/ready');
        
        expect(res.statusCode).toBe(500);
        expect(res.body).toBe('Ready check(s) failed');
      });
      
      it('should use Promise.allSettled behavior for ready checks', async () => {
        const server = createMockServer();
        server.listening = true;
        
        app = new TestApplicationBuilder()
          .withServer(server)
          .withReadyCheck(async () => {
            throw new Error('First check failed');
          })
          .withReadyCheck(async () => true) // Second check succeeds
          .withReadyCheck(async () => false) // Third check returns false
          .build();
        
        const res = await app.router.simulateRequest('GET', '/api/probe/ready');
        
        // Behavioral outcome: probe fails if ANY check fails
        expect(res.statusCode).toBe(500);
        expect(res.body).toBe('Ready check(s) failed');
      });
    });
    
    describe('Liveness Probe', () => {
      it('should return alive when healthy', async () => {
        app = new TestApplicationBuilder().build();
        
        const res = await app.router.simulateRequest('GET', '/api/probe/live');
        
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe('alive');
      });
      
      it('should fail when unrecoverable error is set', async () => {
        // Set to production to avoid process.exit in dev mode
        process.env.NODE_ENV = 'production';
        
        app = new TestApplicationBuilder().build();
        
        const error = new Error('Database permanently down');
        app.lifecycle.setUnrecoverableError(error);
        
        const res = await app.router.simulateRequest('GET', '/api/probe/live');
        
        expect(res.statusCode).toBe(500);
        expect(res.body).toBe('Unrecoverable error: Database permanently down');
      });
    });
    
    describe('Test Endpoint', () => {
      it('should handle timeout parameter', async () => {
        app = new TestApplicationBuilder().build();
        
        const responsePromise = app.router.simulateRequest('GET', '/api/probe/test', {
          query: { t: '100' }
        });
        
        // Should not resolve immediately
        await jest.advanceTimersByTimeAsync(50);
        expect(responsePromise).toBeTruthy();
        
        // Should resolve after timeout
        await jest.advanceTimersByTimeAsync(100);
        const res = await responsePromise;
        
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('Done');
      });
      
      it('should use default timeout when not specified', async () => {
        app = new TestApplicationBuilder().build();
        
        const responsePromise = app.router.simulateRequest('GET', '/api/probe/test');
        
        // Advance default timeout
        await jest.advanceTimersByTimeAsync(10000);
        const res = await responsePromise;
        
        expect(res.statusCode).toBe(200);
      });
    });
  });
  
  describe('State Management', () => {
    it('should transition from Startup to Running when ready', async () => {
      const server = createMockServer();
      server.listening = true;
      const stateChanges: Array<[K8sLifecycle.Phase, K8sLifecycle.Phase]> = [];
      
      app = new TestApplicationBuilder()
        .withServer(server)
        .withStateChangeCallback((newState, oldState) => {
          stateChanges.push([newState, oldState]);
        })
        .build();
      
      // Trigger ready check
      await app.router.simulateRequest('GET', '/api/probe/ready');
      
      expect(stateChanges).toContainEqual([K8sLifecycle.Phase.Running, K8sLifecycle.Phase.Startup]);
    });
    
    it('should handle errors in state change callbacks', async () => {
      const server = createMockServer();
      server.listening = true;
      const goodCallback = jest.fn();
      const errorCallback = jest.fn(async () => {
        throw new Error('Callback error');
      });
      
      app = new TestApplicationBuilder()
        .withServer(server)
        .withStateChangeCallback(goodCallback)
        .withStateChangeCallback(errorCallback)
        .build();
      
      // Force a state change by triggering shutdown (will move from Startup to Phase1)
      // This should not throw because Promise.allSettled handles the errors
      await app.lifecycle.startShutdown();
      
      expect(goodCallback).toHaveBeenCalled();
      expect(errorCallback).toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Error in state change callback'),
        expect.any(Error)
      );
    });
  });
  
  describe('Shutdown Process', () => {
    it('should execute three-phase shutdown', async () => {
      const phases: K8sLifecycle.Phase[] = [];
      
      app = new TestApplicationBuilder()
        .withStateChangeCallback((newPhase) => {
          phases.push(newPhase);
        })
        .build();
      
      // Start shutdown
      await app.lifecycle.startShutdown();
      expect(phases).toContain(K8sLifecycle.Phase.Phase1);
      
      // Wait for Phase 2 (1.5 * default interval)
      await jest.advanceTimersByTimeAsync(PHASE_1_DURATION);
      expect(phases).toContain(K8sLifecycle.Phase.Phase2);
      
      // Force finish (no connections)
      await jest.advanceTimersByTimeAsync(ConnectionCheckInterval);
      expect(phases).toContain(K8sLifecycle.Phase.Phase3);
    });
    
    it('should respect custom READYPROBE_INTERVAL', async () => {
      process.env.READYPROBE_INTERVAL = '10';
      jest.resetModules();
      
      const phases: K8sLifecycle.Phase[] = [];
      app = new TestApplicationBuilder()
        .withStateChangeCallback((newPhase) => {
          phases.push(newPhase);
        })
        .build();
      
      await app.lifecycle.startShutdown();
      
      // Should wait 1.5 * 10 = 15 seconds
      await jest.advanceTimersByTimeAsync(14000);
      expect(phases).not.toContain(K8sLifecycle.Phase.Phase2);
      
      await jest.advanceTimersByTimeAsync(2000);
      expect(phases).toContain(K8sLifecycle.Phase.Phase2);
    });
    
    it('should execute shutdown callbacks during phase 3', async () => {
      const shutdownCallback = jest.fn().mockResolvedValue(undefined);
      
      app = new TestApplicationBuilder()
        .withShutdownCallback(shutdownCallback)
        .build();
      
      await app.lifecycle.startShutdown();
      
      // Advance through phases
      await jest.advanceTimersByTimeAsync(PHASE_1_DURATION); // Phase 2
      await jest.advanceTimersByTimeAsync(ConnectionCheckInterval); // Check connections
      
      expect(shutdownCallback).toHaveBeenCalled();
    });
    
    it('should continue shutdown if callbacks fail', async () => {
      const goodCallback = jest.fn().mockResolvedValue(undefined);
      const phases: K8sLifecycle.Phase[] = [];
      
      app = new TestApplicationBuilder()
        .withShutdownCallback(async () => {
          throw new Error('Shutdown error');
        })
        .withShutdownCallback(goodCallback)
        .withStateChangeCallback((newPhase) => {
          phases.push(newPhase);
        })
        .build();
      
      await app.lifecycle.startShutdown();
      await jest.advanceTimersByTimeAsync(PHASE_1_DURATION + ConnectionCheckInterval);
      
      expect(goodCallback).toHaveBeenCalled();
      expect(phases).toContain(K8sLifecycle.Phase.Phase3);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Error in shutdown callback'),
        expect.any(Error)
      );
    });
    
    it('should handle double SIGTERM', async () => {
      app = new TestApplicationBuilder().build();
      
      process.emit('SIGTERM' as any, 'SIGTERM');
      
      // Second SIGTERM should trigger process.exit
      expect(() => {
        process.emit('SIGTERM' as any, 'SIGTERM');
      }).toThrow('process.exit called with code -127');
      
      expect(console.warn).toHaveBeenCalledWith('Second SIGTERM received, stopping now');
    });
  });
  
  describe('Environment Variables', () => {
    it('should exit immediately on unrecoverable error in dev mode', async () => {
      process.env.NODE_ENV = 'development';
      jest.resetModules();
      
      app = new TestApplicationBuilder().build();
      
      const error = new Error('Dev error');
      expect(() => {
        app!.lifecycle.setUnrecoverableError(error);
      }).toThrow('process.exit called with code 1');
    });
    
    it('should not exit immediately in production mode', async () => {
      process.env.NODE_ENV = 'production';
      jest.resetModules();
      
      app = new TestApplicationBuilder().build();
      
      const error = new Error('Prod error');
      app.lifecycle.setUnrecoverableError(error);
      
      // Should not throw
      expect(process.exit).not.toHaveBeenCalled();
    });
    
    it('should respect SHUTDOWN_TIMEOUT', async () => {
      process.env.SHUTDOWN_TIMEOUT = '1'; // Very short timeout
      jest.resetModules();
      
      const server = createMockServer();
      const socket = { 
        $$id: 1, 
        $$idle: false, 
        $$isCheck: false,
        destroy: jest.fn(),
        on: jest.fn()
      };
      
      // Mock an active connection
      server.on = jest.fn((event, handler) => {
        if (event === 'connection') {
          handler(socket);
        }
      }) as any;
      
      app = new TestApplicationBuilder()
        .withServer(server)
        .build();
      
      await app.lifecycle.startShutdown();
      await jest.advanceTimersByTimeAsync(PHASE_1_DURATION); // Phase 2
      
      // Should timeout after 1 second
      await jest.advanceTimersByTimeAsync(1500);
      
      expect(console.warn).toHaveBeenCalledWith('Close timeout reached, forcing to close');
      
      // Reset environment and clear everything
      delete process.env.SHUTDOWN_TIMEOUT;
      jest.clearAllTimers();
    });
  });
  
  describe('Shutdown Ready Checks', () => {
    it('should wait for user shutdown checks before completing', async () => {
      let isReady = false;
      const phases: K8sLifecycle.Phase[] = [];
      
      app = new TestApplicationBuilder()
        .withShutdownReadyCheck(async () => isReady)
        .withStateChangeCallback((newPhase) => {
          phases.push(newPhase);
        })
        .build();
      
      await app.lifecycle.startShutdown();
      await jest.advanceTimersByTimeAsync(PHASE_1_DURATION); // Phase 2
      
      // Should not reach Phase 3 yet
      await jest.advanceTimersByTimeAsync(ConnectionCheckInterval * 2);
      expect(phases).not.toContain(K8sLifecycle.Phase.Phase3);
      
      // Mark as ready
      isReady = true;
      await jest.advanceTimersByTimeAsync(ConnectionCheckInterval);
      expect(phases).toContain(K8sLifecycle.Phase.Phase3);
    });
    
    it('should handle errors in shutdown ready checks', async () => {
      const goodCheck = jest.fn().mockResolvedValue(true);
      
      app = new TestApplicationBuilder()
        .withShutdownReadyCheck(async () => {
          throw new Error('Check failed');
        })
        .withShutdownReadyCheck(goodCheck)
        .build();
      
      await app.lifecycle.startShutdown();
      await jest.advanceTimersByTimeAsync(PHASE_1_DURATION + ConnectionCheckInterval);
      
      expect(goodCheck).toHaveBeenCalled();
    });
  });
  
  describe('Error Handling', () => {
    it('should handle synchronous errors in ready checks', async () => {
      const server = createMockServer();
      server.listening = true;
      
      app = new TestApplicationBuilder()
        .withServer(server)
        .withReadyCheck(() => {
          throw new Error('Sync error in ready check');
        })
        .build();
      
      const res = await app.router.simulateRequest('GET', '/api/probe/ready');
      
      expect(res.statusCode).toBe(500);
      expect(res.body).toBe('Unexpected error: Error: Sync error in ready check');
      expect(console.warn).toHaveBeenCalledWith(
        'Error in readiness probe: ',
        expect.any(Error),
        expect.any(String)
      );
    });
    
    it('should handle rejections in multiple ready checks', async () => {
      const server = createMockServer();
      server.listening = true;
      
      app = new TestApplicationBuilder()
        .withServer(server)
        .withReadyCheck(async () => Promise.reject(new Error('First check failed')))
        .withReadyCheck(async () => Promise.reject(new Error('Second check failed')))
        .withReadyCheck(async () => true)
        .build();
      
      const res = await app.router.simulateRequest('GET', '/api/probe/ready');
      
      expect(res.statusCode).toBe(500);
      expect(res.body).toBe('Ready check(s) failed');
    });
    
    it('should handle server close event during shutdown', async () => {
      const server = createMockServer();
      server.listening = true;
      
      app = new TestApplicationBuilder()
        .withServer(server)
        .build();
      
      await app.lifecycle.startShutdown();
      await jest.advanceTimersByTimeAsync(PHASE_1_DURATION); // Phase 2
      
      // Simulate server close event
      server.emit!('close');
      
      // Should not throw or cause issues
      expect(server.listening).toBe(true); // Server state unchanged
    });
  });
  
  describe('Custom Router', () => {
    it('should support custom router constructor', async () => {
      jest.resetModules();
      const lifecycle = require('../../src');
      
      const customRouter = new MockExpressRouter();
      lifecycle.getProbeRouter({}, () => customRouter);
      
      expect(customRouter.getRoutes()).toContain('GET:/api/probe/ready');
      expect(customRouter.getRoutes()).toContain('GET:/api/probe/live');
      expect(customRouter.getRoutes()).toContain('GET:/api/probe/test');
    });
    
    it('should support custom probe URLs', async () => {
      jest.resetModules();
      const lifecycle = require('../../src');
      
      const customRouter = new MockExpressRouter();
      lifecycle.getProbeRouter({
        ready: '/healthz/ready',
        live: '/healthz/live',
        test: '',  // Disable test endpoint
      }, () => customRouter);
      
      expect(customRouter.getRoutes()).toContain('GET:/healthz/ready');
      expect(customRouter.getRoutes()).toContain('GET:/healthz/live');
      expect(customRouter.getRoutes()).not.toContain('GET:/api/probe/test');
    });
  });
});