# -*- coding: utf-8 -*-
"""
omni-service（M2-1/M2-4，§4.4/§6.2/§6.3）
- FastAPI + uvicorn，仅绑定 127.0.0.1；端口/调用方 token 经环境变量注入（§9）
- GET  /health（无鉴权心跳）
- GET  /api/music/search?q=
- POST /api/music/download {q|artist+song, quality, saveDir}
- POST /api/music/download-by-id {neteaseId, artist, song, quality, saveDir}
- GET  /api/music/task/{id}
- WS   /ws/events?token=  → music.progress / music.done / music.warning
"""

import asyncio
import os
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

# 保证 service/ 与 service/music/ 可导入
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent / "music"))

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse

from music.engine import get_engine, parse_query, PLATFORM_LABELS, _mirror_like

OMNI_TOKEN = os.environ.get("OMNI_SERVICE_TOKEN", "")
if not OMNI_TOKEN:
    print("[omni-service] FATAL: OMNI_SERVICE_TOKEN not set", flush=True)
    sys.exit(1)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """C3：lifespan 取代已废弃的 on_event；捕获主循环供线程投递 WS 广播"""
    import asyncio

    app.state.loop = asyncio.get_running_loop()
    yield


app = FastAPI(title="omni-service", docs_url=None, redoc_url=None, lifespan=lifespan)
engine = get_engine()

# 任务注册表：service task id → 状态
TASKS: dict[str, dict] = {}
TASKS_LOCK = threading.Lock()
WS_CLIENTS: set[WebSocket] = set()
WS_LOCK = threading.Lock()


def verify_token(token: str) -> bool:
    return bool(OMNI_TOKEN) and token == OMNI_TOKEN


def require_token(token: str) -> None:
    if not verify_token(token):
        raise HTTPException(status_code=401, detail="unauthorized")


# ── D6 简单限流：每 token 5s 窗口最多 30 次（回环服务，防误用即可）────

_RATE: dict[str, tuple[float, int]] = {}
_RATE_LOCK = threading.Lock()
_RATE_WINDOW = 5.0
_RATE_MAX = 30


def check_rate(key: str) -> bool:
    now = time.monotonic()
    with _RATE_LOCK:
        start, count = _RATE.get(key, (now, 0))
        if now - start > _RATE_WINDOW:
            _RATE[key] = (now, 1)
            return True
        if count >= _RATE_MAX:
            return False
        _RATE[key] = (start, count + 1)
        return True


async def broadcast(event: dict) -> None:
    """向全部 WS 客户端推送事件（music.progress / music.done / music.warning）"""
    import json

    payload = json.dumps(event, ensure_ascii=False)
    dead = []
    with WS_LOCK:
        clients = list(WS_CLIENTS)
    for ws in clients:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)
    if dead:
        with WS_LOCK:
            for ws in dead:
                WS_CLIENTS.discard(ws)


def emit(task_id: str, kind: str, platform: str = "", message: str = ""):
    """线程内同步入口：登记任务状态 + 投递 WS 事件"""
    with TASKS_LOCK:
        task = TASKS.get(task_id)
        if task is None:
            return
        if kind == "progress":
            task["status"] = "running"
            task["pipeline"] = platform
        elif kind == "platform-ok":
            task["pipeline"] = platform
        elif kind == "warning":
            task.setdefault("warnings", []).append(message)
    import asyncio

    loop = app.state.loop
    payload = {
        "type": ("music.warning" if kind == "warning" else "music.progress"),
        "taskId": task_id,
        "platform": platform,
        "platformLabel": PLATFORM_LABELS.get(platform, platform),
        "message": message,
    }
    loop.call_soon_threadsafe(asyncio.ensure_future, broadcast(payload))


def run_download(task_id: str, kwargs: dict):
    """下载线程：engine.download / download_by_id 的结果回收进 TASKS 并广播 music.done"""

    def on_event(ev: dict):
        emit(task_id, ev.get("type", "progress"), ev.get("platform", ""), ev.get("message", ""))

    try:
        if "netease_id" in kwargs:
            result = engine.download_by_id(on_event=on_event, **kwargs)
        else:
            result = engine.download(on_event=on_event, **kwargs)
        with TASKS_LOCK:
            task = TASKS.get(task_id)
            cancelled = task is not None and task.get("status") == "cancelling"
            if task is not None:
                task["result"] = result
                if cancelled:
                    task["status"] = "cancelled"
                else:
                    task["status"] = "completed" if result.get("success") else "failed"
        # 取消：引擎线程无法中断（阻塞库调用），完成后删除已落盘产物
        if cancelled:
            for key in ("mp3Path", "lrcPath"):
                p = result.get(key)
                if p:
                    try:
                        Path(p).unlink(missing_ok=True)
                    except OSError:
                        pass
            payload = {
                "type": "music.done",
                "taskId": task_id,
                "success": False,
                "cancelled": True,
                "message": "任务已取消",
            }
            loop = app.state.loop
            loop.call_soon_threadsafe(asyncio.ensure_future, broadcast(payload))
            return
        import asyncio

        payload = {
            "type": "music.done",
            "taskId": task_id,
            "success": result.get("success", False),
            "source": result.get("source", ""),
            "sourceLabel": PLATFORM_LABELS.get(result.get("source", ""), result.get("source", "")),
            "message": result.get("message", ""),
            "mp3Path": result.get("mp3Path", ""),
            "lrcPath": result.get("lrcPath", ""),
            "bytes": result.get("bytes", 0),
        }
        loop = app.state.loop
        loop.call_soon_threadsafe(asyncio.ensure_future, broadcast(payload))
    except Exception as exc:  # 引擎异常不崩服务
        with TASKS_LOCK:
            task = TASKS.get(task_id)
            if task is not None:
                task["status"] = "failed"
                task["result"] = {"success": False, "message": str(exc)}
        import asyncio

        payload = {
            "type": "music.done",
            "taskId": task_id,
            "success": False,
            "message": str(exc),
        }
        loop = app.state.loop
        loop.call_soon_threadsafe(asyncio.ensure_future, broadcast(payload))


# ── 心跳（无鉴权，§6.2）───────────────────────────────────────────────

@app.get("/health")
def health():
    return {"ok": True, "service": "omni-service", "version": "0.1.0"}


# ── 鉴权依赖（header X-Omni-Token 或 query token，§9）────────────────

from fastapi import Depends, Request  # noqa: E402


async def auth(request: Request, token: str = ""):
    supplied = request.headers.get("X-Omni-Token") or token
    if not verify_token(supplied):
        raise HTTPException(status_code=401, detail="unauthorized")
    if not check_rate(f"ip:{request.client.host if request.client else 'local'}"):
        raise HTTPException(status_code=429, detail="rate limited")


# ── REST（M2-4）───────────────────────────────────────────────────────

@app.get("/api/music/search", dependencies=[Depends(auth)])
def music_search(q: str = Query(..., min_length=1)):
    return engine.search(q)


@app.post("/api/music/download", dependencies=[Depends(auth)])
async def music_download(body: dict):
    artist = (body.get("artist") or "").strip()
    song = (body.get("song") or "").strip()
    q = (body.get("q") or "").strip()
    if not artist and not song and q:
        artist, song = parse_query(q)
    if not song:
        raise HTTPException(status_code=400, detail="song required")
    save_dir = body.get("saveDir") or str(Path.cwd() / "music_download")
    quality = body.get("quality") or "high"
    task_id = uuid.uuid4().hex
    with TASKS_LOCK:
        TASKS[task_id] = {
            "id": task_id,
            "status": "queued",
            "artist": artist,
            "song": song,
            "quality": quality,
            "saveDir": save_dir,
            "pipeline": "",
            "warnings": [],
        }
    threading.Thread(
        target=run_download,
        args=(task_id, {"artist": artist, "song": song, "quality": quality, "save_dir": save_dir}),
        daemon=True,
    ).start()
    return JSONResponse(status_code=202, content={"taskId": task_id, "status": "queued"})


@app.post("/api/music/download-by-id", dependencies=[Depends(auth)])
async def music_download_by_id(body: dict):
    netease_id = str(body.get("neteaseId") or "")
    if not netease_id:
        raise HTTPException(status_code=400, detail="neteaseId required")
    save_dir = body.get("saveDir") or str(Path.cwd() / "music_download")
    task_id = uuid.uuid4().hex
    with TASKS_LOCK:
        TASKS[task_id] = {
            "id": task_id,
            "status": "queued",
            "neteaseId": netease_id,
            "artist": body.get("artist", ""),
            "song": body.get("song", ""),
            "quality": body.get("quality") or "high",
            "saveDir": save_dir,
            "pipeline": "netease",
            "warnings": [],
        }
    threading.Thread(
        target=run_download,
        args=(
            task_id,
            {
                "netease_id": netease_id,
                "artist": body.get("artist", ""),
                "song": body.get("song", ""),
                "quality": body.get("quality") or "high",
                "save_dir": save_dir,
            },
        ),
        daemon=True,
    ).start()
    return JSONResponse(status_code=202, content={"taskId": task_id, "status": "queued"})


@app.get("/api/music/task/{task_id}", dependencies=[Depends(auth)])
def music_task(task_id: str):
    with TASKS_LOCK:
        task = TASKS.get(task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        return task


@app.post("/api/music/task/{task_id}/cancel", dependencies=[Depends(auth)])
def music_cancel(task_id: str):
    """协作式取消：标记 cancelling，引擎线程完成后删除产物（阻塞库调用无法强杀）"""
    with TASKS_LOCK:
        task = TASKS.get(task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        if task["status"] in ("completed", "failed", "cancelled", "cancelling"):
            return JSONResponse(status_code=200, content={"ok": False, "status": task["status"]})
        task["status"] = "cancelling"
    return JSONResponse(status_code=200, content={"ok": True, "status": "cancelling"})


# ── 试听预览流（F1，§7.6）：服务端代理镜像音频，<audio> 经 16801 播放 ──

@app.get("/api/music/preview", dependencies=[Depends(auth)])
def music_preview(platform: str = "netease", id: str = "", quality: str = "standard"):
    url = engine.preview_url(platform, id, quality)
    if not url:
        raise HTTPException(status_code=404, detail="preview unavailable for platform")

    import re as _re

    def gen():
        # 镜像域豁免证书校验（与 D4 策略一致）；镜像不稳时静默断流（客户端 onerror 兜底）
        try:
            host_m = _re.match(r"[a-z]+://([^/]+)/", url)
            verify = False if (host_m and _mirror_like(host_m.group(1).lower())) else True
            with engine._make_downloader(
                os.environ.get("TEMP", tempfile.gettempdir())
            ).session.get(url, stream=True, timeout=30, verify=verify) as r:
                r.raise_for_status()
                for chunk in r.iter_content(65536):
                    yield chunk
        except Exception:
            import traceback

            traceback.print_exc(file=sys.stderr)
            return

    return StreamingResponse(gen(), media_type="audio/mpeg")


# ── WS 事件流（§6.3；D5：首帧鉴权，token 不进 URL/日志）──────────────

@app.websocket("/ws/events")
async def ws_events(ws: WebSocket):
    await ws.accept()
    try:
        # D5：首帧必须为 token 帧（连接后立即发送），避免 token 进入 URL
        first = await asyncio.wait_for(ws.receive_text(), timeout=5)
        if not verify_token(first.strip()):
            await ws.close(code=4401)
            return
        with WS_LOCK:
            WS_CLIENTS.add(ws)
        while True:
            # 客户端仅接收；ping 保活
            await ws.receive_text()
    except (WebSocketDisconnect, asyncio.TimeoutError):
        pass
    finally:
        with WS_LOCK:
            WS_CLIENTS.discard(ws)


# ── 入口 ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("OMNI_SERVICE_PORT", "16801"))
    host = os.environ.get("OMNI_SERVICE_HOST", "127.0.0.1")
    print(f"[omni-service] listening on {host}:{port}", flush=True)
    uvicorn.run(app, host=host, port=port, log_level="warning")
