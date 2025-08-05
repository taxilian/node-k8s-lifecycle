import { createMockServer, createMockSocket, MockExpressRouter, MockServer } from '../mocks/express-mock';
import * as K8sLifecycle from '../../src';
import { Socket } from 'node:net';
import { Server } from 'node:http';

export interface MockConnection {
  active: boolean;
  isHealthCheck?: boolean;
  socket?: Socket;
}

export function createMockServerWithConnections(connections: MockConnection[] = []) {
  const server = createMockServer();
  const sockets: Socket[] = [];
  
  connections.forEach((conn, index) => {
    const socket = conn.socket || createMockSocket({
      $$id: index,
      $$idle: !conn.active,
      $$isCheck: conn.isHealthCheck || false,
    });
    sockets.push(socket);
  });
  
  server.getConnections = () => sockets as any;
  return server;
}

export function waitForPhase(phase: K8sLifecycle.Phase): Promise<void> {
  return new Promise((resolve) => {
    const checkPhase = (newPhase: K8sLifecycle.Phase) => {
      if (newPhase === phase) {
        resolve();
      }
    };
    K8sLifecycle.onStateChange(checkPhase);
  });
}

export async function advanceTimersUntil(condition: () => boolean, maxTime = 600000) {
  const start = Date.now();
  while (!condition() && Date.now() - start < maxTime) {
    await jest.advanceTimersByTimeAsync(1000);
    await new Promise(resolve => setImmediate(resolve));
  }
  if (!condition()) {
    throw new Error(`Condition not met within ${maxTime}ms`);
  }
}

export class TestApplicationBuilder {
  private readyChecks: Array<() => Promise<boolean>> = [];
  private shutdownCallbacks: Array<() => Promise<void>> = [];
  private shutdownReadyChecks: Array<() => Promise<boolean>> = [];
  private servers: (Server | MockServer)[] = [];
  private stateChangeCallbacks: Array<(state: K8sLifecycle.Phase, prevState: K8sLifecycle.Phase) => void> = [];
  
  withReadyCheck(check: () => Promise<boolean>) {
    this.readyChecks.push(check);
    return this;
  }
  
  withShutdownCallback(callback: () => Promise<void>) {
    this.shutdownCallbacks.push(callback);
    return this;
  }
  
  withShutdownReadyCheck(check: () => Promise<boolean>) {
    this.shutdownReadyChecks.push(check);
    return this;
  }

  withServer(server: Server | MockServer) {
    this.servers.push(server);
    return this;
  }
  
  withStateChangeCallback(callback: (state: K8sLifecycle.Phase, prevState: K8sLifecycle.Phase) => void) {
    this.stateChangeCallbacks.push(callback);
    return this;
  }
  
  build() {
    // Clear any previous module state
    jest.resetModules();
    
    const lifecycle: typeof K8sLifecycle = require('../../src');
    
    // Setup callbacks
    this.readyChecks.forEach(check => lifecycle.onReadyCheck(check));
    this.shutdownCallbacks.forEach(cb => lifecycle.onShutdown(cb));
    this.shutdownReadyChecks.forEach(check => lifecycle.addShutdownReadyCheck(check));
    this.stateChangeCallbacks.forEach(cb => lifecycle.onStateChange(cb));
    
    // Add servers
    this.servers.forEach(server => lifecycle.addHttpServer(server as Server));
    
    // Get router with mock
    const mockRouter = new MockExpressRouter();
    lifecycle.getProbeRouter({}, () => mockRouter as any);
    
    return {
      lifecycle,
      router: mockRouter,
      cleanup: () => this.cleanup(),
    };
  }
  
  private cleanup() {
    // Reset module state for next test
    jest.resetModules();
  }
}

export type BuiltMockApplication = ReturnType<TestApplicationBuilder['build']>;
