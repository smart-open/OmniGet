# OmniGet

一站式跨平台桌面下载器：**BT/磁力（aria2c）· 视频（yt-dlp）· 音乐（五平台内嵌引擎）· HTTP 直链**，内置本地 ffmpeg 工具箱。定位「本地优先、无广告、界面现代」。

支持 **Windows / macOS / Linux** 三平台运行与打包（NSIS/MSI/ZIP、DMG、AppImage/DEB）。纯 Node/TS 单运行时，无 Python 依赖。

技术栈：Electron 33 + Vite + React 18 + TS 严格模式 + Tailwind + zustand + better-sqlite3。

## 功能特性

**下载核心**
- HTTP 多连接分段 + 断点续传；**多源聚合下载**（粘贴多个镜像 URL 合并单任务，content-length 一致性校验后并行拉取）
- BT/磁力：BEP-9 元数据流程（先解析后勾选零流量）、文件树三态勾选、**元数据本地缓存**（二次任务秒出文件树）、UPnP/NAT-PMP 自动端口映射、Tracker 多源订阅 + 每日刷新、BT 消息加密（绕运营商 QoS）、0 速自停防僵尸任务
- 单任务限速、全局并发队列（FIFO 自动派发）、定时/分时段限速计划、按类型自动归档

**视频**
- yt-dlp 全站提取：合集/播放列表勾选、格式选择器、字幕/封面嵌入、并发分片
- **HLS/DASH 专用引擎**（N_m3u8DL-RE）：m3u8/mpd 清单链接嗅探分型、加密分段流、变体格式选择，RE 缺席自动回落 yt-dlp；**直播流录制**（录制时长可选）
- 短视频三级去水印（源站直取 → 候补通道 → delogo 后处理副本）；分享短链/文案直贴自动展开；自托管解析服务兜底（快手/小红书补平台）
- 订阅追更（频道/UP主/歌单定时自动入队）、下载去重双档案（重复任务创建期拒绝）、SponsorBlock 广告段章节标记、yt-dlp 外部下载器 aria2c 可选加速
- 视频参数预设（保存/应用/导入导出/命名模板）、转音频提取、下载前预览（封面/时长/体积）与多维筛选

**音乐**（五平台回退链：网易 → QQ → 酷狗 → 咪咕 → 汽水）
- 原唱校验 + 原版度打分（拒绝翻唱/截断片段）、三档音质（逐行可选）、LRC 歌词落盘
- 试听长条播放器（可拖动进度条）、「下载失败」专属视图 + 一键重试

**生态与体验**
- 浏览器扩展（MV3：右键发送 + 可选自动拦截）、Web UI 本地面板（回环 + token）
- 平台健康面板（提取器/音乐/短视频平台可用性公示）、适配脚本热更（声明式 host 重写，合规形态）
- 本地工具箱：ffmpeg 19+ 工具（转换/裁剪/拼接/压缩/GIF/字幕/人声分离/校验和/种子创建等）
- 迷你悬浮窗、七主题系统、虚拟滚动任务列表（10k+ 行）、Inspector 抽屉、快捷键全集、回收站、统计页、i18n（zh-CN/en）

> 版本历史见 [CHANGELOG.md](./CHANGELOG.md)；未完成项与待办见 [docs/backlog.md](./docs/backlog.md)。

## 开发

```bash
npm install          # 若 better-sqlite3/electron 原生二进制下载失败见下方说明
npm run dev          # 三端（main/preload/renderer）开发模式
npm run typecheck    # TS 严格模式类型检查（node + web 双端）
npm run build        # 生产构建（out/）
npm run dist:win     # Windows NSIS/MSI/ZIP 打包（dist:mac / dist:linux 同理）
```

## 目录

```
src/main/        主进程：编排核心（orchestrator/ 引擎监督、music/ 内嵌音乐引擎、task/ 状态机、net/ NAT 映射、db/）
src/preload/     contextBridge 白名单桥
src/renderer/    React UI（app/ features/ components/ui stores/ styles/tokens.css）
src/shared/      双端共享类型（任务模型、IPC 通道、错误码表）
resources/engines/   sidecar 二进制（aria2c/yt-dlp/ffmpeg，按平台目录）
resources/extension/ 浏览器扩展（MV3）
scripts/         e2e / 探测 / 图标 / 测试辅助脚本
docs/            技术设计文档 + 竞品分析与路线图 + backlog（未完成项追踪）
```

## 跨平台约定

sidecar 引擎按 **`resources/engines/<platform>-<arch>/`** 目录分发，与运行时 `process.platform-process.arch` 一致：

| 平台 | 目录 | 说明 |
|---|---|---|
| Windows x64 | `win32-x64` | aria2c.exe / yt-dlp.exe / ffmpeg.exe（音乐引擎已内嵌主进程，无 sidecar 服务；N_m3u8DL-RE / deno 为按需下载位，可缺失回落/补齐） |
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

## 项目状态

T0 工程基建 → M1 BT/磁力/HTTP → M2 音乐 → M3 视频 → M4 打磨发布 已全部收口；产品化阶段（浏览器扩展 / 任务队列 / 批量抓取 / 预设 / Web UI / 引擎按需下载）、下载引擎优化（UPnP 端口映射 / 元数据缓存 / 多源聚合 / 短链展开）与 0.7.0 批次（HLS/DASH 引擎 / 直播录制 / 订阅追更 / 下载去重 / 短视频解析兜底 / 迷你悬浮窗）已落地。里程碑明细见 [CHANGELOG.md](./CHANGELOG.md)，未完成项见 [docs/backlog.md](./docs/backlog.md)。

## 验证

```bash
npm test                                    # 93 个单测（状态机/torrent/嗅探/事件合并/nm3u8-parse/video-extract/sanitize 等；以 npm test 实际输出为准）
npx tsx --tsconfig tsconfig.node.json scripts/e2e-aria2.ts   # aria2 端到端（真实 sidecar）
```

## 隐私与合规

全部数据（任务库、设置、指纹）仅存本地；遥测默认关闭。本工具不内置任何资源站，下载内容版权责任由使用者承担。
