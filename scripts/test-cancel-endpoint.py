# 取消端点单测（TestClient）：标记/幂等/404/鉴权
import os
os.environ.setdefault("OMNI_SERVICE_TOKEN", "testtoken")
import sys
sys.path.insert(0, "service")
from fastapi.testclient import TestClient
import importlib
import main as service_main

importlib.reload(service_main)
client = TestClient(service_main.app)
H = {"X-Omni-Token": "testtoken"}

# 404
r = client.post("/api/music/task/nope/cancel", headers=H)
assert r.status_code == 404, r.status_code

# running → cancelling
service_main.TASKS["t1"] = {"id": "t1", "status": "running"}
r = client.post("/api/music/task/t1/cancel", headers=H)
assert r.status_code == 200 and r.json()["ok"] is True
assert service_main.TASKS["t1"]["status"] == "cancelling"

# 幂等：再次取消返回 ok=False
r = client.post("/api/music/task/t1/cancel", headers=H)
assert r.json()["ok"] is False

# 无 token → 401
r = client.post("/api/music/task/t1/cancel")
assert r.status_code == 401

print("CANCEL-ENDPOINT-OK")
