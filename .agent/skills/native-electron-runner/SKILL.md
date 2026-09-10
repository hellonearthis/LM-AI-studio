---
name: native-electron-runner
description: Execute Node and SQLite maintenance scripts inside the Electron runtime to resolve native module ABI version mismatches (e.g. better-sqlite3, sharp). Use when running database migrations, inspecting images.db, executing electron-rebuild, or debugging native dependency errors between Node.js and Electron.
---

# Native Electron Runner Skill

A workflow skill for running maintenance scripts, schema migrations, and diagnostic checks in projects with Electron-compiled native C++ modules.

---

## Background & The ABI Problem

Native addons (such as `better-sqlite3` and `sharp`) are compiled against a specific Application Binary Interface (ABI) version. In this project:
- The system Node.js uses `NODE_MODULE_VERSION 141`.
- Electron uses `NODE_MODULE_VERSION 130`.

Attempting to run scripts using `node -e "..."` or `node script.js` causes `ERR_DLOPEN_FAILED`. All operations accessing `better-sqlite3` or `images.db` from scripts must either:
1. Run using Python's standard `sqlite3` library, or
2. Run through the Electron executable harness (`npx electron -e "..."`).

---

## Workflow: Executing Operations

### Option A: Using the Bundled Electron Runner
Run JavaScript files or inline code snippets using the bundled runner:
```bash
python .agent/skills/native-electron-runner/scripts/run_in_electron.py "const Database = require('better-sqlite3'); const db = new Database('images.db'); console.log(db.prepare('SELECT count(*) FROM images').get()); process.exit(0);"
```

### Option B: Using Python for SQLite Maintenance
For fast, standalone database inspections and migrations that do not require Node packages:
```bash
python -c "import sqlite3; con = sqlite3.connect('images.db'); print(con.execute('SELECT count(*) FROM images').fetchone()[0])"
```

### Option C: Rebuilding Native Modules
If dependencies are updated in `package.json`:
```bash
npx electron-rebuild -f -w better-sqlite3
```
Always verify after rebuilding that the main application starts cleanly via `.\Start App.bat` or `npm start`.
