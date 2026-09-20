@echo off
title "llama-server (LM AI Studio Vision on Port 8080)"

:: WHAT: Launch script for llama-server.exe configured for LM AI Studio.
:: WHY: Provides 1-click startup with GPU offloading, Flash Attention, multimodal vision projector,
::      and clean model aliases so LM AI Studio discovers and binds to it automatically.

set "LLAMA_DIR=C:\llamaCPP"

if not exist "%LLAMA_DIR%\llama-server.exe" (
    echo [ERROR] llama-server.exe not found in %LLAMA_DIR%.
    echo Please ensure llama.cpp is installed in %LLAMA_DIR% or update this script with your installation path.
    pause
    exit /b 1
)

cd /d "%LLAMA_DIR%"

echo ======================================================================
echo Starting llama-server for LM AI Studio on port 8080...
echo Model: Qwen 3.5 9B with Multimodal Vision Projector
echo ======================================================================

llama-server.exe ^
  -m "models\lmstudio-community\Qwen3.5-9B-GGUF\Qwen3.5-9B-Q4_K_M.gguf" ^
  --mmproj "models\lmstudio-community\Qwen3.5-9B-GGUF\mmproj-Qwen3.5-9B-BF16.gguf" ^
  -ngl 99 ^
  -c 8192 ^
  --flash-attn on ^
  --host 127.0.0.1 ^
  --port 8080 ^
  --image-min-tokens 1024 ^
  --reasoning off ^
  --reasoning-budget 0 ^
  --alias qwen3.5-9b,default

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] llama-server exited with error code %errorlevel%.
    pause
)
