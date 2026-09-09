# 🚀 Deploy in 5 Minutes

## Option 1: Render.com (Easiest, Completely Free)

### Step 1: Push to GitHub
```bash
# Initialize git if not already done
git init
git add .
git commit -m "Initial commit: Remote Browser"
git branch -M main

# Create a new repository on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/RemoteBrowserRendering.git
git push -u origin main
```

### Step 2: Deploy on Render
1. Go to https://dashboard.render.com/register
2. Sign up with your GitHub account (free)
3. Click "New +" button → "Web Service"
4. Click "Connect Account" to connect GitHub
5. Find and select your "RemoteBrowserRendering" repository
6. Render will auto-detect the settings from `render.yaml`
7. Click "Create Web Service"
8. Wait 5-10 minutes for deployment to complete

### Step 3: Get Your URL
- Your browser will be live at: `https://remote-browser-backend.onrender.com`
- Copy this URL for later use

### Step 4: Update Frontend (Optional)
If you want to host frontend on GitHub Pages:
1. Go to your GitHub repo settings → Pages
2. Source: GitHub Actions
3. The workflow will auto-deploy the frontend
4. Edit `public/browser.js` line ~150 to use your Render backend:
```javascript
const wsUrl = 'wss://remote-browser-backend.onrender.com';
```

---

## Option 2: Railway.app (Faster, $5 Free Trial)

### Step 1: Push to GitHub (same as above)

### Step 2: Deploy on Railway
1. Go to https://railway.app
2. Click "Start a New Project"
3. Select "Deploy from GitHub repo"
4. Select your "RemoteBrowserRendering" repository
5. Railway auto-deploys immediately
6. Click "Settings" → "Generate Domain"

### Done!
- Your browser will be live at: `https://your-app.up.railway.app`

---

## Option 3: One-Click Deploy Buttons

Add these to your README.md:

### Deploy to Render
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

### Deploy to Railway
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/QRMNQX)

---

## 🎯 Quick Test

After deployment, visit your URL and test:
1. Enter `https://www.wikipedia.org`
2. Click "Start Browser"
3. Wait 5-10 seconds for the browser to initialize
4. You should see Wikipedia streaming at 60 FPS
5. Try clicking on links!

---

## 📊 What You Get For Free

### Render.com Free Tier
- ✅ 750 hours per month (enough for 24/7 if only 1 app)
- ✅ Automatic HTTPS
- ✅ Custom domains supported
- ✅ Automatic deploys from GitHub
- ⚠️ Spins down after 15 min of inactivity (30sec cold start)

### Railway Free Trial
- ✅ $5 credit per month
- ✅ No sleep time
- ✅ Faster performance
- ✅ Automatic HTTPS
- ⚠️ Credit usually lasts 2-3 weeks with moderate use

---

## 🔧 Free Tier Optimizations

The app is already optimized for free tiers, but you can improve it further:

### Edit `src/streamManager.js` for lower resource usage:
```javascript
// Line 15-16: Reduce resolution
const width = options.width || 1280;  // Was 1920
const height = options.height || 720;  // Was 1080

// Line 12: Cap FPS
const fps = Math.min(options.fps || 30, 30);  // Was 60
```

### Edit `src/server.js` for fewer browsers:
```javascript
// Line 17: Reduce browser pool
maxBrowsers: 2,  // Was 5
```

---

## 🆘 Common Issues

### "Application Error"
- Free tier ran out of memory
- Reduce `maxBrowsers` to 2 or 1
- Lower resolution to 1280x720

### WebSocket Won't Connect
- Make sure your URL uses `wss://` (not `ws://`)
- Check that backend is fully deployed
- Wait 30 seconds for cold start on Render

### Slow Performance
- Free tier has limited CPU
- Lower FPS to 30 in settings
- Reduce quality to 70%

---

## 🎉 You're Done!

Your remote browser is now running 24/7 for FREE!

### Share Your Deployment
- Tweet about it
- Add to your portfolio
- Show it to friends

### Next Steps
- ⭐ Star the repo
- 🐛 Report any issues
- 💡 Suggest improvements
- 🚀 Deploy your own features

**Happy Browsing! 🌐**
