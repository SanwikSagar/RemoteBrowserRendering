# 🌐 Remote Browser Rendering System

A high-performance remote browser that streams any webpage as optimized JPEG images at 60 FPS. Fully interactive with click, scroll, and keyboard support. Built with Puppeteer, WebSockets, and Node.js.

## 🚀 **Deploy NOW (100% FREE)**

### ⚡ Quick Deploy to Render.com (5 minutes)

1. **Push to GitHub:**
```bash
git init
git add .
git commit -m "Deploy Remote Browser"
git branch -M main
git remote add origin YOUR_GITHUB_REPO
git push -u origin main
```

2. **Deploy on Render:**
   - Go to [dashboard.render.com](https://dashboard.render.com)
   - Click "New +" → "Web Service"
   - Connect your GitHub repo
   - Click "Create Web Service" (settings are auto-detected!)
   - Wait 5-10 minutes ☕

3. **Done!** Your browser will be live at: `https://remote-browser-backend.onrender.com`

📖 **[Quick Start Guide](QUICK_START.md)** • **[Deployment Options](DEPLOYMENT.md)**

---

## ✨ Features

## ✨ Features

### 🎮 Full Browser Experience
- **Real-time streaming** at up to 60 FPS
- **Fully interactive** - Click, scroll, type, and navigate
- **Tab management** - Multiple tabs support
- **Navigation controls** - Back, forward, refresh, home
- **Bookmarks** - Save your favorite sites
- **History** - View and revisit browsed pages
- **Zoom controls** - Zoom in/out on pages
- **Fullscreen mode** - Immersive viewing experience
- **Secure HTTPS** indicator
- **Auto-complete** suggestions

### ⚡ Performance Optimized
- **MozJPEG compression** - 10-20% better than standard JPEG
- **Chroma subsampling (4:2:0)** - Minimal quality loss
- **Browser pooling** - Reuses browser instances
- **Request interception** - Blocks unnecessary resources
- **Adaptive frame timing** - Maintains consistent FPS
- **Base64 encoding** - Efficient WebSocket transfer

### 🛠️ Production Ready
- **Browser pool management** - Efficient resource usage
- **WebSocket streaming** - Low-latency real-time updates
- **Graceful shutdown** - Proper cleanup
- **Health checks** - Monitoring endpoints
- **Error handling** - Robust error recovery
- **Docker support** - Containerized deployment

## 🏗️ Architecture

### Backend Components

- **Server** (`src/server.js`) - Express HTTP server + WebSocket server
- **BrowserPool** (`src/browserPool.js`) - Manages a pool of Puppeteer browser instances
- **StreamManager** (`src/streamManager.js`) - Handles streaming sessions and frame capture
- **Sharp** - JPEG optimization with MozJPEG for minimal file sizes

### Frontend

- **HTML/CSS/JS** client with WebSocket streaming
- Real-time FPS, frame count, and latency display
- Configurable quality and frame rate settings

## 🚀 Quick Start

### Prerequisites

- Node.js 18 or higher
- npm or yarn

### Installation

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

3. Open your browser and navigate to:
```
http://localhost:3000
```

### Development Mode

Run with auto-reload:
```bash
npm run dev
```

## 🎮 Usage

1. Enter a URL in the input field (e.g., `https://www.wikipedia.org`)
2. Adjust FPS (1-60) and Quality (1-100) settings
3. Click **Start Stream** to begin rendering
4. Watch the real-time statistics (FPS, frame count, latency)
5. Click **Stop Stream** to end the session

## ⚙️ Configuration

### Environment Variables

- `PORT` - Server port (default: 3000)

### Browser Pool Settings

Edit `src/server.js` to configure:

```javascript
const browserPool = new BrowserPool({
  maxBrowsers: 5,  // Maximum concurrent browser instances
  launchOptions: {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
});
```

## 🎯 Optimization Techniques

1. **MozJPEG Compression** - Superior compression compared to standard JPEG
2. **Chroma Subsampling (4:2:0)** - Reduces file size with minimal quality loss
3. **Browser Pooling** - Reuses browser instances for better performance
4. **Request Interception** - Blocks unnecessary resources (fonts, media)
5. **Frame Timing** - Precise timing to maintain target FPS
6. **Base64 Encoding** - Efficient WebSocket transfer

## 📊 Performance

- **Target FPS**: 60 (configurable down to 1)
- **Typical latency**: 50-200ms depending on network and page complexity
- **JPEG quality**: 80% default (configurable 1-100)
- **Resolution**: 1920x1080 default

## 🐳 Deployment

### Docker Deployment

Create a `Dockerfile`:

```dockerfile
FROM node:18-slim

# Install Chrome dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 3000

CMD ["npm", "start"]
```

Build and run:
```bash
docker build -t remote-browser-rendering .
docker run -p 3000:3000 remote-browser-rendering
```

### GitHub Actions Deployment

Create `.github/workflows/deploy.yml` for automated deployment.

## 📝 API Reference

### WebSocket Messages

#### Client → Server

**Start Stream:**
```json
{
  "type": "start",
  "url": "https://example.com",
  "fps": 60,
  "quality": 80,
  "width": 1920,
  "height": 1080
}
```

**Stop Stream:**
```json
{
  "type": "stop"
}
```

#### Server → Client

**Stream Started:**
```json
{
  "type": "started",
  "sessionId": "uuid"
}
```

**Frame Data:**
```json
{
  "type": "frame",
  "sessionId": "uuid",
  "frame": "base64_jpeg_data",
  "frameNumber": 123,
  "timestamp": 1234567890
}
```

**Stream Stopped:**
```json
{
  "type": "stopped"
}
```

**Error:**
```json
{
  "type": "error",
  "message": "Error description"
}
```

## 🔒 Security Considerations

- URL validation should be added for production use
- Rate limiting recommended for public deployments
- Consider adding authentication for WebSocket connections
- Implement CORS policies as needed

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

MIT License - feel free to use this project for any purpose.

## 🙏 Acknowledgments

- [Puppeteer](https://pptr.dev/) - Headless Chrome automation
- [Sharp](https://sharp.pixelplumbing.com/) - High-performance image processing
- [ws](https://github.com/websockets/ws) - WebSocket library

## 🐛 Troubleshooting

### Chrome fails to launch

On Linux, you may need to install additional dependencies:
```bash
sudo apt-get install -y chromium-browser
```

### High memory usage

Reduce `maxBrowsers` in the browser pool configuration.

### Low FPS

- Check network bandwidth
- Reduce quality setting
- Reduce resolution
- Ensure sufficient CPU resources

## 📧 Support

For issues and questions, please open an issue on GitHub.
