@echo off
title "Ovis-Omni Dataset and Database Pipeline Runner"

:: WHAT: Launch script for the Ovis-Omni dataset vectorization and facet classification pipeline.
:: WHY: Native module 'better-sqlite3' was compiled against Electron (NODE_MODULE_VERSION 130).
::      Setting ELECTRON_RUN_AS_NODE=1 directs Electron to execute the script in Node mode,
::      ensuring perfect ABI binary compatibility with images.db without recompilation errors.

set "ELECTRON_RUN_AS_NODE=1"
set "PROJECT_ROOT_DIRECTORY=%~dp0"

cd /d "%PROJECT_ROOT_DIRECTORY%"

npx electron scripts/run_ovis_pipeline.js %*
