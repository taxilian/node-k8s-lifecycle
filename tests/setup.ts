// Global test setup
beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  
  // Mock console methods to reduce noise
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
  
  // Clear any module state between tests
  jest.resetModules();
  
  // Reset environment variables
  delete process.env.READYPROBE_INTERVAL;
  delete process.env.SHUTDOWN_TIMEOUT;
  process.env.NODE_ENV = 'test';
  
  // Clear all SIGTERM listeners to prevent memory leak warnings
  process.removeAllListeners('SIGTERM');
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// Prevent actual process exit during tests
const originalExit = process.exit;
process.exit = jest.fn((code?: number) => {
  throw new Error(`process.exit called with code ${code}`);
});

// Restore on test suite completion
afterAll(() => {
  process.exit = originalExit;
});