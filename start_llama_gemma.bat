@echo off
title "llama-server (LM AI Studio Google Gemma / PaliGemma on Port 8081)"

:: ============================================================================
:: WHAT: Launch script for llama-server.exe configured for Google Gemma / PaliGemma.
:: WHY: Enables 1-click startup of Google Gemma vision models with GPU offloading,
::      Flash Attention, and automatic discovery by LM AI Studio on port 8081.
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
echo Model Family: Google Gemma / PaliGemma Vision
echo ======================================================================

:: Default model check (adjust GGUF filename to match your downloaded Gemma model)
llama-server.exe ^
  -m "models\google\paligemma-3b-pt-448.Q4_K_M.gguf" ^
  --mmproj "models\google\paligemma-3b-pt-448-mmproj-f16.gguf" ^
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

