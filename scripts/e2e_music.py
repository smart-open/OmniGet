# -*- coding: utf-8 -*-
"""omni-service 真实下载端到端：POST download → 轮询 task → 校验 mp3/lrc 落盘（M2-3/M2-4）"""
import json
import os
import sys
import tempfile
import time
import urllib.request

BASE = "http://127.0.0.1:16899"
TOKEN = "e2e-token"


def post(path: str, body: dict) -> tuple[int, dict]:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-Omni-Token": TOKEN},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status, json.loads(resp.read())


def get_task(task_id: str) -> dict:
    req = urllib.request.Request(
        BASE + f"/api/music/task/{task_id}", headers={"X-Omni-Token": TOKEN}
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def main() -> int:
    save_dir = os.path.join(tempfile.gettempdir(), "omniget-e2e-music")
    os.makedirs(save_dir, exist_ok=True)

    code, data = post(
        "/api/music/download",
        {"q": "刘德华的忘情水", "quality": "high", "saveDir": save_dir},
    )
    print(f"POST download: {code} {data}")
    if code != 202:
        return 1
    task_id = data["taskId"]

    deadline = time.time() + 120
    while time.time() < deadline:
        t = get_task(task_id)
        status = t.get("status")
        print(f"  [{time.strftime('%H:%M:%S')}] {status} pipeline={t.get('pipeline')}")
        if status in ("completed", "failed"):
            result = t.get("result", {})
            print(f"  result: {json.dumps(result, ensure_ascii=False)[:300]}")
            if status == "completed":
                mp3 = result.get("mp3Path", "")
                lrc = result.get("lrcPath", "")
                mp3_ok = mp3 and os.path.exists(mp3) and os.path.getsize(mp3) >= 1_500_000
                lrc_ok = lrc and os.path.exists(lrc)
                print(f"  mp3>=1.5MB: {mp3_ok} ({os.path.getsize(mp3) if mp3 and os.path.exists(mp3) else 0} bytes)")
                print(f"  lrc exists: {lrc_ok}")
                print("E2E " + ("PASSED" if mp3_ok and lrc_ok else "FAILED"))
                return 0 if mp3_ok and lrc_ok else 1
            print("E2E FAILED")
            return 1
        time.sleep(3)
    print("E2E FAILED (timeout)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
