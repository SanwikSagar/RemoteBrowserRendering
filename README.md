# 🌐 Remote Browser Rendering System

A high-performance remote browser that streams any webpage as optimized JPEG images at 60 FPS. Fully interactive with click, scroll, and keyboard support. Built with Puppeteer, WebSockets, and Node.js.

![Status](https://img.shields.io/badge/status-production--ready-success)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)
![Deploy](https://img.shields.io/badge/deploy-free-success)

## 🚀 Deploy NOW (100% FREE - 5 Minutes)

### Option 1: Render.com (Recommended)

```bash
# 1. Push to GitHub
git init
git add .
git commit -m "Deploy Remote Browser"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/RemoteBrowserRendering.git
git push -u origin main

# 2. Deploy on Render: https://dashboard.render.com
# Click "New +" → "Web Service" → Connect GitHub → Select repo → "Create Web Service"
# Wait 5-10 minutes ☕

# 3. Done! Your URL: https://remote-browser-backend.onrender.com
```

### One-Click Deploy Buttons

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

📖 **[Quick Start Guide](QUICK_START.md)** • **[Deployment Options](DEPLOYMENT.md)** • **[Deploy Commands](DEPLOY_COMMANDS.txt)**

---

## ✨ Features

### 🎮 Full Browser Experience
- ✅ **Real-time streaming** at up to 60 FPS
- ✅ **Fully interactive** - Click, scroll, type, and navigate
- ✅ **Tab management** - Multiple tabs support
- ✅ **Navigation controls** - Back, forward, refresh, home
- ✅ **Bookmarks** - Save your favorite sites
- ✅ **History** - View and revisit browsed pages
- ✅ **Zoom controls** - Zoom in/out on pages
- ✅ **Fullscreen mode** - Immersive viewing experience
- ✅ **Secure HTTPS** indicator
- ✅ **Auto-complete** suggestions

### ⚡ Performance Optimized
- 🚀 **MozJPEG compression** - 10-20% better than standard JPEG
- 🚀 **Chroma subsampling (4:2:0)** - Minimal quality loss
- 🚀 **Browser pooling** - Reuses browser instances
- 🚀 **Request interception** - Blocks unnecessary resources
- 🚀 **Adaptive frame timing** - Maintains consistent FPS
- 🚀 **Base64 encoding** - Efficient WebSocket transfer

### 🛠️ Production Ready
- ✅ **Browser pool management** - Efficient resource usage
- ✅ **WebSocket streaming** - Low-latency real-time updates
- ✅ **Graceful shutdown** - Proper cleanup
- ✅ **Health checks** - Monitoring endpoints
- ✅ **Error handling** - Robust error recovery
- ✅ **Docker support** - Containerized deployment

---

## 🏗️ Architecture

### Backend Components
- **Server** (`src/server.js`) - Express HTTP + WebSocket server
- **BrowserPool** (`src/browserPool.js`) - Manages Puppeteer browser instances
- **StreamManager** (`src/streamManager.js`) - Handles streaming sessions and frame capture
- **Sharp + MozJPEG** - JPEG optimization for minimal file sizes

### Frontend
- **HTML/CSS/JS** client with WebSocket streaming
- Real-time FPS, frame count, and latency display
- Configurable quality and frame rate settings
- Full browser UI with tabs, bookmarks, history

---

## � Local Development

### Prerequisites
- Node.js 18 or higher
- npm or yarn

### Installation

```bash
# Install dependencies
npm install

# Start the server
npm start

# Development mode (auto-reload)
npm run dev
```

### Access
Open your browser and navigate to:
```
http://localhost:3000
```

---

## 🎮 Usage

1. Enter a URL in the address bar (e.g., `https://www.wikipedia.org`)
2. Adjust FPS (15-60) and Quality (50-100) settings
3. Click **"Start Browser"** to begin rendering
4. Wait 5-10 seconds for browser initialization
5. Interact with the page:
   - **Click** anywhere on the page
   - **Scroll** with your mouse wheel
   - **Type** on your keyboard
   - **Navigate** using browser buttons
6. Open **History**, **Bookmarks**, or **Settings** using toolbar buttons
7. Click **Stop** to end the session

---

## ⚙️ Configuration

### Environment Variables

```env
NODE_ENV=production
PORT=3000
```

### Browser Pool Settings

Edit `src/server.js`:
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

### Free Tier Optimization

For free hosting services, reduce resource usage:

```javascript
// src/streamManager.js - Line 15-16
const width = options.width || 1280;  // Instead of 1920
const height = options.height || 720;  // Instead of 1080

// src/streamManager.js - Line 12
const fps = Math.min(options.fps || 30, 30);  // Cap at 30 FPS

// src/server.js - Line 17
maxBrowsers: 2,  // Instead of 5
```

---

## 🐳 Docker Deployment

### Build and Run

```bash
# Build Docker image
docker build -t remote-browser .

# Run container
docker run -p 3000:3000 remote-browser
```

### Docker Compose

```yaml
version: '3.8'
services:
  browser:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    restart: unless-stopped
```

---

## 📊 Performance Metrics

- **Target FPS**: 60 (configurable 15-60)
- **Typical latency**: 50-200ms (depends on network & page complexity)
- **JPEG quality**: 85% default (configurable 50-100)
- **Resolution**: 1920x1080 default (configurable)
- **Frame size**: 20-50KB per frame @ 85% quality

---

## 🆘 Troubleshooting

### "Application Error" on Free Tier
- Reduce `maxBrowsers` to 2 or 1
- Lower resolution to 1280x720
- Decrease FPS to 30

### WebSocket Won't Connect
- Ensure backend URL uses `wss://` (not `ws://`)
- Check that backend is fully deployed
- Wait 30 seconds for cold start (free tiers)

### Slow Performance
- Free tier has limited CPU
- Lower FPS to 30 in settings
- Reduce quality to 70%
- Close other applications

### Chrome Fails to Launch
On Linux, install dependencies:
```bash
sudo apt-get install -y chromium-browser
```

---

## 📝 API Reference

### WebSocket Messages

#### Client → Server

**Start Stream:**
```json
{
  "type": "start",
  "url": "https://example.com",
  "fps": 60,
  "quality": 85,
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

**Interact (Click):**
```json
{
  "type": "interact",
  "sessionId": "uuid",
  "action": {
    "type": "click",
    "x": 100,
    "y": 200
  }
}
```

**Navigate:**
```json
{
  "type": "interact",
  "sessionId": "uuid",
  "action": {
    "type": "navigate",
    "action": "goto",
    "url": "https://example.com"
  }
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

**Page Info:**
```json
{
  "type": "pageInfo",
  "sessionId": "uuid",
  "url": "https://current-page.com"
}
```

---

## 🔒 Security Considerations

- ⚠️ Add URL validation for production use
- ⚠️ Implement rate limiting for public deployments
- ⚠️ Add authentication for WebSocket connections
- ⚠️ Configure CORS policies as needed
- ⚠️ Consider implementing user sessions
- ⚠️ Add request logging and monitoring

---

## 🚀 Deployment Platforms (All FREE)

| Platform | Free Tier | Sleep | RAM | Pros |
|----------|-----------|-------|-----|------|
| **[Render](https://render.com)** | 750hrs/mo | Yes (15min) | 512MB | Best free option |
| **[Railway](https://railway.app)** | $5 credit | No | 512MB | Fast, reliable |
| **[Fly.io](https://fly.io)** | 3 VMs | No | 256MB | Global deploy |
| **[Koyeb](https://koyeb.com)** | 2 services | No | 512MB | No sleep time |

📖 See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed comparison

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- [Puppeteer](https://pptr.dev/) - Headless Chrome automation
- [Sharp](https://sharp.pixelplumbing.com/) - High-performance image processing
- [ws](https://github.com/websockets/ws) - WebSocket library for Node.js
- [Express](https://expressjs.com/) - Fast, unopinionated web framework

---

## 📧 Support

- 🐛 **Issues**: [GitHub Issues](https://github.com/YOUR_USERNAME/RemoteBrowserRendering/issues)
- 💬 **Discussions**: [GitHub Discussions](https://github.com/YOUR_USERNAME/RemoteBrowserRendering/discussions)
- 📖 **Documentation**: [QUICK_START.md](QUICK_START.md), [DEPLOYMENT.md](DEPLOYMENT.md)

---

## ⭐ Star History

If you find this project useful, please consider giving it a star ⭐

---

**Built with ❤️ by developers, for developers**

**Happy Browsing! 🌐✨**
