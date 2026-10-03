@echo off
title "Lumina EVoC + UMAP Projector (Ovis Embeddings)"

:: WHAT: Projects Ovis 2048-dim visual embeddings onto a 2D canvas and clusters them using EVoC.
:: WHY: Enables the interactive starfield Map (scope.html) to render 11,452 images grouped by visual appearance.

cd /d "%~dp0"
echo ======================================================================
echo Projecting Ovis-Omni Multimodal Embeddings to 2D Map (images.db)...
echo ======================================================================

if exist ".\venv\Scripts\python.exe" (
    ".\venv\Scripts\python.exe" scripts/evoc_pipeline.py --embeddings public/ovis-embeddings.json --db images.db
) else (
    python scripts/evoc_pipeline.py --embeddings public/ovis-embeddings.json --db images.db
)

echo.
echo ======================================================================
echo Map coordinates and clusters updated successfully!
echo Open Lumina -> Map (scope.html) -> Select "Evoc DB" to view your galaxy.
echo ======================================================================
pause
