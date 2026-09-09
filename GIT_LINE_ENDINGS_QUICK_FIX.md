# Git Line Ending Warnings - Quick Fix

## The Problem
```
warning: in the working copy of 'file.js', CRLF will be replaced by LF the next time Git touches it
```

This happens because:
- Your files use **CRLF** (Windows line endings)
- Git expects **LF** (Unix line endings)
- `.gitattributes` specifies `eol=lf` but git isn't converting

## Solution (3 Steps)

### Step 1: Configure Git
```bash
git config --global core.autocrlf true
git config --global core.safecrlf false
```

### Step 2: Reset Files
```bash
git rm --cached -r .
git reset --hard HEAD
```

### Step 3: Re-add and Commit
```bash
git add .
git commit -m "fix: normalize line endings to LF"
```

## Done! ✅

No more warnings. 

## Explanation

| Setting | Effect |
|---------|--------|
| `core.autocrlf true` | Convert CRLF→LF on commit, LF→CRLF on checkout |
| `core.safecrlf false` | Don't warn about mixed line endings |
| `git rm --cached -r .` | Remove files from git index |
| `git reset --hard HEAD` | Restore with correct line endings |

## Verify

```bash
git config core.autocrlf
# Should output: true
```

## For This Repo Only

Instead of `--global`, use:
```bash
git config core.autocrlf true
git config core.safecrlf false
```

(no `--global` flag)

## Prevention Going Forward

With `core.autocrlf true`:
- Windows users: Files automatically convert CRLF→LF
- Mac/Linux users: No changes needed (already use LF)
- Everyone: Same line endings in git history

## Reference

More info: https://docs.github.com/en/get-started/getting-started-with-git/configuring-git-to-handle-line-endings
