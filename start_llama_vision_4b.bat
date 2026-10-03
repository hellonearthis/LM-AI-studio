@echo off
title "llama-server (LM AI Studio Vision 4B Low-VRAM on Port 8081)"

:: ============================================================================
:: WHAT: Launch script for llama-server.exe running Qwen3-VL-4B on port 8081.
:: WHY: Qwen3-VL-4B requires only ~2.5 GB of VRAM, making it ideal for running
::      concurrently alongside heavy background tasks (like ComfyUI) or on
::      systems with constrained GPU memory.
:: ============================================================================

set "LLAMA_DIR=C:\llamaCPP"

if not exist "%LLAMA_DIR%\llama-server.exe" (
    echo [ERROR] llama-server.exe not found in %LLAMA_DIR%.
    echo Please ensure llama.cpp is installed in %LLAMA_DIR% or update this script with your installation path.
    pause
    exit /b 1
)

cd /d "%LLAMA_DIR%"

echo ======================================================================
echo Starting llama-server for LM AI Studio on port 8081...
echo Model: Qwen 3-VL 4B Instruct (Low-VRAM / Fast Inference)
echo Multimodal Projector: mmproj-Qwen3-VL-4B-Instruct-F16
echo ======================================================================

llama-server.exe ^
  -m "models\lmstudio-community\Qwen3-VL-4B-Instruct-GGUF\Qwen3-VL-4B-Instruct-Q4_K_M.gguf" ^
  --mmproj "models\lmstudio-community\Qwen3-VL-4B-Instruct-GGUF\mmproj-Qwen3-VL-4B-Instruct-F16.gguf" ^
  -ngl 99 ^
  -c 8192 ^
  --flash-attn on ^
  --host 127.0.0.1 ^
  --port 8081 ^
  --image-min-tokens 1024 ^
  --alias qwen3-vl-4b,default

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] llama-server exited with error code %errorlevel%.
    pause
)
