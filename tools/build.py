"""Embed google/panel.html into google/Code.gs (one file to paste into Apps Script).

Usage: python3 tools/build.py
"""
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parent.parent
code = root / "google" / "Code.gs"
html = (root / "google" / "panel.html").read_text(encoding="utf-8")
src = code.read_text(encoding="utf-8")
line = "var PANEL_HTML = /*PANEL_HTML*/ " + json.dumps(html, ensure_ascii=False) + ";"
new, n = re.subn(r"^var PANEL_HTML = /\*PANEL_HTML\*/ .*;$", lambda m: line, src, flags=re.M)
assert n == 1, "PANEL_HTML line not found"
code.write_text(new, encoding="utf-8")
print("Code.gs updated,", len(new), "characters")
