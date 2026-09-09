@echo off
echo ============================================
echo   REMOTE BROWSER - DEPLOYMENT SCRIPT
echo ============================================
echo.
echo This script will help you deploy your browser to GitHub
echo.
pause

echo.
echo Step 1: Committing changes...
git add .
git commit -m "Ready for deployment"

echo.
echo Step 2: Setting branch to main...
git branch -M main

echo.
echo Step 3: Your repository should be ready!
echo.
echo ============================================
echo NEXT STEPS:
echo ============================================
echo.
echo 1. Create a GitHub repository:
echo    https://github.com/new
echo    Name: RemoteBrowserRendering
echo    Make it PUBLIC
echo.
echo 2. Copy your repository URL
echo.
echo 3. Run this command (replace with YOUR repo URL):
echo    git remote add origin YOUR_GITHUB_REPO_URL
echo    git push -u origin main
echo.
echo 4. Deploy on Render.com:
echo    https://dashboard.render.com
echo    - Click "New +" -^> "Web Service"
echo    - Connect your GitHub repo
echo    - Click "Create Web Service"
echo    - Wait 10 minutes
echo.
echo 5. Your browser will be live at:
echo    https://remote-browser-backend.onrender.com
echo.
echo ============================================
echo DONE! Read QUICK_START.md for detailed guide
echo ============================================
pause
