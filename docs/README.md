# Application Documentation

This directory contains detailed documentation for each page in the **Lumina - AI Image Analysis Studio** application.

## User Interface Guides
- [**Analysis Page** (`index.md`)](./index.md): The main interface for uploading and analyzing images.
- [**Database Page** (`database.md`)](./database.md): Manage your library, perform batch actions, and edit metadata.
- [**Search Page** (`search.md`)](./search.md): Advanced search capabilities including keyword and semantic search.
- [**Tags Page** (`tags.md`)](./tags.md): Explore your collection via tags and objects.
- [**Data Map Page** (`scope.md`)](./scope.md): Visualize your image library in a semantic 2D space.
- [**Settings Page** (`settings.md`)](./settings.md): Configure AI models and system preferences.

## Backend Subsystem Overviews
- [**Root Readme** (`../README.md`)](../README.md): Full application overview, Quick Start with `Start App.bat`, and deep-dives on **llama.cpp** and **Laya**.
- [**Search Architecture** (`../readme_search.md`)](../readme_search.md): Hybrid search architecture combining Fuse.js, vector embeddings via `llama-server` (Port 8081), and fast query intent analysis via `Laya` (Port 8765).
- [**Database Schema** (`../images_db_readme.md`)](../images_db_readme.md): SQLite schema specifications covering `images`, `image_facets` (Laya classification), `image_clusters`, and `image_coordinates`.

