import { EventEmitter } from 'events';
import { Server } from 'node:http';
import { Socket } from 'node:net';

type MutablePartial<T> = {
  -readonly [K in keyof T]?: T[K];
};

export type MockServer = MutablePartial<Server>;

export interface MockRequest {
  query: Record<string, string | string[]>;
  url: string;
  socket: Socket;
}

export interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  status: jest.Mock;
  send: jest.Mock;
  write: jest.Mock;
  end: jest.Mock;
  setHeader: jest.Mock;
  writeHead: jest.Mock;
  on: jest.Mock;
}

export function createMockRequest(overrides: Partial<MockRequest> = {}): MockRequest {
  const socket = createMockSocket();
  return {
    query: {},
    url: '/',
    socket,
    ...overrides,
  };
}

export function createMockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    headers: {},
    body: '',
    status: jest.fn(function(this: MockResponse, code: number) {
      this.statusCode = code;
      return this;
    }),
    send: jest.fn(function(this: MockResponse, body: string) {
      this.body = body;
      return this;
    }),
    write: jest.fn(function(this: MockResponse, chunk: string) {
      this.body += chunk;
      return this;
    }),
    end: jest.fn(function(this: MockResponse, chunk?: string, cb?: Function) {
      if (chunk) this.body += chunk;
      if (cb) cb();
      return this;
    }),
    setHeader: jest.fn(function(this: MockResponse, name: string, value: string) {
      this.headers[name] = value;
      return this;
    }),
    writeHead: jest.fn(function(this: MockResponse, code: number, msg?: string) {
      this.statusCode = code;
      return this;
    }),
    on: jest.fn(),
  };
  
  // Don't bind mock functions - it breaks jest's mock tracking
  
  return res;
}

export class MockExpressRouter {
  private routes = new Map<string, Function>();
  
  get(path: string, handler: Function) {
    this.routes.set(`GET:${path}`, handler);
  }
  
  async simulateRequest(method: string, path: string, req: Partial<MockRequest> = {}) {
    const key = `${method}:${path}`;
    const handler = this.routes.get(key);
    if (!handler) throw new Error(`Route not found: ${key}`);
    
    const mockReq = createMockRequest({ url: path, ...req });
    const mockRes = createMockResponse();
    
    await handler(mockReq, mockRes);
    return mockRes;
  }
  
  getRoutes() {
    return Array.from(this.routes.keys());
  }
}

export function createMockSocket(overrides: Partial<Socket> = {}) {
  const socket = new EventEmitter() as any;
  socket.destroy = jest.fn();
  socket.remoteAddress = '127.0.0.1';
  Object.assign(socket, overrides);
  return socket;
}

export function createMockServer() {
  const server = new EventEmitter() as MockServer;
  server.listening = false;
  server.close = jest.fn((cb?: Function) => {
    server.listening = false;
    if (cb) cb();
  }) as any;
  server.listen = jest.fn((port: number, cb?: Function) => {
    server.listening = true;
    if (cb) cb();
  }) as any;
  return server;
}