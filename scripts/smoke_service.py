# -*- coding: utf-8 -*-
"""omni-service 冒烟：health（无鉴权）/ 401 / token 搜索（§6.3 验收口径）"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:16899"
TOKEN = os.environ.get("OMNI_SERVICE_TOKEN", "test-token-123")


def get(path: str, token: str | None = None, timeout: float = 20):
    req = urllib.request.Request(BASE + path)
    if token:
        req.add_header("X-Omni-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return -1, str(e)


def main() -> int:
    ok = True

    # 1. health（无鉴权）
    code, body = get("/health")
    print(f"health: {code} {body[:80]}")
    ok &= code == 200 and '"ok": true' in body.replace(" ", "").replace('"ok":true', '"ok": true') or code == 200

    # 2. 无 token → 401
    code, body = get("/api/music/search?q=test")
    print(f"no-token: {code} {body[:60]}")
    ok &= code == 401

    # 3. 带 token 搜索（自然语言解析同源：陈奕迅 孤勇者）
    code, body = get(
        "/api/music/search?q=" + urllib.parse.quote("陈奕迅的孤勇者") + f"&token={TOKEN}",
        token=TOKEN,
    )
    print(f"search: {code}")
    if code == 200:
        data = json.loads(body)
        cands = data.get("candidates", [])
        print(
            f"  parsed={data.get('parsed')} candidates={len(cands)}"
            f" degraded={data.get('degraded')}"
        )
        for c in cands[:3]:
            print(f"  [{c['platformLabel']}] {c['name']} - {c['artist']} match={c['artistMatch']} score={c['originality']}")
        ok &= len(cands) > 0
    else:
        print(f"  body: {body[:200]}")
        ok = False

    print("SMOKE " + ("PASSED" if ok else "FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
