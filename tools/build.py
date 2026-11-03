"""Embed google/panel.html into google/Code.gs and stamp the system version.

Usage:
  python3 tools/build.py          update Code.gs (panel and SISTEM_SURUMU)
  python3 tools/build.py --check  exit 1 if Code.gs is not up to date

SISTEM_SURUMU is computed from the content of Code.gs (with the panel embedded),
so any change to the code or the panel changes it. The live system compares it
with the version written in the user guide and asks for the guide to be reviewed.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
code = root / "google" / "Code.gs"
html = (root / "google" / "panel.html").read_text(encoding="utf-8")
src = code.read_text(encoding="utf-8")

line = "var PANEL_HTML = /*PANEL_HTML*/ " + json.dumps(html, ensure_ascii=False) + ";"
new, n = re.subn(r"^var PANEL_HTML = /\*PANEL_HTML\*/ .*;$", lambda m: line, src, flags=re.M)
assert n == 1, "PANEL_HTML line not found"

SURUM_RE = r'^var SISTEM_SURUMU = "[0-9a-f]*";.*$'
assert len(re.findall(SURUM_RE, new, flags=re.M)) == 1, "SISTEM_SURUMU line not found"
bos = re.sub(SURUM_RE, 'var SISTEM_SURUMU = "";', new, flags=re.M)
surum = hashlib.sha256(bos.encode("utf-8")).hexdigest()[:12]
new = re.sub(SURUM_RE, lambda m: 'var SISTEM_SURUMU = "' + surum + '"; // tools/build.py hesaplar; elle değiştirilmez.', new, flags=re.M)

if "--check" in sys.argv:
    if new != src:
        print("Code.gs güncel değil: python3 tools/build.py çalıştırılmalı (sistem sürümü " + surum + ").")
        sys.exit(1)
    print("Code.gs güncel, sistem sürümü " + surum)
    sys.exit(0)

code.write_text(new, encoding="utf-8")
print("Code.gs updated, system version", surum)
