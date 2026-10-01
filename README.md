# OmniGet

一站式跨平台桌面下载器：BT/磁力（aria2c）、视频（yt-dlp）、音乐（内嵌引擎）、HTTP 直链 + 本地工具箱（ffmpeg）。

支持 **Windows / macOS / Linux** 三平台运行与打包（NSIS/MSI/ZIP、DMG、AppImage/DEB）。纯 Node/TS 单运行时，无 Python 依赖。

技术栈：Electron 33 + Vite + React 18 + TS 严格模式 + Tailwind + better-sqlite3。

## 开发

```bash
npm install          # 若 better-sqlite3/electron 原生二进制下载失败见下方说明
npm run dev          # 三端（main/preload/renderer）开发模式
npm run typecheck    # TS 严格模式类型检查
npm run build        # 生产构建（out/）
npm run dist:win     # Windows NSIS/MSI/ZIP 打包（dist:mac / dist:linux 同理）
```

## 目录

```
src/main/        主进程：编排核心（orchestrator/ 引擎监督、music/ 内嵌音乐引擎、task/ 状态机、db/）
src/preload/     contextBridge 白名单桥
src/renderer/    React UI（app/ features/ components/ui stores/ styles/tokens.css）
src/shared/      双端共享类型（任务模型、IPC 通道、错误码表）
resources/engines/   sidecar 二进制（aria2c/yt-dlp/ffmpeg，按平台目录）
scripts/         e2e / 探测 / 图标 / 测试辅助脚本
docs/            产品技术设计文档 + 开发任务计划 + 遗留问题清单
```

## 跨平台约定

sidecar 引擎按 **`resources/engines/<platform>-<arch>/`** 目录分发，与运行时 `process.platform-process.arch` 一致：

| 平台 | 目录 | 说明 |
|---|---|---|
| Windows x64 | `win32-x64` | aria2c.exe / yt-dlp.exe / ffmpeg.exe（音乐引擎已内嵌主进程，无 sidecar 服务） |
| macOS arm64 | `darwin-arm64` | 无后缀 |
| macOS x64 | `darwin-x64` | 无后缀 |
| Linux x64 | `linux-x64` | 无后缀 |
| 跨平台公共 | `engines/common` | 平台无关资源 |

- **打包**：electron-builder 按平台段注入对应引擎目录（mac 产出 x64/arm64 双 dmg，不产出无法捆绑 sidecar 的 universal）
- **数据目录**：Windows 打包态便携口径（exe 同级 `data/`，不可写回退 userData）；macOS/Linux 直接使用系统 userData（规避 .app bundle 只读 / AppImage squashfs）
- **进程管理**：`orchestrator/proc.ts` 统一进程树终止——Windows 用 `taskkill /T /F`（SIGTERM 在 Windows 退化为硬杀且不级联 ffmpeg 子进程），Unix 走 SIGTERM → 超时 SIGKILL
- **引擎热更**：yt-dlp 热更按平台选择官方 release 资产（`yt-dlp.exe` / `yt-dlp_macos` / `yt-dlp_linux*`），SHA256 校验后原子替换，Unix 补可执行位
- **file:// 与路径**：`fileURLToPath` 跨平台解析拖拽/协议路径；文件删除防御按文件系统大小写口径（Linux 敏感）

### sidecar 三平台构建（发布前）

音乐引擎已内嵌主进程，sidecar 仅剩 aria2c / yt-dlp / ffmpeg 三类预编译二进制——不支持交叉构建/下载的需在对应平台 runner 上获取并放入 `resources/engines/<platform>-<arch>/`。CI（`.github/workflows/build.yml`）三平台矩阵构建时会检查就位，缺失仅告警不阻断。

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
- [x] M2 音乐（引擎已从 Python sidecar 迁移为主进程内嵌 TS 模块，真取消语义）
- [x] M3 视频（M3-1 ~ M3-11 全部，yt-dlp/ffmpeg sidecar）
- [x] M4 打磨发布（引擎热更三平台化 / 进程树终止 / tracker 多源订阅 + 镜像 / BT 加速调优 / 去 Python 单运行时）

## 验证

```bash
npm test                                    # 47 个单测（状态机/torrent/嗅探/事件合并等；以 npm test 实际输出为准）
npx tsx --tsconfig tsconfig.node.json scripts/e2e-aria2.ts   # aria2 端到端（真实 sidecar）
```

## 隐私与合规

全部数据（任务库、设置、指纹）仅存本地；遥测默认关闭。本工具不内置任何资源站，下载内容版权责任由使用者承担。
