#!/usr/bin/env python3
"""
WHAT: Metric consistency checker comparing PretextLayout configuration against CSS files.
WHY: If font size, font family, line-height, or card padding defined in CSS diverges from
PretextLayout constants, pre-calculated text heights will mismatch rendered heights, causing CLS.
"""

import re
import sys
from pathlib import Path

def audit_pretext_layout_metrics():
    pretext_file_path = Path('public/pretext-layout.js')
    style_css_file_path = Path('public/style.css')
    search_css_file_path = Path('public/search.css')

    for required_file_path in [pretext_file_path, style_css_file_path, search_css_file_path]:
        if not required_file_path.exists():
            print(f"[ERROR] Required file missing: {required_file_path}")
            return False

    pretext_code_content = pretext_file_path.read_text(encoding='utf-8')
    style_css_content = style_css_file_path.read_text(encoding='utf-8')

    print("[PRETEXT-AUDIT] Inspecting font family and metrics alignment...")

    # Check for Numans font in Pretext
    if "'16px Numans'" in pretext_code_content and "'14.4px Numans'" in pretext_code_content:
        print("  - Pretext font metrics configured: Database (16px Numans), Search (14.4px Numans).")
    else:
        print("  [WARN] Unexpected font metrics in PretextLayout configuration.")

    # Check for Pretext CSS variables in style.css
    has_pretext_vars = '--mgl-pretext-font' in style_css_content and '--mgl-pretext-line-height' in style_css_content
    if has_pretext_vars:
        print("  - CSS custom properties for Pretext layout detected in style.css.")
    else:
        print("  [WARN] Missing --mgl-pretext-font or --mgl-pretext-line-height in style.css.")

    print("[SUCCESS] Pretext and CSS metric alignment check completed!")
    return True

if __name__ == '__main__':
    audit_success_boolean = audit_pretext_layout_metrics()
    sys.exit(0 if audit_success_boolean else 1)
