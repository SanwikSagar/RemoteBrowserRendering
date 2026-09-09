# Remote Browser Rendering

High-performance remote browser rendering system streaming web pages as WebP images at up to 60 FPS.

## Features

- **WebP Streaming** - 30-40% smaller than JPEG with better quality
- **Mobile-Responsive** - Automatically detects and renders mobile/desktop sites correctly
- **High Performance** - Up to 60 FPS with sub-10ms encoding
- **Memory Optimized** - Automatic garbage collection and efficient resource management
- **Auto-Reconnect** - Resilient WebSocket connection with exponential backoff
- **Real-Time Interaction** - Click, scroll, and type in the remote browser
- **Progress Tracking** - Live loading progress and performance metrics

## Quick Start

### Install Dependencies
```bash
npm install
```

### Run Development Server
```bash
npm run dev:gc
```

### Run Production Server
```bash
npm run start:gc
```

The server will start on `http://localhost:3000`

## Configuration

### Environment Variables
```bash
PORT=3000                          # Server port
NODE_OPTIONS="--expose-gc"         # Enable garbage collection
```

### Default Settings
- **FPS**: 30 (adjustable 10-60)
- **Quality**: 80% (adjustable 60-95%)
- **Format**: WebP (optimized)
- **Max Browsers**: 1 (configurable in browserPool)

## Architecture

### Server Components
- **Express Server** - HTTP server and static file serving
- **WebSocket Server** - Real-time bidirectional communication
- **Browser Pool** - Manages Puppeteer browser instances
- **Stream Manager** - Handles screenshot capture and WebP encoding

### Client Components
- **RemoteBrowserClient** - Main client class
- **Frame Queue** - Buffers frames for smooth 60 FPS display
- **Mobile Detection** - Automatic device type detection
- **Responsive Viewport** - Dynamic sizing based on window

## Performance

### Metrics
- **Frame Size**: 25-35 KB (WebP)
- **Encoding Time**: 3-8ms
- **Display FPS**: 30-60
- **Latency**: Typically 50-200ms

### Optimizations
- WebP compression with effort level 0 (fastest)
- Hardware-accelerated rendering
- Aggressive resource blocking (ads, analytics, trackers)
- Memory cleanup every 50 frames
- Frame queue limited to 3 for memory efficiency

## API

### WebSocket Messages

#### Client → Server
```javascript
// Start streaming
{
  type: 'start',
  url: 'https://example.com',
  fps: 30,
  quality: 80,
  width: 1280,
  height: 720,
  isMobile: false
}

// Stop streaming
{ type: 'stop' }

// Interact with page
{
  type: 'interact',
  sessionId: 'uuid',
  action: {
    type: 'click',    // or 'scroll', 'type', 'key', 'navigate'
    x: 100,
    y: 200
  }
}
```

#### Server → Client
```javascript
// Stream started
{ type: 'started', sessionId: 'uuid' }

// Progress update
{
  type: 'progress',
  progress: 50,
  message: 'Loading page...',
  subtext: 'Please wait'
}

// Frame data
{
  type: 'frame',
  sessionId: 'uuid',
  frame: 'base64-encoded-webp',
  frameNumber: 42,
  timestamp: 1234567890,
  format: 'webp'
}

// Page info
{
  type: 'pageInfo',
  sessionId: 'uuid',
  url: 'https://example.com',
  title: 'Page Title'
}

// Stream stopped
{ type: 'stopped' }

// Error
{ type: 'error', message: 'Error description' }
```

## Deployment

### Docker
```bash
docker build -t remote-browser .
docker run -p 3000:3000 remote-browser
```

### Render.com
1. Connect your repository
2. Set start command: `node --expose-gc src/server.js`
3. Set environment: `NODE_OPTIONS=--expose-gc`

### Vercel
Not recommended (requires long-running processes)
Use Render or traditional hosting instead.

## Browser Support

| Browser | Support |
|---------|---------|
| Chrome | ✅ Full |
| Firefox | ✅ Full |
| Safari 14+ | ✅ Full |
| Edge | ✅ Full |

## Development

### Project Structure
```
├── public/
│   ├── index.html      # Client UI
│   └── browser.js      # Client application
├── src/
│   ├── server.js       # Express & WebSocket server
│   ├── browserPool.js  # Puppeteer instance manager
│   └── streamManager.js # Screenshot & encoding
├── package.json
└── README.md
```

### Scripts
```bash
npm start            # Production server
npm run start:gc     # Production with GC enabled
npm run dev          # Development server
npm run dev:gc       # Development with GC enabled
```

## Troubleshooting

### High Memory Usage
- Enable garbage collection with `--expose-gc`
- Reduce `maxBrowsers` in browserPool
- Lower FPS or quality settings

### Poor Performance
- Increase FPS setting (up to 60)
- Increase quality (up to 95%)
- Check network connection
- Use wired connection for best results

### Loading Spinner Stuck
- Fixed in current version
- Auto-hides on first frame
- Also hides when progress reaches 100%

### Mobile Sites Show Desktop Version
- Fixed in current version
- Automatic mobile detection
- Proper user agent and viewport settings

## License

MIT

## Contributing

Pull requests are welcome. For major changes, please open an issue first.
