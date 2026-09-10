#!/usr/bin/env python3
"""
WHAT: Wrapper utility executing JavaScript scripts inside Electron's Node runtime.
WHY: Native dependencies like better-sqlite3 are compiled against Electron's ABI version.
Running scripts directly via the system 'node' command throws ERR_DLOPEN_FAILED version
mismatch errors. Running through Electron ensures ABI compatibility.
"""

import subprocess
import sys
from pathlib import Path

def execute_javascript_in_electron_environment(javascript_code_snippet_or_file_path):
    is_existing_file = Path(javascript_code_snippet_or_file_path).is_file()
    
    if is_existing_file:
        command_arguments = ['npx.cmd' if sys.platform == 'win32' else 'npx', 'electron', javascript_code_snippet_or_file_path]
    else:
        command_arguments = ['npx.cmd' if sys.platform == 'win32' else 'npx', 'electron', '-e', javascript_code_snippet_or_file_path]

    print(f"[ELECTRON-RUNNER] Executing command: {' '.join(command_arguments)}")
    execution_result = subprocess.run(command_arguments, capture_output=True, text=True)
    
    if execution_result.stdout:
        print("[STDOUT]\n" + execution_result.stdout)
    if execution_result.stderr:
        print("[STDERR]\n" + execution_result.stderr, file=sys.stderr)
        
    return execution_result.returncode == 0

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python run_in_electron.py <script_path_or_inline_javascript_code>")
        sys.exit(1)
    
    execution_success_boolean = execute_javascript_in_electron_environment(sys.argv[1])
    sys.exit(0 if execution_success_boolean else 1)
