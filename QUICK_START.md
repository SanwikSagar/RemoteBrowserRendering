# ⚡ Quick Start - Deploy in 5 Minutes

## 🎯 Step 1: Create GitHub Repository

1. Go to https://github.com/new
2. Repository name: `RemoteBrowserRendering`
3. Make it **Public** (required for free tiers)
4. Click "Create repository"
5. **Copy the repository URL** (you'll need this)

## 🚀 Step 2: Push Your Code

Open terminal in your project folder and run:

```bash
# Initialize git (if not already done)
git init
git add .
git commit -m "Deploy Remote Browser"
git branch -M main

# Replace with YOUR repository URL from Step 1
git remote add origin https://github.com/YOUR_USERNAME/RemoteBrowserRendering.git
git push -u origin main
```

## 🌐 Step 3: Deploy on Render.com (100% FREE)

1. **Sign up:** Go to https://dashboard.render.com/register
   - Use your GitHub account (instant signup)

2. **Create Web Service:**
   - Click the **"New +"** button (top right)
   - Select **"Web Service"**
   - Click **"Connect account"** to link GitHub
   - Find and select your **RemoteBrowserRendering** repository
   - Render will auto-detect all settings from `render.yaml`

3. **Deploy:**
   - Click **"Create Web Service"**
   - Wait 5-10 minutes ☕ (Render installs everything)
   - Your URL will be: `https://remote-browser-backend.onrender.com`

## ✅ Step 4: Test Your Browser

1. Open your Render URL in a browser
2. You'll see the Remote Browser interface
3. Type a URL (e.g., `wikipedia.org`)
4. Click **"Start Browser"**
5. Wait 10-15 seconds for initialization
6. You should see the webpage streaming at 60 FPS!
7. Try clicking, scrolling, typing - it's fully interactive!

## 🎉 That's It!

Your remote browser is now running 24/7 for **FREE**!

## 📱 Share Your Browser

- Send your Render URL to friends
- Add it to your portfolio
- Tweet about it
- Use it from any device

## ⚙️ Optional: Custom Domain

1. Go to your Render service settings
2. Click "Custom Domain"
3. Add your domain (e.g., `browser.yourdomain.com`)
4. Update DNS as instructed

## 🔧 Free Tier Limits

**Render Free Tier:**
- ✅ 750 hours per month (enough for 24/7)
- ⚠️ Sleeps after 15 minutes of inactivity
- ⚠️ Cold start takes ~30 seconds after sleep
- ✅ Automatic HTTPS included

**Workaround for Sleep:**
- Use [UptimeRobot](https://uptimerobot.com) to ping every 5 minutes
- Keeps your browser awake 24/7

## 🆘 Common Issues

### "Service Unavailable"
- Your service is waking up from sleep (wait 30 seconds)
- Check Render logs for errors

### Can't connect
- Make sure service is fully deployed (green checkmark on Render)
- Clear browser cache
- Try incognito mode

### Slow performance
- Free tier has limited resources
- Lower FPS to 30 in settings
- Reduce quality to 70%

## 🚀 Next Steps

1. ⭐ **Star the GitHub repo** if you found this useful
2. 🐛 **Report issues** on GitHub
3. 💡 **Suggest features** you'd like to see
4. 🔗 **Share** your deployment URL

## 🎓 Advanced Options

Want more performance? Check these free alternatives:

- **Railway.app** - $5 free trial (faster, no sleep)
- **Fly.io** - 3 free VMs (global deployment)
- **Koyeb** - 2 free services (no sleep)

See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed comparisons.

---

**Enjoy your free remote browser! 🌐✨**
