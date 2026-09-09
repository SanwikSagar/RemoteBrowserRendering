# Fix Git line ending warnings on Windows using PowerShell

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Git Line Ending Fix" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if git is installed
try {
    git --version | Out-Null
} catch {
    Write-Host "ERROR: Git is not installed or not in PATH" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "Configuring Git to handle line endings..." -ForegroundColor Yellow
Write-Host ""

# Set git config for this repository
Write-Host "1. Configuring core.autocrlf for this project..." -ForegroundColor White
git config core.autocrlf true

if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to set git config" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "✓ core.autocrlf set to true" -ForegroundColor Green
Write-Host ""

# Renormalize all files
Write-Host "2. Renormalizing all files..." -ForegroundColor White
git rm --cached -r . 2>$null | Out-Null
git reset --hard HEAD 2>$null | Out-Null

if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ Files renormalized" -ForegroundColor Green
} else {
    Write-Host "WARNING: Renormalization had some issues, but continuing..." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "3. Adding renormalized files..." -ForegroundColor White
git add -A

Write-Host "✓ Files staged" -ForegroundColor Green
Write-Host ""

# Optional: Create a commit
$commit = Read-Host "Would you like to commit these changes? (y/n)"

if ($commit -eq "y" -or $commit -eq "Y") {
    Write-Host "Committing changes..." -ForegroundColor White
    git commit -m "fix: normalize line endings to LF"
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ Changes committed" -ForegroundColor Green
    } else {
        Write-Host "No changes to commit" -ForegroundColor Yellow
    }
} else {
    Write-Host "Skipped commit" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "✅ Line ending warnings should be fixed!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$verify = Read-Host "Would you like to verify? (y/n)"
if ($verify -eq "y" -or $verify -eq "Y") {
    Write-Host ""
    Write-Host "Your git config:" -ForegroundColor Yellow
    git config core.autocrlf
}

Write-Host ""
Read-Host "Press Enter to exit"
