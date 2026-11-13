@echo off
title Laya Decision Engine (Intel NPU OpenVINO - Port 8765)

:: WHAT: Launch script for the Laya Decision Engine FastAPI microservice.
:: WHY: Runs Laya on the Intel AI Boost NPU via OpenVINO using the 32-key eager ONNX model
::      (laya_eager_b1_s512_k32.onnx with external weights laya_eager_b1_s512_k32.onnx.data) on port 8765,
::      enabling ultra-fast sub-10ms zero-shot classification, query intent routing, and prompt consequence checks.

set "LAYA_DIRECTORY=C:\Users\Desktop-Dev\Desktop\Laya_npu"
set "LAYA_PYTHON_EXE=C:\Users\Desktop-Dev\Desktop\Laya\.venv\Scripts\python.exe"
set "LAYA_ONNX_PATH=%LAYA_DIRECTORY%\laya_eager_b1_s512_k32.onnx"

if not exist "%LAYA_PYTHON_EXE%" (
    echo [WARNING] Laya virtual environment Python not found at %LAYA_PYTHON_EXE%
    echo Falling back to system python.exe...
    set "LAYA_PYTHON_EXE=python.exe"
)

if not exist "%LAYA_DIRECTORY%\laya_server.py" (
    echo [ERROR] Laya server script was not found at %LAYA_DIRECTORY%\laya_server.py
    pause
    exit /b 1
)

if not exist "%LAYA_ONNX_PATH%" (
    echo [WARNING] ONNX model not found at %LAYA_ONNX_PATH%
    echo Falling back to 16-key ONNX model if present...
    set "LAYA_ONNX_PATH=%LAYA_DIRECTORY%\laya_eager_b1_s512_k16.onnx"
)

:: Configure NPU environment variables
set "LAYA_DEVICE=NPU"
set "LAYA_HOST=127.0.0.1"
set "LAYA_PORT=8765"
set "LAYA_IDLE_TIMEOUT=0"
set "LAYA_CACHE_DIR=%LAYA_DIRECTORY%\ov_cache"

cd /d "%LAYA_DIRECTORY%"

echo ======================================================================
echo  Starting Laya Decision Engine (Intel NPU / OpenVINO)
echo ======================================================================
echo  Endpoint:   http://%LAYA_HOST%:%LAYA_PORT%
echo  Device:     %LAYA_DEVICE% (Intel AI Boost NPU via OpenVINO)
echo  Directory:  %LAYA_DIRECTORY%
echo  Model ONNX: %LAYA_ONNX_PATH%
echo  Weights:    %LAYA_DIRECTORY%\laya_eager_b1_s512_k32.onnx.data
echo ======================================================================
echo.

"%LAYA_PYTHON_EXE%" laya_server.py

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Laya NPU server exited with error code %errorlevel%.
    pause
)
