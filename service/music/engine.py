# -*- coding: utf-8 -*-
"""
omni-service 引擎包装层（M2-3/M2-5）
- 逻辑不重写：直接 import 移植的 batch_download_v4.MusicDownloader（§4.4）
- 聚合搜索：五平台候选 + 原唱校验 + 原版度打分（继承脚本口径）
- M2-5 同平台串行化：按 host 门控（锁 + 最小 1s 间隔），防平台风控
"""

import importlib.util
import io
import sys
import tempfile
import threading
import time
import re
from pathlib import Path
from typing import Callable, Optional

# GBK 控制台防护：引擎日志含 Unicode 符号，Windows cp936 会 UnicodeEncodeError 崩溃下载线程
for _stream in (sys.stdout, sys.stderr):
    if _stream and hasattr(_stream, "buffer"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

_ENGINE_PATH = Path(__file__).parent / "batch_download_v4.py"
_spec = importlib.util.spec_from_file_location("batch_download_v4", _ENGINE_PATH)
_batch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_batch)

MusicDownloader = _batch.MusicDownloader

PLATFORMS = ["netease", "qq", "kugou", "migu", "soda"]  # §4.4 五平台回退链顺序
PLATFORM_LABELS = {
    "netease": "网易云",
    "qq": "QQ 音乐",
    "kugou": "酷狗",
    "migu": "咪咕",
    "soda": "汽水",
    "cached": "缓存",
}


def parse_query(q: str) -> tuple[str, str]:
    """自然语言解析（与脚本解析器同源口径）：
    '陈奕迅的孤勇者' / '陈奕迅,孤勇者' / '陈奕迅 - 孤勇者' / '陈奕迅 孤勇者'
    """
    q = q.strip()
    for sep in ("的", " - ", "-", ",", "，", "、"):
        if sep in q:
            artist, song = q.split(sep, 1)
            artist, song = artist.strip(), song.strip()
            if artist and song:
                return artist, song
    parts = q.split(None, 1)
    if len(parts) == 2:
        return parts[0].strip(), parts[1].strip()
    return "", q


class HostGate:
    """M2-5：同 host 请求串行化 + 最小间隔 1s（§4.5 防风控）"""

    def __init__(self, min_interval: float = 1.0):
        self.min_interval = min_interval
        self._locks: dict[str, threading.Lock] = {}
        self._last: dict[str, float] = {}
        self._global = threading.Lock()

    def _lock_for(self, host: str) -> threading.Lock:
        with self._global:
            if host not in self._locks:
                self._locks[host] = threading.Lock()
            return self._locks[host]

    def wait(self, host: str) -> None:
        lock = self._lock_for(host)
        with lock:
            now = time.monotonic()
            elapsed = now - self._last.get(host, 0.0)
            if elapsed < self.min_interval:
                time.sleep(self.min_interval - elapsed)
            self._last[host] = time.monotonic()


# D4 TLS 策略（审查决策记录）：默认全量证书校验；仅第三方歌词/直链镜像域例外
# （这些镜像证书链经常残缺，且内容为公开音频流、无敏感数据；官方 API 域不在名单内）
VERIFY_DISABLED_HOSTS = {
    "music.126.net",  # 网易云音频 CDN 镜像
    "cenguigui.cn",
    "rrvenn.cn",
    "toubiec.cn",
    "haitangw.com",
}


def _mirror_like(host: str) -> bool:
    for h in VERIFY_DISABLED_HOSTS:
        if host == h or host.endswith("." + h):
            return True
    return False


class MusicEngine:
    def __init__(self):
        self._gate = HostGate(1.0)
        # B2：搜索实例共用固定临时目录（不再污染 cwd）
        self._search_dir = Path(tempfile.gettempdir()) / "omniget-search"

    def _make_downloader(self, save_dir: str, on_event: Optional[Callable] = None):
        dl = MusicDownloader(output_dir=save_dir, delay=1.0, log_file="omniget_download_log.txt")
        # M2-5：按 host 串行化该实例的全部 HTTP 请求
        # D4：默认证书校验，仅镜像域豁免（TLS 策略化）
        original_request = dl.session.request
        dl.session.verify = True

        def gated_request(method, url, **kwargs):
            host = re.match(r"[a-z]+://([^/]+)/", str(url))
            if host:
                h = host.group(1).lower()
                self._gate.wait(h)
                if "verify" not in kwargs and _mirror_like(h):
                    kwargs["verify"] = False
            return original_request(method, url, **kwargs)

        dl.session.request = gated_request

        if on_event:
            # 聚合层进度回调：包装五平台尝试入口，产出 music.progress / music.warning 事件
            original_try = dl._try_all_platforms

            def emit(kind: str, platform: str, message: str):
                try:
                    on_event({"type": kind, "platform": platform, "message": message})
                except Exception:
                    pass

            def try_all_with_events(singer, song_name, mp3_path, lrc_path, quality):
                for p in PLATFORMS:
                    emit("progress", p, f"尝试 {PLATFORM_LABELS[p]}…")
                    fn = getattr(dl, f"_try_{p}_robust", None)
                    if fn and fn(singer, song_name, mp3_path, lrc_path, quality):
                        emit("platform-ok", p, f"{PLATFORM_LABELS[p]} 下载成功")
                        # 返回结构必须与原 _try_all_platforms 一致（含 mp3_path/lrc_path）
                        return {
                            "success": True,
                            "source": PLATFORM_LABELS.get(p, p),
                            "mp3_path": str(mp3_path),
                            "lrc_path": str(lrc_path),
                            "message": f"{PLATFORM_LABELS.get(p, p)}: {song_name}",
                        }
                    emit("progress", p, f"{PLATFORM_LABELS[p]} 未命中")
                return {"success": False, "message": "所有平台均无法下载"}

            dl._try_all_platforms = try_all_with_events
        return dl

    # ── 聚合搜索（§4.4 GET /api/music/search）────────────────────────
    def search(self, q: str, limit: int = 8) -> dict:
        artist, song = parse_query(q)
        keyword = f"{artist} {song}".strip() or q
        dl = MusicDownloader(output_dir=str(self._search_dir))
        candidates: list[dict] = []
        degraded: list[str] = []

        for platform in PLATFORMS:
            fn = getattr(dl, f"_search_{platform}", None)
            if not fn:
                continue
            try:
                rows = fn(keyword, limit=limit) or []
            except Exception:
                rows = []
            if not rows:
                degraded.append(platform)
                continue
            for row in rows[:limit]:
                name = row.get("name", "")
                row_artist = row.get("artist", "")
                artist_match = bool(
                    _batch.MusicDownloader._artist_matches(row_artist, artist)
                ) if artist else True
                score = _batch.MusicDownloader._score_originality(name, song)
                candidates.append(
                    {
                        "platform": platform,
                        "platformLabel": PLATFORM_LABELS.get(platform, platform),
                        "id": str(row.get("id", "")),
                        "name": name,
                        "artist": row_artist,
                        "artistMatch": artist_match,
                        "originality": score,
                    }
                )

        # 原唱命中优先，原版度降序（Live/DJ/伴奏扣分）
        candidates.sort(key=lambda c: (not c["artistMatch"], -c["originality"]))
        return {
            "query": q,
            "parsed": {"artist": artist, "song": song},
            "candidates": candidates[: limit * 2],
            "degraded": degraded,  # 搜索降级平台（UI 黄条）
        }

    # ── 下载（POST /api/music/download）─────────────────────────────
    def download(
        self,
        artist: str,
        song: str,
        quality: str = "high",
        save_dir: str = "",
        on_event: Optional[Callable] = None,
    ) -> dict:
        if not artist or not song:
            artist, song = parse_query(f"{artist} {song}".strip() or song)
        dl = self._make_downloader(save_dir, on_event)
        result = dl.download(artist, song, output_dir=save_dir, quality=quality)
        # 归一化返回（供 REST/WS 消费）
        out = {
            "success": bool(result.get("success")),
            "source": result.get("source", ""),
            "message": result.get("message", ""),
            "mp3Path": result.get("mp3_path", ""),
            "lrcPath": result.get("lrc_path", ""),
        }
        if out["success"] and out["mp3Path"] and Path(out["mp3Path"]).exists():
            out["bytes"] = Path(out["mp3Path"]).stat().st_size
        return out

    def download_by_id(
        self,
        netease_id: str,
        artist: str = "",
        song: str = "",
        quality: str = "high",
        save_dir: str = "",
        on_event: Optional[Callable] = None,
    ) -> dict:
        dl = self._make_downloader(save_dir, on_event)
        result = dl.download_by_id(netease_id, artist, song, output_dir=save_dir, quality=quality)
        out = {
            "success": bool(result.get("success")),
            "source": result.get("source", ""),
            "message": result.get("message", ""),
            "mp3Path": result.get("mp3_path", ""),
            "lrcPath": result.get("lrc_path", ""),
        }
        if out["success"] and out["mp3Path"] and Path(out["mp3Path"]).exists():
            out["bytes"] = Path(out["mp3Path"]).stat().st_size
        return out

    # ── 试听（F1，§7.6）：取网易云试听直链（服务端流式代理，供 <audio> 播放）──
    def preview_url(self, platform: str, sid: str, quality: str = "standard") -> Optional[str]:
        if platform != "netease" or not sid:
            return None
        dl = MusicDownloader(output_dir=str(self._search_dir))
        url = dl._netease_url_haitangw(sid, quality)
        if url and url.startswith("http"):
            return url
        return None


_engine: Optional[MusicEngine] = None


def get_engine() -> MusicEngine:
    global _engine
    if _engine is None:
        _engine = MusicEngine()
    return _engine
