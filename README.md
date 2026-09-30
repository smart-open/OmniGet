# OmniGet

一站式跨平台桌面下载器：BT/磁力（aria2c）、视频（yt-dlp）、音乐（omni-service）、HTTP 直链 + 本地工具箱（ffmpeg）。

技术栈：Electron 33 + Vite + React 18 + TS 严格模式 + Tailwind + better-sqlite3。

## 开发

```bash
npm install          # 若 better-sqlite3/electron 原生二进制下载失败见下方说明
npm run dev          # 三端（main/preload/renderer）开发模式
npm run typecheck    # TS 严格模式类型检查
npm run build        # 生产构建（out/）
npm run dist:win     # Windows NSIS 打包（dist:mac / dist:linux 同理）
```

## 目录

```
src/main/        主进程：编排核心（orchestrator/ 引擎监督、task/ 状态机、db/、integrations/）
src/preload/     contextBridge 白名单桥
src/renderer/    React UI（app/ features/ components/ui stores/ styles/tokens.css）
src/shared/      双端共享类型（任务模型、IPC 通道、错误码表）
resources/engines/   sidecar 二进制（aria2c/yt-dlp/ffmpeg/omni-service，按平台）
service/         omni-service Python 源码（M2）
docs/            产品技术设计文档 + 开发任务计划
```

## Windows 无构建工具链时的原生依赖安装

better-sqlite3 与 electron 均可用预编译产物，无需 MSVC：

```powershell
# better-sqlite3（Electron ABI）
cd node_modules/better-sqlite3; npx prebuild-install -r electron -t <electron版本>; cd ../..
# electron 二进制（GitHub 直连失败时用镜像）
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; node node_modules/electron/install.js
```

## 当前状态（依据 docs/OmniGet-开发任务计划.md）

- [x] T0 工程基建（T0-1 ~ T0-8）
- [x] M1 骨架 + BT/磁力/HTTP（M1-1 ~ M1-12 全部）
- [x] M2 音乐（M2-2 PyInstaller onefile 38.7MB 已验证 + Defender 无检出）
- [x] M3 视频（M3-1 ~ M3-11 全部，yt-dlp/ffmpeg sidecar）
- [x] M4 打磨发布（13/17 完成；🔶 Inspector/更新通道/三平台出包；⏭ 可选悬浮窗暂缓）

## 验证

```bash
npm test                                    # 16 个单测（状态机/torrent/嗅探/事件合并）
npx tsx --tsconfig tsconfig.node.json scripts/e2e-aria2.ts   # aria2 端到端（真实 sidecar）
```
