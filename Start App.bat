@echo off
cd /d "%~dp0"
echo Starting LM AI Studio...
call npm start
if %errorlevel% neq 0 (
    echo.
    echo Application crashed with error code %errorlevel%
    pause
)
