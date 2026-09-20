@echo off
title Laya Decision Engine (ModernBERT Fast Classifier - Port 8765)

:: WHAT: Launch script for the Laya Decision Engine FastAPI microservice.
:: WHY: Provides single-click startup on port 8765 using Laya's isolated CUDA virtual environment,
::      enabling ~5-15ms non-autoregressive classifications, cluster theming, and faceted tagging.

set "LAYA_DIRECTORY=C:\Users\Desktop-Dev\Desktop\Laya"

if not exist "%LAYA_DIRECTORY%\.venv\Scripts\python.exe" (
    echo [ERROR] Laya virtual environment Python was not found at %LAYA_DIRECTORY%\.venv\Scripts\python.exe
    echo Please ensure the Laya environment is installed properly.
    pause
    exit /b 1
)

cd /d "%LAYA_DIRECTORY%"

echo ======================================================================
echo Starting Laya Decision Engine Server on http://127.0.0.1:8765...
echo Model: convaiinnovations/laya (ModernBERT System 1 Classifier)
echo ======================================================================

"%LAYA_DIRECTORY%\.venv\Scripts\python.exe" -m uvicorn laya_server:app --host 127.0.0.1 --port 8765 --app-dir "%LAYA_DIRECTORY%"

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Laya server exited with error code %errorlevel%.
    pause
)
