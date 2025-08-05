import { ServerTracker } from '../../src/serverTracker';
import { createMockServer, createMockSocket, createMockRequest, createMockResponse } from '../mocks/express-mock';

describe('ServerTracker', () => {
  let server: any;
  let tracker: ServerTracker;
  
  beforeEach(() => {
    server = createMockServer();
  });
  
  describe('Connection Tracking', () => {
    it('should track new connections with unique IDs', () => {
      tracker = new ServerTracker(server);
      
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();
      
      // Simulate connections
      server.emit('connection', socket1);
      server.emit('connection', socket2);
      
      expect(tracker.connectionCount).toBe(2);
      expect(socket1.$$id).toBeDefined();
      expect(socket2.$$id).toBeDefined();
      expect(socket1.$$id).not.toBe(socket2.$$id);
    });
    
    it('should mark new connections as idle by default', () => {
      tracker = new ServerTracker(server);
      
      const socket = createMockSocket();
      server.emit('connection', socket);
      
      expect(socket.$$idle).toBe(true);
    });
    
    it('should remove connections when they close', () => {
      tracker = new ServerTracker(server);
      
      const socket = createMockSocket();
      server.emit('connection', socket);
      
      expect(tracker.connectionCount).toBe(1);
      
      // Simulate socket close
      socket.emit('close');
      
      expect(tracker.connectionCount).toBe(0);
    });
    
    it('should track active vs idle connections', () => {
      tracker = new ServerTracker(server);
      
      const activeSocket = createMockSocket({ $$idle: false });
      const idleSocket = createMockSocket({ $$idle: true });
      
      server.emit('connection', activeSocket);
      server.emit('connection', idleSocket);
      
      // Mark active socket as non-idle
      activeSocket.$$idle = false;
      
      expect(tracker.connectionCount).toBe(2);
      expect(tracker.activeConnectionCount).toBe(1);
    });
    
    it('should not count health check connections as active', () => {
      tracker = new ServerTracker(server, {
        healthCheckUrls: ['/api/probe/ready']
      });
      
      const healthCheckSocket = createMockSocket();
      const normalSocket = createMockSocket();
      
      // Simulate health check request
      const healthReq = createMockRequest({ 
        socket: healthCheckSocket,
        url: '/api/probe/ready'
      });
      const healthRes = createMockResponse();
      
      // Simulate normal request
      const normalReq = createMockRequest({ 
        socket: normalSocket,
        url: '/api/users'
      });
      const normalRes = createMockResponse();
      
      // Process requests to set $$isCheck properly
      server.emit('request', healthReq, healthRes);
      server.emit('request', normalReq, normalRes);
      
      // Mark sockets as active (not idle)
      healthCheckSocket.$$idle = false;
      normalSocket.$$idle = false;
      
      expect(tracker.connectionCount).toBe(2);
      expect(tracker.activeConnectionCount).toBe(1);
    });
  });
  
  describe('Request Handling', () => {
    it('should mark connections as active during requests', () => {
      tracker = new ServerTracker(server);
      
      const socket = createMockSocket();
      const req = createMockRequest({ socket });
      const res = createMockResponse();
      
      server.emit('request', req, res);
      
      expect(socket.$$idle).toBe(false);
    });
    
    it('should mark connections as idle when requests finish', () => {
      tracker = new ServerTracker(server);
      
      const socket = createMockSocket();
      const req = createMockRequest({ socket });
      const res = createMockResponse();
      
      server.emit('request', req, res);
      expect(socket.$$idle).toBe(false);
      
      // Get the bound function and access its mock
      const onMock = (res.on as jest.Mock);
      
      // Simulate response finish
      onMock.mock.calls
        .filter(([event]: [string]) => event === 'finish')
        .forEach(([_, handler]: [string, Function]) => handler());
      
      expect(socket.$$idle).toBe(true);
    });
    
    it('should identify health check requests', () => {
      tracker = new ServerTracker(server, {
        healthCheckUrls: ['/api/probe/ready', '/api/probe/live']
      });
      
      const socket = createMockSocket();
      const req = createMockRequest({ 
        socket,
        url: '/api/probe/ready'
      });
      const res = createMockResponse();
      
      server.emit('request', req, res);
      
      expect(socket.$$isCheck).toBe(true);
    });
  });
  
  describe('Shutdown Behavior', () => {
    it('should close idle connections when shutdown requested', () => {
      tracker = new ServerTracker(server);
      
      const idleSocket = createMockSocket();
      const activeSocket = createMockSocket();
      
      // Set up connections
      server.emit('connection', idleSocket);
      server.emit('connection', activeSocket);
      
      // Mark one as active by simulating a request
      const req = createMockRequest({ socket: activeSocket });
      const res = createMockResponse();
      server.emit('request', req, res);
      
      // idleSocket remains idle (default), activeSocket is now active
      expect(idleSocket.$$idle).toBe(true);
      expect(activeSocket.$$idle).toBe(false);
      
      tracker.requestShutdown();
      
      expect(idleSocket.destroy).toHaveBeenCalled();
      expect(activeSocket.destroy).not.toHaveBeenCalled();
      expect(tracker.connectionCount).toBe(1);
    });
    
    it('should reject non-health-check requests during shutdown', () => {
      tracker = new ServerTracker(server, {
        healthCheckUrls: ['/api/probe/ready']
      });
      
      tracker.requestShutdown();
      
      const socket = createMockSocket();
      const req = createMockRequest({ 
        socket,
        url: '/api/users' 
      });
      const res = createMockResponse();
      
      server.emit('request', req, res);
      
      expect((res.setHeader as jest.Mock)).toHaveBeenCalledWith('Connection', 'close');
      expect((res.writeHead as jest.Mock)).toHaveBeenCalledWith(503, 'Closing');
      expect((res.end as jest.Mock)).toHaveBeenCalled();
      expect(socket.destroy).toHaveBeenCalled();
    });
    
    it('should allow health check requests during shutdown', () => {
      tracker = new ServerTracker(server, {
        healthCheckUrls: ['/api/probe/ready']
      });
      
      tracker.requestShutdown();
      
      const socket = createMockSocket();
      const req = createMockRequest({ 
        socket,
        url: '/api/probe/ready' 
      });
      const res = createMockResponse();
      
      server.emit('request', req, res);
      
      expect((res.writeHead as jest.Mock)).not.toHaveBeenCalledWith(503, 'Closing');
      expect(socket.destroy).not.toHaveBeenCalled();
    });
    
    it('should destroy sockets after response during shutdown', () => {
      tracker = new ServerTracker(server, {
        healthCheckUrls: ['/api/probe/ready']
      });
      tracker.requestShutdown();
      
      const socket = createMockSocket();
      const req = createMockRequest({ 
        socket,
        url: '/api/probe/ready'
      });
      const res = createMockResponse();
      
      server.emit('request', req, res);
      
      // Socket should not be destroyed yet
      expect(socket.destroy).not.toHaveBeenCalled();
      
      // Finish the response
      const onMock = (res.on as jest.Mock);
      onMock.mock.calls
        .filter(([event]: [string]) => event === 'finish')
        .forEach(([_, handler]: [string, Function]) => handler());
      
      // Now socket should be destroyed
      expect(socket.destroy).toHaveBeenCalled();
    });
  });
  
  describe('Force Close', () => {
    it('should destroy all connections immediately', () => {
      tracker = new ServerTracker(server);
      
      const socket1 = createMockSocket({ $$idle: true });
      const socket2 = createMockSocket({ $$idle: false });
      const socket3 = createMockSocket({ $$idle: false, $$isCheck: true });
      
      server.emit('connection', socket1);
      server.emit('connection', socket2);
      server.emit('connection', socket3);
      
      tracker.forceClose();
      
      expect(socket1.destroy).toHaveBeenCalled();
      expect(socket2.destroy).toHaveBeenCalled();
      expect(socket3.destroy).toHaveBeenCalled();
      expect(tracker.connectionCount).toBe(0);
    });
    
    it('should close the server if still listening', () => {
      tracker = new ServerTracker(server);
      server.listening = true;
      
      tracker.forceClose();
      
      expect(server.close).toHaveBeenCalled();
    });
    
    it('should set shutdown flag', () => {
      tracker = new ServerTracker(server);
      
      expect(tracker.isShuttingDown).toBe(false);
      
      tracker.forceClose();
      
      expect(tracker.isShuttingDown).toBe(true);
    });
  });
  
  describe('Edge Cases', () => {
    it('should handle missing socket gracefully', () => {
      tracker = new ServerTracker(server);
      
      const req = createMockRequest({ socket: void 0 });
      const res = createMockResponse();
      
      // Should not throw
      expect(() => {
        server.emit('request', req, res);
      }).not.toThrow();
      
      expect(console.warn).toHaveBeenCalledWith('node-k8s-lifecylce: Unable to handle connection');
    });
    
    it('should handle duplicate connection events for same socket', () => {
      tracker = new ServerTracker(server);
      
      const socket = createMockSocket();
      
      server.emit('connection', socket);
      const firstId = socket.$$id;
      
      // Emit connection again for same socket
      server.emit('connection', socket);
      
      expect(socket.$$id).toBe(firstId);
      expect(tracker.connectionCount).toBe(1);
    });
    
    it('should handle connection close before tracking', () => {
      tracker = new ServerTracker(server);
      
      const socket = createMockSocket();
      
      // Close before connection event
      socket.emit('close');
      
      // Should not affect count
      expect(tracker.connectionCount).toBe(0);
    });
  });
  
  describe('Server Listening State', () => {
    it('should report server listening state', () => {
      tracker = new ServerTracker(server);
      
      server.listening = false;
      expect(tracker.isListening).toBe(false);
      
      server.listening = true;
      expect(tracker.isListening).toBe(true);
    });
  });
  
  describe('Error Scenarios', () => {
    it('should handle errors in socket.destroy()', () => {
      tracker = new ServerTracker(server);
      
      const socket = createMockSocket();
      socket.destroy.mockImplementation(() => {
        throw new Error('Socket destroy failed');
      });
      
      server.emit('connection', socket);
      
      // Should throw when forcing close since there's no error handling
      expect(() => tracker.forceClose()).toThrow('Socket destroy failed');
    });
    
    it('should handle server.close() errors', () => {
      tracker = new ServerTracker(server);
      server.listening = true;
      server.close.mockImplementation(() => {
        throw new Error('Server close failed');
      });
      
      // Should throw since there's no error handling
      expect(() => tracker.forceClose()).toThrow('Server close failed');
    });
    
    it('should handle response without socket during shutdown', () => {
      tracker = new ServerTracker(server);
      tracker.requestShutdown();

      const req = createMockRequest({ socket: void 0 });
      const res = createMockResponse();
      
      // Should not throw
      expect(() => {
        server.emit('request', req, res);
      }).not.toThrow();
      
      // When socket is null, it returns early and doesn't send a response
      expect((res.writeHead as jest.Mock)).not.toHaveBeenCalled();
      expect((res.end as jest.Mock)).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith('node-k8s-lifecylce: Unable to handle connection');
    });
    
    it('should handle concurrent connection events', () => {
      tracker = new ServerTracker(server);
      
      const sockets = Array.from({ length: 10 }, () => createMockSocket());
      
      // Emit all connections at once
      sockets.forEach(socket => server.emit('connection', socket));
      
      expect(tracker.connectionCount).toBe(10);
      
      // All should have unique IDs
      const ids = sockets.map(s => s.$$id);
      expect(new Set(ids).size).toBe(10);
    });
  });
});