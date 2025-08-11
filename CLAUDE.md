# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a TypeScript library called `k8s-lifecycle` that helps Node.js applications correctly implement Kubernetes startup, health, and readiness checks. It provides a robust solution for graceful shutdowns and lifecycle management in Kubernetes environments.

## Build Commands

```bash
# Build the TypeScript code to JavaScript
npm run prepublish  # or directly: tsc -p .

# The project currently has no tests configured
# npm test returns an error - tests need to be implemented
```

## Architecture and Key Components

### Core Files
- **src/index.ts**: Main entry point that exports all public APIs
- **src/probes.ts**: Implements the health check endpoints and lifecycle management logic
- **src/serverTracker.ts**: Manages HTTP/HTTPS server tracking and connection handling during shutdown

### Key Architectural Concepts

1. **Three-Phase Shutdown Process**:
   - Phase 1 (`shutdownReq`): Readiness endpoint fails immediately to stop new traffic
   - Phase 2 (`shuttingDown`): Stop accepting new connections, wait for existing ones to complete
   - Phase 3 (`final`): Clean shutdown of all resources

2. **Server Tracking**: The library tracks all HTTP/HTTPS servers to manage their lifecycle, including:
   - Tracking active connections
   - Closing idle connections during shutdown
   - Preventing new connections while allowing health checks

3. **Health Check Probes**:
   - `/api/probe/test`: Test endpoint
   - `/api/probe/ready`: Readiness check (fails during shutdown)
   - `/api/probe/live`: Liveness check (fails on unrecoverable errors)

## Important Implementation Details

- Uses Express router for health check endpoints
- Requires TypeScript compilation before use
- Peer dependency on Express (>= 3.0.0)
- Environment variables control behavior:
  - `READYPROBE_INTERVAL`: Controls Phase 1 duration (default: 30s)
  - `SHUTDOWN_TIMEOUT`: Maximum shutdown time (default: 540s)
  - `NODE_ENV`: Affects error handling behavior

### Recent Improvements (v1.1.0)
- **Connection Management**: ServerTracker now sends `Connection: close` header during shutdown
- **Error Handling**: All callback arrays use `Promise.allSettled` instead of `Promise.all`
- **Phase Enum**: Exported from index.ts for better TypeScript discoverability
- **Error Logging**: State change and shutdown callbacks now log errors instead of silently failing

## Development Notes

- TypeScript strict mode is enabled
- Target is ES2018 with CommonJS modules
- Source maps and declarations are generated
- The library exports both CommonJS modules and TypeScript type definitions
- No test suite currently exists - tests need to be implemented

## Success Criteria

No task is complete until the typescript build is successful and all tests pass.
