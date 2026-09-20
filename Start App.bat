@echo off
setlocal enabledelayedexpansion
title LM AI Studio Launcher
cd /d "%~dp0"

:: ============================================================================
:: WHAT: Automated launcher for LM AI Studio and its local AI microservices.
:: WHY: Ensures that the local vision server (port 8080), embedding server
::      (port 8081), and Laya classifier (port 8765) are active before launching
::      the Electron interface, so all image analysis and vector search work.
:: ============================================================================

:: Configurable Vision Model launch script:
:: Defaults to full 9B vision model (start_llama_server.bat)
:: Can be set to start_llama_vision_4b.bat for low-VRAM environments
set "VISION_LAUNCH_SCRIPT=start_llama_server.bat"

echo ======================================================================
echo                     LM AI STUDIO LAUNCHER
echo ======================================================================
echo Verifying local AI backend services...
echo.

:: ----------------------------------------------------------------------------
:: 1. Vision Server Probe & Startup (Port 8080)
:: ----------------------------------------------------------------------------
curl.exe -s -f -o NUL http://127.0.0.1:8080/health
if errorlevel 1 (
    echo [INFO] Vision Server on port 8080 is offline.
    echo Starting llama-server with Vision Model in a new window...
    start "llama-server-vision" cmd /k "call %VISION_LAUNCH_SCRIPT%"
) else (
    echo [OK] Vision Server on port 8080 is online.
)

:: ----------------------------------------------------------------------------
:: 2. Embeddings Server Probe & Startup (Port 8081)
:: ----------------------------------------------------------------------------
curl.exe -s -f -o NUL http://127.0.0.1:8081/health
if errorlevel 1 (
    echo [INFO] Embedding Server on port 8081 is offline.
    echo Starting llama-server with Nomic Embeddings in a new window...
    start "llama-server-embeddings" cmd /k "call start_llama_embeddings.bat"
) else (
    echo [OK] Embedding Server on port 8081 is online.
)

:: ----------------------------------------------------------------------------
:: 3. Laya Classifier Server Probe & Startup (Port 8765)
:: ----------------------------------------------------------------------------
if exist "start_laya_server.bat" (
    curl.exe -s -f -o NUL http://127.0.0.1:8765/health
    if errorlevel 1 (
        echo [INFO] Laya Classifier Server on port 8765 is offline.
        echo Starting Laya Classifier in a new window...
        start "laya-classifier" cmd /k "call start_laya_server.bat"
    ) else (
        echo [OK] Laya Classifier Server on port 8765 is online.
    )
)

echo.
echo Launching LM AI Studio Electron application...
echo ======================================================================
call npm start
if %errorlevel% neq 0 (
    echo.
    echo Application exited with error code %errorlevel%
    pause
)
