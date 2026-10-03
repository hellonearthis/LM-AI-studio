@echo off
title "llama-server (Text Embeddings on Port 8083)"

:: WHAT: Launch script for llama-server.exe dedicated to Nomic text embeddings on port 8083.
:: WHY: Provides fast vector embedding generation for semantic search using llama.cpp with GPU offload.

set "LLAMA_DIR=C:\llamaCPP"

if not exist "%LLAMA_DIR%\llama-server.exe" (
    echo [ERROR] llama-server.exe not found in %LLAMA_DIR%.
    pause
    exit /b 1
)

cd /d "%LLAMA_DIR%"

echo ======================================================================
echo Starting llama-server for Text Embeddings on port 8083...
echo Model: Nomic Embed Text v1.5 (F16)
echo ======================================================================

llama-server.exe ^
  -m "models\nomic-ai\nomic-embed-text-v1.5-GGUF\nomic-embed-text-v1.5.f16.gguf" ^
  --embedding ^
  -ngl 99 ^
  -c 2048 ^
  --host 127.0.0.1 ^
  --port 8083 ^
  --alias nomic-embed-text-v1.5,default-embed

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] llama-server embeddings exited with error code %errorlevel%.
    pause
)
