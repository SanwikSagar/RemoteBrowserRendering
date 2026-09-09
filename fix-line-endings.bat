@echo off
REM Fix Git line ending warnings on Windows

echo.
echo ========================================
echo Git Line Ending Fix
echo ========================================
echo.

REM Check if git is installed
git --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Git is not installed or not in PATH
    pause
    exit /b 1
)

echo Configuring Git to handle line endings...
echo.

REM Set git config for this repository
echo 1. Configuring core.autocrlf for this project...
git config core.autocrlf true
if errorlevel 1 (
    echo ERROR: Failed to set git config
    pause
    exit /b 1
)

echo ✓ core.autocrlf set to true
echo.

REM Renormalize all files
echo 2. Renormalizing all files...
git rm --cached -r . >nul 2>&1
git reset --hard HEAD

if errorlevel 1 (
    echo WARNING: Renormalization had some issues, but continuing...
) else (
    echo ✓ Files renormalized
)

echo.
echo 3. Adding renormalized files...
git add -A

echo ✓ Files staged
echo.

REM Optional: Create a commit
echo Would you like to commit these changes? (y/n)
set /p commit=">> "

if /i "%commit%"=="y" (
    echo Committing changes...
    git commit -m "fix: normalize line endings to LF"
    if errorlevel 1 (
        echo No changes to commit
    ) else (
        echo ✓ Changes committed
    )
) else (
    echo Skipped commit
)

echo.
echo ========================================
echo ✅ Line ending warnings should be fixed!
echo ========================================
echo.
echo Verify with: git config core.autocrlf
echo.
pause
