# 🚀 Zero-Cost Deployment Guide

This guide shows you how to deploy the Remote Browser Rendering system for **FREE** using various platforms.

## 🎯 Recommended: Render.com (Free Tier)

### Features
- ✅ 750 hours/month free
- ✅ Automatic deployments from GitHub
- ✅ Built-in SSL
- ✅ Zero configuration

### Steps

1. **Push to GitHub**
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/RemoteBrowserRendering.git
git push -u origin main
```

2. **Deploy on Render**
   - Go to [dashboard.render.com](https://dashboard.render.com)
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Render will auto-detect settings from `render.yaml`
   - Click "Create Web Service"
   - Wait 5-10 minutes for deployment

3. **Access Your Browser**
   - Your URL will be: `https://remote-browser-backend.onrender.com`
   - The free tier spins down after 15 minutes of inactivity
   - First request after idle takes ~30 seconds to wake up

---

## 🚂 Alternative: Railway.app (Free Trial)

### Features
- ✅ $5 free trial credit per month
- ✅ Faster than Render
- ✅ No sleep time

### Steps

1. **Deploy on Railway**
   - Go to [railway.app](https://railway.app)
   - Click "Start a New Project"
   - Select "Deploy from GitHub repo"
   - Choose your repository
   - Railway auto-detects Node.js and deploys
   - Click on your service → "Settings" → "Generate Domain"

2. **Your URL**
   - Will be: `https://your-app.up.railway.app`

---

## ⚡ Alternative: Koyeb (Free Tier)

### Features
- ✅ 2 free services
- ✅ No sleep time
- ✅ Global edge locations

### Steps

1. **Deploy on Koyeb**
   - Go to [koyeb.com](https://www.koyeb.com)
   - Click "Create App"
   - Connect GitHub and select repository
   - Set build command: `npm install`
   - Set run command: `npm start`
   - Deploy

---

## 🔷 Alternative: Fly.io (Free Tier)

### Features
- ✅ 3 shared-cpu VMs free
- ✅ 160GB transfer/month
- ✅ No sleep time

### Steps

1. **Install Fly CLI**
```bash
# Windows (PowerShell)
powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

2. **Deploy**
```bash
fly auth login
fly launch
fly deploy
```

---

## 📦 GitHub Pages (Frontend Only)

**Note:** GitHub Pages can only host the static frontend. You'll need one of the above services for the backend.

### Steps

1. **Enable GitHub Pages**
   - Go to your repository settings
   - Navigate to "Pages"
   - Select "GitHub Actions" as source
   - The workflow `.github/workflows/deploy.yml` will auto-deploy

2. **Update Frontend Config**
   - Edit `public/browser.js`
   - Change WebSocket URL to your backend:
   ```javascript
   const wsUrl = 'wss://your-backend.onrender.com';
   ```

---

## 🎮 Complete Setup (Recommended)

### 1. Backend on Render (Free)
   - Handles browser rendering
   - WebSocket streaming
   - Puppeteer automation

### 2. Frontend on GitHub Pages (Free)
   - Static HTML/CSS/JS
   - Fast global CDN
   - Professional domain

---

## 🔧 Configuration

### Environment Variables (if needed)

For Render/Railway/Koyeb, you can set these in the dashboard:

```env
NODE_ENV=production
PORT=3000
```

### Free Tier Limitations

**Render.com:**
- ⏱️ Spins down after 15 min inactivity
- 🔄 Cold start: ~30 seconds
- 💾 512MB RAM
- ⚡ Shared CPU

**Railway.app:**
- 💵 $5/month credit (runs out mid-month typically)
- 💾 512MB RAM
- ⚡ Faster cold starts

**Koyeb:**
- 💾 512MB RAM
- ⚡ No sleep time
- 🌍 Global edge

**Fly.io:**
- 💾 256MB RAM per VM
- ⚡ No sleep time
- 🌍 Multi-region

---

## 🚨 Important Notes

### Browser Memory
- Puppeteer is memory-intensive
- Free tiers may crash with multiple users
- Limit to 1-2 concurrent streams on free tier

### Workarounds for Free Tier
1. **Reduce resolution**: Change to 1280x720 in `src/server.js`
2. **Lower FPS**: Set max FPS to 30
3. **Increase quality**: Lower JPEG quality to 70

```javascript
// In streamManager.js
const width = options.width || 1280;  // Instead of 1920
const height = options.height || 720;  // Instead of 1080
const fps = Math.min(options.fps || 30, 30);  // Cap at 30
```

---

## 🎉 Quick Deploy Commands

### Render (Manual Git Push)
```bash
git init
git add .
git commit -m "Deploy to Render"
git branch -M main
git remote add origin YOUR_GITHUB_REPO_URL
git push -u origin main
# Then connect on Render dashboard
```

### Railway (CLI)
```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway open
```

### Fly.io
```bash
fly launch --name remote-browser
fly deploy
fly open
```

---

## 📊 Cost Comparison

| Platform | Free Tier | Sleep Time | RAM | Bandwidth | Best For |
|----------|-----------|------------|-----|-----------|----------|
| **Render** | 750hrs/mo | Yes (15min) | 512MB | Unlimited | Best free option |
| **Railway** | $5 credit | No | 512MB | 100GB | Fast, reliable |
| **Koyeb** | 2 services | No | 512MB | Unlimited | No sleep |
| **Fly.io** | 3 VMs | No | 256MB | 160GB | Global deploy |

---

## ✅ Verification

After deployment, test your browser:

1. Visit your deployed URL
2. Enter a URL like `https://example.com`
3. Click "Start Browser"
4. You should see the page streaming at 60 FPS
5. Try clicking, scrolling, and typing

---

## 🆘 Troubleshooting

### "Application Error" on Render
- Check build logs in Render dashboard
- Ensure Puppeteer dependencies are installed
- May need to reduce memory usage

### WebSocket Connection Failed
- Ensure your backend URL uses `wss://` (not `ws://`)
- Check CORS settings
- Verify backend is running

### Slow Performance
- Free tier has limited CPU
- Reduce FPS to 30
- Lower resolution to 1280x720
- Decrease JPEG quality to 70

---

## 🎓 Pro Tips

1. **Use Render for backend** - Most reliable free tier
2. **Keep it active** - Set up UptimeRobot to ping every 5 minutes
3. **Monitor usage** - Check Render dashboard for metrics
4. **Optimize images** - Lower quality on free tier (60-70%)
5. **Limit FPS** - 30 FPS is sufficient for browsing

---

## 🔗 Useful Links

- [Render Dashboard](https://dashboard.render.com)
- [Railway Dashboard](https://railway.app/dashboard)
- [Koyeb Dashboard](https://app.koyeb.com)
- [Fly.io Dashboard](https://fly.io/dashboard)
- [UptimeRobot](https://uptimerobot.com) - Keep your app awake

---

## 🎯 Next Steps

After deployment:
1. ⭐ Star the repo if you found this useful
2. 🔗 Share your deployment URL
3. 🐛 Report issues on GitHub
4. 🚀 Consider upgrading to paid tier for production use

**Congratulations! Your Remote Browser is now live! 🎉**
