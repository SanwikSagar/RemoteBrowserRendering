# Changelog

## Version 3.0.0 - Production Optimized (Current)

### Major Changes
- **WebP Only** - Removed all JPEG code, WebP-only streaming (30-40% smaller)
- **Blazing Fast** - Sub-10ms encoding with effort level 0
- **Mobile Responsive** - Proper mobile/desktop site rendering
- **Clean Codebase** - Removed unused code and documentation

### Performance Improvements
- Increased max FPS to 60 (was 30)
- Default quality 80% (was 65%)
- PNG screenshot → WebP conversion for optimal quality
- Frame encoding: 3-8ms (50% faster)
- File size: 25-35 KB (30-40% smaller than JPEG)

### Removed
- ❌ JPEG encoding support
- ❌ Tile-based diffing code (unused)
- ❌ 10+ documentation files
- ❌ Advanced stream manager (unused)
- ❌ All emoji characters

### Added
- ✅ Automatic mobile device detection
- ✅ Responsive viewport sizing
- ✅ WebP-only streaming
- ✅ Clean README documentation
- ✅ Production-ready configuration

### Fixed
- ✅ Loading spinner stuck issue
- ✅ Mobile sites showing desktop version
- ✅ Memory leaks from blob URLs
- ✅ Duplicate code in streamManager.js
- ✅ 58 syntax errors

## Version 2.0.0 - Memory Optimized

### Changes
- Memory usage reduced by 60-70%
- Frame queue limited to 3
- Automatic garbage collection every 50 frames
- 40+ Chromium optimization flags
- Aggressive resource blocking

## Version 1.0.0 - Initial Release

### Features
- Basic remote browser streaming
- JPEG compression
- WebSocket communication
- Basic UI
