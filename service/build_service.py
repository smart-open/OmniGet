# -*- coding: utf-8 -*-
"""omni-service 打包脚本（M2-2）：PyInstaller onefile。

用法：
  pip install pyinstaller
  python service/build_service.py

产物复制到 resources/engines/<platform>/omni-service(.exe)，SHA256 指纹由
主进程 TOFU（orchestrator/binaries.ts）首启记录。

杀软误报应对（§11 风险 #4，决策记录）：
  1. onefile 误报 → 切 onedir（--onedir 产物目录整体分发）
  2. 提交微软误报申诉（https://www.microsoft.com/en-us/wdsi/filesubmission）
  3. 代码签名后误报率显著下降
"""

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent


def main() -> int:
    onefile = "--onedir" not in sys.argv
    mode = ["--onefile"] if onefile else ["--onedir"]
    out = ROOT / "dist" / ("onefile" if onefile else "onedir")
    cmd = [
        sys.executable, "-m", "PyInstaller",
        *mode,
        "--name", "omni-service",
        "--distpath", str(out),
        "--workpath", str(ROOT / "build" / "pyinstaller"),
        "--specpath", str(ROOT / "build" / "pyinstaller"),
        "--clean",
        # 静态分析路径（music 包 + 引擎脚本）
        "--paths", str(ROOT / "service"),
        "--paths", str(ROOT / "service" / "music"),
        "--hidden-import", "music.engine",
        # batch_download_v4.py 为 importlib 动态加载，其依赖不在静态分析内 → 显式收集
        "--collect-all", "requests",
        "--collect-all", "certifi",
        "--collect-all", "urllib3",
        "--hidden-import", "uvicorn.logging",
        "--hidden-import", "uvicorn.loops.auto",
        "--hidden-import", "uvicorn.loops.asyncio",
        "--hidden-import", "uvicorn.protocols.http.auto",
        "--hidden-import", "uvicorn.protocols.http.h11_impl",
        "--hidden-import", "uvicorn.protocols.websockets.auto",
        "--hidden-import", "uvicorn.protocols.websockets.wsproto_impl",
        "--hidden-import", "uvicorn.lifespan.on",
        # engine.py 经 importlib 动态加载 batch_download_v4.py → 必须作为数据打入
        "--add-data",
        str(ROOT / "service" / "music" / "batch_download_v4.py")
        + (";music" if os.name == "nt" else ":music"),
        str(ROOT / "service" / "main.py"),
    ]
    print(" ".join(cmd))
    return subprocess.call(cmd)


if __name__ == "__main__":
    sys.exit(main())
