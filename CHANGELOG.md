# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2025-08-04

### Added
- `Connection: close` header is now sent during shutdown to prevent connection reuse
- Exported `Phase` enum from main index for better TypeScript discoverability

### Changed
- **BREAKING**: Error handling now uses `Promise.allSettled` instead of `Promise.all` for all callbacks
  - State change callbacks that throw errors no longer prevent other callbacks from running
  - Shutdown callbacks that throw errors no longer prevent other callbacks from running
  - Ready check callbacks that throw errors no longer prevent other callbacks from running
  - All errors are now properly logged instead of being silently swallowed

### Fixed
- Fixed TypeScript type issue in `getProbeRouter` by removing unnecessary `@ts-ignore`
- Fixed typo in `serverTracker.ts`: `heatlhCheckUrls` → `healthCheckUrls`
- Fixed silent error swallowing in `updatePhase` function

## [1.0.1] - Previous Release

### Changed
- Initial stable release with core functionality
- Three-phase shutdown process
- Health check endpoints
- Connection tracking
- Configurable timeouts

## [1.0.0] - Initial Release

### Added
- Basic Kubernetes lifecycle management
- Express integration
- TypeScript support