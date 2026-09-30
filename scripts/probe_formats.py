# -*- coding: utf-8 -*-
"""B 站 formats 原始结构探针"""
import json
import subprocess

out = subprocess.run(
    ["resources/engines/win32-x64/yt-dlp.exe", "-J", "--no-playlist",
     "https://www.bilibili.com/video/BV1GJ411x7h7/"],
    capture_output=True, text=True, encoding="utf-8", timeout=90,
)
if out.returncode != 0:
    print("stderr:", out.stderr[:500])
    raise SystemExit(1)
d = json.loads(out.stdout)
fs = d.get("formats", [])
print("count:", len(fs))
for f in fs[:14]:
    print(f.get("format_id"), "|", f.get("ext"), "|", f.get("vcodec"), "|",
          f.get("acodec"), "|", f.get("protocol"), "|", f.get("height"))
