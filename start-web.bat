@echo off
rem Prompt Vault launcher.
rem All real logic (port probing, duplicate-instance detection, opening the
rem browser) lives in web/serve.mjs. This file only launches it, so nothing
rem here depends on PATH order or on proxy environment variables.
rem MUST keep CRLF line endings: cmd.exe silently aborts on LF-only batch files.
cd /d "%~dp0"
start "Prompt Vault" cmd /k node web\serve.mjs --open
exit /b 0
