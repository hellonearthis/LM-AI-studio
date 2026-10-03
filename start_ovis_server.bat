@echo off
title Ovis-Omni Multimodal Engine (ATH-MaaS 3B - Port 8082)

:: WHAT: Launch script for the Ovis-Omni-Embedding-3B multimodal microservice on port 8082.
:: WHY: Hosts unified text and raw image embedding inference with zero-shot classification on CUDA.
::      Uses the CUDA-enabled virtual environment with PyTorch and Transformers to run on RTX 5070 Ti.

set "LAYA_VENV_PYTHON=C:\Users\Desktop-Dev\Desktop\Laya\.venv\Scripts\python.exe"
set "APP_ROOT=%~dp0"

if not exist "%LAYA_VENV_PYTHON%" (
    echo [ERROR] CUDA Python environment was not found at %LAYA_VENV_PYTHON%
    echo Please verify the virtual environment path.
    pause
    exit /b 1
)

cd /d "%APP_ROOT%"

:: WHAT: Pre-flight port verification to check if port 8082 is already occupied.
:: WHY: Windows socket error WinError 10048 (WSAEADDRINUSE) occurs when a lingering or background
::      Python/Uvicorn process holds port 8082. Automatically terminating the orphaned process
::      ensures the Ovis-Omni multimodal server can cleanly bind and start without error code 3.
set "CONFLICTING_PROCESS_IDENTIFIER="
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8082" ^| findstr "LISTENING"') do (
    set "CONFLICTING_PROCESS_IDENTIFIER=%%a"
)

if defined CONFLICTING_PROCESS_IDENTIFIER (
    echo [WARNING] Port 8082 is currently occupied by lingering Process ID %CONFLICTING_PROCESS_IDENTIFIER%.
    echo Releasing port 8082 by terminating the orphaned process...
    taskkill /F /PID %CONFLICTING_PROCESS_IDENTIFIER% >nul 2>&1
    timeout /t 1 /nobreak >nul
)

echo ======================================================================
echo Starting Ovis-Omni Multimodal Embedding Engine on http://127.0.0.1:8082...
echo Model: ATH-MaaS/Ovis-Omni-Embedding-3B
echo Device: NVIDIA CUDA (bfloat16)
echo ======================================================================

"%LAYA_VENV_PYTHON%" -m uvicorn services.ovis_omni_service:app --host 127.0.0.1 --port 8082 --app-dir "%APP_ROOT%"

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Ovis-Omni server exited with error code %errorlevel%.
    pause
)
