@echo off
title "llama-server (Image Analysis Studio Google Gemma on Port 8081)"

:: ============================================================================
:: WHAT: Launch script for llama-server.exe configured for Google Gemma / PaliGemma.
:: WHY: Enables 1-click startup of Google Gemma vision models with GPU offloading,
::      Flash Attention, and automatic discovery by Image Analysis Studio on port 8081.
:: ============================================================================

set "LLAMA_DIR=I:\llamaCPP"

if not exist "%LLAMA_DIR%\llama-server.exe" (
    echo [ERROR] llama-server.exe not found in %LLAMA_DIR%.
    echo Please ensure llama.cpp is installed in %LLAMA_DIR% or update this script with your installation path.
    pause
    exit /b 1
)

cd /d "%LLAMA_DIR%"

echo ======================================================================
echo Starting llama-server for Image Analysis Studio on port 8081...
echo Model Family: Google Gemma 4 Vision
echo ======================================================================

:: Default model check (adjust GGUF filename if switching Gemma 4 variants)
llama-server.exe ^
  -m "models\gemma-4-12B-it-GGUF\gemma-4-12B-it-Q4_K_M.gguf" ^
  --mmproj "models\gemma-4-12B-it-GGUF\mmproj-gemma-4-12B-it-BF16.gguf" ^
  -ngl 99 ^
  -c 4096 ^
  --flash-attn on ^
  --host 127.0.0.1 ^
  --port 8081 ^
  --alias gemma,paligemma,default

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] llama-server exited with error code %errorlevel%.
    pause
)

