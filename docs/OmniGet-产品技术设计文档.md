# OmniGet 产品技术设计文档

> **工作代号**：OmniGet（可替换）
> **版本**：v1.0 ｜ **日期**：2026-09-29 ｜ **状态**：设计评审稿
> **定位**：跨平台（Windows / macOS / Linux）现代化桌面下载软件 —— 一站式覆盖 BitTorrent 种子、磁力链接、各视频平台、主流音乐平台与通用 HTTP 下载。

---

## 1. 产品概述

### 1.1 产品定位

OmniGet 是一款**本地优先、无广告、界面现代**的桌面下载工具。它把四类下载能力与一个后处理工具箱统一到一个任务模型和一个界面之下：

| 能力域 | 引擎 | 典型场景 |
|---|---|---|
| BT 种子 / 磁力 | aria2c（JSON-RPC） | 多文件种子按需勾选、DHT/Tracker 加速、做种控制 |
| 视频平台 | yt-dlp（1000+ 站点） | YouTube/B站/抖音等解析与下载、清晰度选择、字幕、合集；短视频分享短链无水印直取（§4.3.1）；视频转音频提取（§4.3.2） |
| 音乐平台 | 内置 Python 服务（复用 music-downloader） | 网易云/QQ/酷狗/咪咕/汽水五平台搜索下载、三档音质、LRC 歌词 |
| 通用 HTTP(S) | aria2c 多连接 | 直链加速、断点续传 |
| 后处理工具箱 | 本地 ffmpeg 管线（纯 DSP，零 AI/零 GPU） | 格式转换、音频裁剪、响度标准化、人声/伴奏分离（中心消除法）、视频压缩、元数据编辑（§4.7） |

### 1.2 目标用户

- 需要批量、稳定下载大体积内容的重度用户（参考项目：本地短剧/资源库管理场景）。
- 已有大量 BT/磁力资源与视频平台下载需求的个人用户。
- 对下载器 UI 有审美要求、反感广告与弹窗的用户。

### 1.3 核心价值

1. **一个输入框吃下所有链接**：磁力、种子文件、视频平台地址、音乐名、HTTP 直链统一从"新建任务"进入，自动嗅探类型并路由到对应引擎。
2. **多文件资源先解析、后勾选**：种子/磁力/合集在下载前先解析出文件树，用户勾选要下载的文件（取消勾选即排除），实时合计已选体积。
3. **多线程数随处可调**：全局默认 + 每任务覆盖，映射到 aria2c 连接数 / yt-dlp 并发分片。
4. **统一任务中心**：全部任务（四类下载 + 工具箱处理）同列表管理，统一进度、限速、队列、断点续传与通知。

### 1.4 非目标（Scope Out）

- 不做会员加速、不做推广分发、不做 P2P 匿名代理。
- 不内置浏览器；通过剪贴板监听 / `magnet:` 协议注册 / 拖拽接入链接。
- 不做视频转码与播放器（M4 可选做"已完成视频的本地预览"）。

---

## 2. 整体架构

### 2.1 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│  渲染层 Renderer（React 18 + TypeScript + Tailwind + Framer Motion） │
│  任务列表 │ 新建任务 │ 文件树勾选 │ 音乐搜索 │ 设置 │ Inspector      │
└──────────────────────────────┬──────────────────────────────────────┘
                     IPC (contextBridge / preload)
┌──────────────────────────────▼──────────────────────────────────────┐
│  Electron 主进程 Main（Node.js 编排核心）                            │
│  • 任务管理器：队列/调度/限速/持久化(SQLite)                          │
│  • 子进程监督器：拉起/崩溃重启/健康检查 三个引擎进程                   │
│  • 系统集成：托盘、通知、剪贴板监听、magnet: 协议注册、开机自启        │
└───────┬──────────────────────┬─────────────────────┬────────────────┘
        │ JSON-RPC(WS)         │ 子进程 stdin/stdout  │ HTTP + WebSocket
┌───────▼────────┐   ┌─────────▼──────────┐   ┌──────▼──────────────┐
│  aria2c 引擎    │   │  yt-dlp 引擎        │   │ omni-service        │
│  BT/磁力/HTTP   │   │  视频/音频解析下载   │   │ (Python FastAPI     │
│  多连接/做种/DHT │   │  1000+ 站点         │   │  PyInstaller 单文件) │
│  RPC:16800      │   │  --concurrent-      │   │  :16801             │
│                 │   │   fragments=N       │   │  音乐五平台模块      │
└────────────────┘   └────────────────────┘   └─────────────────────┘
```

- **Electron 主进程是唯一编排者**：渲染层不直接访问任何引擎；所有状态经主进程汇聚后广播。
- **三个引擎子进程互相隔离**，任何一个崩溃由主进程按退避策略重启，不丢失任务状态（状态持久化在 SQLite，引擎重启后重建会话）。
- **aria2c** 覆盖 BT/磁力/HTTP 三类传输，本身就是成熟的多连接下载核；**yt-dlp** 以独立二进制子进程运行，负责平台解析与流式下载；**omni-service** 是本项目自研 Python 服务，直接 import 复用 music-downloader 技能的 `batch_download_v4.py` 五平台逻辑。
- **ffmpeg（第四个随包二进制，评审补遗）**：yt-dlp 的硬依赖——`bv*+ba` 合并、字幕/封面嵌入（§4.3）与短视频 L3 delogo 后处理（§4.3.1）均经其完成；以 essentials 精简版随 `resources/engines/` 分发。

### 2.2 进程生命周期

| 事件 | 行为 |
|---|---|
| 应用启动 | 主进程先读 SQLite 恢复任务表 → 依序拉起 aria2c（`--enable-rpc --rpc-secret=<随机token>`）→ yt-dlp 版本探测（`--version`）→ omni-service（`/health`）→ 渲染层就绪后广播引擎健康状态 |
| 引擎崩溃 | 指数退避重启（1s/2s/4s/…上限 30s），连续失败 5 次标记引擎离线并在 UI 状态栏亮红点；BT 任务自动重新 `addUri/addTorrent` 恢复 |
| 应用退出 | 向 aria2 发 `shutdown`、向 omni-service 发 SIGTERM、yt-dlp 若在下载则先暂停（SIGTERM 保留 `.part`，§4.1 语义）并记录分片状态、工具箱 ffmpeg 任务 SIGTERM 终止并标记 failed → 10s 超时强杀 |
| 系统休眠/恢复 | 监听 `powerMonitor`：挂起时暂停全部任务，恢复后按队列自动续传 |

### 2.3 目录结构（工程骨架）

```
omniget/
├─ package.json                 # electron + electron-builder
├─ src/
│  ├─ main/                     # 主进程
│  │  ├─ index.ts               # 入口、单实例锁
│  │  ├─ orchestrator/          # 引擎监督器（aria2/yt-dlp/service）
│  │  ├─ task/                  # 任务管理器、队列调度、状态机
│  │  ├─ db/                    # better-sqlite3 封装与迁移
│  │  ├─ integrations/          # 托盘/通知/剪贴板/协议/自启
│  │  └─ ipc.ts                 # IPC handler 注册表
│  ├─ preload/bridge.ts         # contextBridge 白名单 API
│  └─ renderer/
│     ├─ app/                   # 路由与全局布局
│     ├─ features/              # tasks / new-task / bt / video / music / toolbox / stats / settings
│     ├─ components/ui/         # 定制 shadcn 组件
│     ├─ stores/                # zustand
│     └─ styles/tokens.css      # 设计 Token（见 §7.3）
├─ resources/
│  └─ engines/                  # sidecar 二进制（按平台打包）
│     ├─ aria2c(.exe)
│     ├─ yt-dlp(.exe)
│     ├─ ffmpeg(.exe)           # essentials 精简版（yt-dlp 合并 / L3 后处理依赖）
│     └─ omni-service(.exe)     # PyInstaller 产物
└─ service/                     # Python 源码（omni-service）
   ├─ main.py                   # FastAPI + WS
   └─ music/                    # 移植自 music-downloader：batch_download_v4 逻辑
```

---

## 3. 技术选型

### 3.1 选型表

| 层 | 技术 | 版本基线 | 理由 |
|---|---|---|---|
| 桌面壳 | Electron | 33.x | 生态最成熟，sidecar 进程管理与托盘/协议 API 齐全 |
| 前端框架 | React + TypeScript | 18 / 5.x | 组件生态、类型安全 |
| 状态管理 | Zustand | 5.x | 轻量、可切片订阅（任务高频更新场景性能好） |
| 样式 | Tailwind CSS + 定制 shadcn/ui | 3.x | Token 化主题、快速还原设计规范 |
| 动效 | Framer Motion | 11.x | spring 物理动效、`layoutId` 共享元素过渡、`AnimatePresence` 进出场 |
| 图标 | @phosphor-icons/react | — | 线条统一（全局 strokeWidth 1.5），禁 emoji |
| 图表 | 自绘 SVG 迷你速度曲线 | — | 避免重型图表库；状态栏速度图 60fps |
| 本地库 | better-sqlite3 | 11.x | 同步 API 简单可靠，主进程持久化 |
| 主进程 HTTP | 原生 fetch + ws | — | 调 aria2 JSON-RPC（WebSocket）与 omni-service |
| 音乐服务 | Python 3.11 + FastAPI + uvicorn，PyInstaller --onefile | — | 直接复用 music-downloader 的五平台实现，避免跨语言重写 |
| BT/HTTP 引擎 | aria2c（`--enable-rpc`） | 1.37 | 参考脚本已验证的能力面：`--select-file`、多连接、DHT/LPD、做种 |
| 视频引擎 | yt-dlp 独立二进制 | releases 最新 | 1000+ 站点、`-J` JSON 解析、`--concurrent-fragments` 并发 |
| 流处理/后处理 | ffmpeg（essentials 精简版） | 7.x | yt-dlp 合并/嵌字幕/嵌封面硬依赖；短视频 L3 delogo 后处理 |

### 3.2 备选方案对比（决策记录）

| 方案 | 结论 | 原因 |
|---|---|---|
| Tauri 2 + Rust | 排除 | 音乐五平台 API 回退链用 Rust 重写风险高、周期长；安装包虽小但交付确定性差 |
| PySide6 纯 Python | 排除 | 复用 music-downloader 最省事，但"布局现代精美"的 UI 上限与动效能力明显弱于 Web 技术栈 |
| Electron + React + Python sidecar | **采用** | UI 表现力最强；music 逻辑零重写直接 import；aria2c/yt-dlp 以 sidecar 分发，工程路径清晰 |

### 3.3 体积与内存预算

| 组成 | 体积（Windows 基准） |
|---|---|
| Electron 运行时 + 应用代码 | ~90 MB（安装包 NSIS 压缩后 ~65 MB） |
| aria2c | ~4 MB |
| yt-dlp 二进制 | ~30 MB |
| ffmpeg essentials | ~25 MB |
| omni-service（PyInstaller onefile，含 requests/fastapi） | ~28 MB |
| 空载内存 | 主进程+渲染 ~180 MB，aria2c ~30 MB，service ~45 MB |

---

## 4. 核心模块设计

### 4.1 统一任务模型与引擎适配器

所有下载入口收敛为一个 `Task`，引擎差异由适配器抹平：

```ts
type TaskType = 'bt' | 'magnet' | 'video' | 'music' | 'http' | 'tool'

interface Task {
  id: string                 // uuid v7（时间有序，利于列表排序）
  type: TaskType
  source: string             // magnet:/URL/种子路径/'artist - song'
  name: string               // 展示名（解析后回填）
  engine: 'aria2' | 'ytdlp' | 'music' | 'tool'   // tool = 主进程 ffmpeg 调度器（§4.7）
  status: TaskStatus
  saveDir: string
  totalBytes: number
  downloadedBytes: number
  speedBps: number
  threads: number            // 该任务生效的多线程/连接数
  noWatermark?: boolean      // 短视频（抖音/快手等）：优先取无水印原始流（默认 true）
  createdAt: number
  error?: string
}

type TaskStatus =
  | 'parsing'    // 新建任务解析中（取元数据/文件树/格式列表）
  | 'awaiting'   // 等待用户确认（文件勾选/格式选择）
  | 'queued'     // 已入队等待调度
  | 'running'    // 下载中
  | 'paused'
  | 'verifying'  // BT 完整性校验
  | 'seeding'    // BT 做种
  | 'completed'
  | 'failed'
```

**状态机**：

```
parsing ──► awaiting ──► queued ──► running ──► verifying ──► completed
   │            │           ▲          │  ▲                             │ seed-ratio > 0
   └─► failed   └─►(取消)    └─ paused ─┘  └─► failed                      ▼
                                                          seeding ──►(达标/手动停止)──► completed
```

> 状态机注记：`verifying → completed` 为默认路径（seed-ratio=0 下完即停）；`seeding` 仅在做种比例 > 0 时进入，做种达标或用户手动停止后回到 `completed`。`awaiting` 为可跳过状态——HTTP 单文件/音乐单曲等无需勾选的场景由 `parsing` 直接进入 `queued`。

**引擎适配器接口**（主进程内三个实现）：

```ts
interface EngineAdapter {
  health(): Promise<EngineHealth>
  parse(input: ParseInput): Promise<ParsedResource>   // 返回文件树/格式列表
  start(task: Task, selection: TaskSelection): Promise<void>
  pause(id: string): Promise<void>
  resume(id: string): Promise<void>
  remove(id: string, withFiles: boolean): Promise<void>
  events(): AsyncIterable<EngineEvent>                // 进度/速度/状态变更
}
```

> **yt-dlp 适配器的"暂停"实现语义**：yt-dlp 为一次性 CLI，无进程内暂停 API——`pause()` = SIGTERM 优雅退出（保留 `.part` 分片缓存），`resume()` = 以相同参数重新 spawn 续传；`engine_gid` 存 pid 仅用于存活探测与强杀，不作为恢复凭据（恢复凭据是任务参数本身）。§2.2 应用退出时的"暂停 yt-dlp"同此语义。

### 4.2 BT / 磁力模块（aria2c）

参考已验证的 torrent_dl.py 参考实现（其 bencode 编解码、infohash 计算与磁力生成、aria2c 参数基线等关键细节已全部收录至本节与附录 A，原始脚本不再保留）：

**参数映射表（脚本 CLI → OmniGet）**

| torrent_dl.py 参数 | aria2c 对应 | OmniGet 暴露位置 |
|---|---|---|
| `--select-file=1,3,5-10` | `aria2.changeOption(gid, {select-file})` | 新建任务·文件树勾选（默认全选） |
| `-x 16`（每服务器连接） | `max-connection-per-server` | 新建任务·多线程滑杆（1–64，默认 16）+ 设置默认值 |
| `-j 8`（并发任务） | `max-concurrent-downloads` | 设置·同时下载任务数（1–20，默认 8） |
| `--seed-ratio=0` | `seed-ratio` | 新建任务/设置·做种比例（0=下完即停） |
| `--listen-port=6881` | `listen-port` | 设置·BT 监听端口 |
| `--enable-dht / dht6 / lpd` | 同名 RPC option | 设置·DHT 开关（默认全开） |
| `--bt-max-peers=200` | `bt-max-peers` | 设置·高级 |
| `--bt-request-peer-speed-limit=0` | 同名 | 固定 0（不限速触发加速） |
| `--file-allocation=none` | `file-allocation` | 设置·磁盘预分配（none/prealloc） |
| `--check-integrity=true` | `check-integrity` | 完成前校验，对应 `verifying` 状态 |
| `--split=<max_conn>` | `split` | HTTP 直链分片数（脚本中与每服务器连接同值），承接为 HTTP 任务连接数 |
| `--continue=true` | `continue` | 全局默认开启（`.aria2` 控制文件断点续传，脚本验证过 Ctrl+C 安全中断） |
| `--bt-tracker-connect-timeout=10` / `--bt-tracker-timeout=15` | 同名 option | 设置·BT 高级（tracker 连接/通信超时） |
| `--summary-interval=3` | —（RPC 模式不适用） | 直连模式的周期性汇总由 §6.1 的 250ms 事件合并替代 |
| tracker 注入 | `bt-tracker` | 内置 Tracker 列表（每日从 ngosang/trackerslist 拉取，失败用缓存）；设置页 **Tracker 管理器**：多订阅源 + 手动增删 + 每条 last-ok 时间展示（§4.8 Motrix 模式） |

> **参数作用域（RPC 化改造边界）**：脚本为 aria2c 直连 CLI 模式，不区分选项层级；OmniGet 的 RPC 模式须区分——`listen-port`、`enable-dht/dht6/lpd`、`max-concurrent-downloads`、`file-allocation` 为**全局选项**（启动参数或 `aria2.changeGlobalOption`，需在首任务前生效）；`select-file`、`dir`、`seed-ratio`、`max-connection-per-server`、`check-integrity` 为**每任务选项**（`aria2.changeOption(gid, …)`，任务进行中可热更）。

**磁力流程（BEP-9 元数据）**：

1. 用户粘贴 `magnet:?xt=urn:btih:...` → 主进程调 `aria2.addUri([magnet], {dir: 临时目录, bt-save-metadata: true, pause: true})`。**必须带 `pause: true`**：否则元数据到达后 aria2 会立刻开始全量下载，与"先解析、后勾选"的产品逻辑矛盾（暂停态下元数据仍会正常获取）。
2. 监听 metadata 完成事件，`aria2.getFiles(gid)` 得到文件树 → 任务进入 `awaiting`，渲染层弹出文件勾选面板。
3. 用户勾选并确认 → `aria2.changeOption(gid, {select-file})`、改 `dir` 为目标目录，再 `aria2.unpause(gid)` → 状态置 `queued`。
4. infohash 已存在于任务库时跳过元数据等待（秒开文件树）。

**.torrent 本地解析流水线（主进程，Node 侧 `bencode` 库，零引擎依赖、即时出文件树）**：

1. `bdecode` 整个种子 → 取 `info` 字典 → 将其重新 bencode 编码后计算 SHA1 得 **infohash**（40 位 hex）。
2. **文件树**：`info.files[]` 存在则为多文件种子（`path[]` 逐级拼接相对路径 + `length`）；否则为单文件（`info.name` + `info.length`）。
3. **磁力生成**：`magnet:?xt=urn:btih:<infohash>&dn=<quote(name)>&tr=<quote(tracker)>…`；tracker 从 `announce-list` 逐 tier 展开，缺失时回退 `announce` 单条，磁力中最多携带 8 个（脚本约定）。设置页"种子信息"查看器展示该磁力供复制。
4. **兼容细节（脚本实测沉淀）**：磁力中 32 位 base32 infohash 须 `b32decode → hex` 归一化为 40 位 hex 再查重，任务库去重键统一存 hex 小写；`name/path` 解码失败用 `errors='replace'` 容错，脏字段不中断解析。
5. 文件树进入 `awaiting` 勾选面板后，`aria2.addTorrent(base64)` 时同步注入 `select-file` 与目标 `dir`。

**关键词/索引选择**：保留脚本"按关键词过滤"的能力，文件树顶部提供类型快筛（视频/音频/图片/其他）+ 名称搜索框。脚本 `--select` 语法（`1,3,5-10` 索引区间 / `VID,mp4` 关键词，二者可混用、取并集）承接为搜索框语法：支持多关键词（空格分隔）与索引/区间输入，命中集合实时高亮并映射为 `select-file`。

### 4.3 视频模块（yt-dlp）

**解析**：

```bash
yt-dlp -J --no-playlist "<url>"          # 单视频：返回 JSON（标题/时长/formats/字幕/封面）
yt-dlp -J --flat-playlist "<url>"        # 合集/播放列表：返回条目列表
```

**下载**：

```bash
yt-dlp -f <format_id> --newline
  --concurrent-fragments <N>             # 多线程数 → 用户可调（映射"多线程个数"）
  --embed-subs --sub-langs "zh.*,en"     # 可选字幕
  --write-thumbnail --embed-thumbnail    # 可选封面
  --cookies <file>                       # 设置中可配置 cookie，或从浏览器导入（--cookies-from-browser）
  --ffmpeg-location "<enginesDir>/ffmpeg" # sidecar ffmpeg：bv+ba 合并/嵌字幕/嵌封面必需
  --progress-template "download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s"
  -o "<saveDir>/%(title)s.%(ext)s" "<url>"
```

- **合并规则**：默认 `bv*+ba/b`（最佳视频+音频），格式选择器列出可用的分辨率/编码/码率组合；合并依赖 ffmpeg sidecar，缺失时自动降级为站点预合并的渐进式格式并提示。
- **进度**：`--newline` 逐行 stdout 由主进程解析后入任务事件流；HLS/DASH 场景 `--concurrent-fragments` 即分片多线程。
- **合集**：flat-playlist 条目转为**文件树勾选**（同 BT 体验），每集可独立勾选/取消，支持"仅下载第 N–M 集"。
- **平台嗅探**：主进程维护域名→平台映射表（youtube/bilibili/douyin/kuaishou/…），输入框即时显示平台徽标与预期类型；未知站点仍交给 yt-dlp 尝试（其内置提取器兜底）。

#### 4.3.1 短视频模块（抖音/快手/小红书/视频号等）与去水印

**目标平台**：抖音、快手、小红书、西瓜/今日头条、微视、哔哩哔哩动态视频、微博视频；入口统一为「分享短链」（`v.douyin.com/xxx`、`v.kuaishou.com/xxx` 等跳转链）。

**短链预处理（主进程）**：

1. 嗅探到短链域名 → `fetch` 跟随 302 得到真实视频页 URL（禁用自动跳转时读 `location` 头），期间展示"正在解析分享链接…"状态。
2. 真实 URL 交给 yt-dlp 对应提取器解析 `-J`，返回的 JSON 中按平台提取**原始无水印流地址**（抖音提取器返回的 `formats` 通常已含无水印源；快手/小红书同理取 `url` 不带水印标识的候选项）。
3. 解析结果进入通用格式选择器，标注「无水印 / 有水印」徽标，默认选中无水印档。

**去水印三级策略（引擎层）**：

| 级别 | 策略 | 触发条件 | 实现 |
|---|---|---|---|
| L1 源站直取 | 优先选择平台无水印原始流 | 提取器返回无水印 format（绝大多数场景） | format 选择器规则：`no-watermark` 标记优先，其次最高分辨率 |
| L2 格式候补 | 平台只回有水印流时，尝试备用提取路径 | L1 无命中 | yt-dlp `--extractor-args "douyin:..."` 切换 API 通道 / 重定向移动端 UA 重新解析 |
| L3 后处理 | 仍只有带水印流，用户显式选择"裁切/遮挡水印" | L2 失败且用户勾选 | ffmpeg `delogo` 滤镜（解析返回的 `watermark` 元数据定位角标区域，未知位置默认右上角 15%×8% 区域），产出 `_nowm` 副本，保留原文件 |

- **产品语义**：开关叫「原始画质（无水印）」，不做"破解水印"承诺——L1/L2 是取平台本就存在的原始资源，L3 是画面修补，Inspector 中如实标注处理级别（直取 / 候补 / 后处理）。L3 依赖随包分发的 ffmpeg sidecar（§3.1/§3.3）。
- **合辑/主页批量**：支持粘贴作者主页链接 → `--flat-playlist` 拉取作品列表 → 文件树勾选（同 §7.5），批量任务继承统一去水印策略与命名模板 `%(uploader)s/%(title)s.%(ext)s`。
- **元数据**：落盘同目录写入 `<标题>.json`（作者/描述/BGM/发布时间），可选封面图下载。
- **失败兜底**：提取器失效（平台改版最高频场景）→ 任务失败文案直接给"更新 yt-dlp 引擎"按钮（复用 §8 内置更新器），不走盲目重试。

#### 4.3.2 竞品对齐能力（源自 SnapAny / AIX 智能下载器分析）

> 对标两类头部产品——SnapAny（在线解析 + 桌面客户端，三端形态）与 AIX 智能下载器（Chrome/Edge 扩展，图片/视频/音频三栖）——取其已被市场验证的桌面价值点，明确取舍边界。

| 价值点 | 来源佐证 | OmniGet 承接 | 优先级 |
|---|---|---|---|
| **视频转音频提取** | SnapAny FAQ"能转 MP3 吗"为高频问题；其桌面端独占音视频转换 | yt-dlp `-x --audio-format mp3/m4a/opus --embed-thumbnail`，格式选择器旁增加「仅提取音频」档；复用 ffmpeg sidecar，零新增依赖；与音乐模块区分（来源是视频 URL，不做平台搜索） | M3 |
| **下载前预览（防下错）** | AIX 内置视频/音频播放器是其用户评价高频好评点 | 解析结果卡片展示**封面缩略图 + 时长 + 各档体积**；不内置播放器（§1.4 非目标不破），预览用静态封面即可达成"防下错"主诉求 | M3 |
| **多维筛选** | AIX 支持按宽度/高度/格式/URL/文件大小筛选 | 文件树/格式选择器在类型快筛之外增加「分辨率 / 体积 / 格式」条件筛选 | M3 |
| **智能重命名** | AIX 智能批量重命名 | 全局命名模板设置（`{{uploader}}/{{title}}`、序号补零、日期注入），三类引擎落盘统一走模板引擎 | M4 |
| **完成文件完整性探测** | SnapAny FAQ"文件打不开"是排障高频项 | 视频任务完成时可选用 ffmpeg 探测（读 moov/时长校验），异常文件标黄提示"可能损坏，点击重试"，替代用户盲目排障 | M4 |
| **大图/原图优先** | AIX"大图自动解析，避免缩略图" | 图片类资源（§下方图片能力）一律取原图 URL，缩略图仅用于预览 | M4+ |
| 图片/图集与电商批量 | SnapAny 支持图片下载；AIX 电商主图/SKU/详情/评论图批量是核心场景 | **纳入 Backlog**（见下）不进当前里程碑 | Backlog |
| 浏览器插件 / 在线版 / API 服务 | SnapAny 三端形态、AIX 扩展形态 | **明确不做**：与"桌面本地优先"定位（§1.1）冲突，剪贴板监听 + `magnet:` 协议 + 拖拽已覆盖"免复制链接"主诉求 | 不做 |

- **Backlog（暂不排期，记录决策依据）**：
  1. **图片/图集下载**：短视频图集（抖音图集、小红书图文、微博相册）。技术路径为平台 API 提取而非 yt-dlp（图文覆盖差），且风控模型与视频不同，独立立项评估后再决定是否成为第五能力域。
  2. **电商图片批量**（淘宝/1688/京东主图 SKU 详情评论图）：AIX 的差异化主场景，但属"素材采集工具"赛道，与 OmniGet"下载器"定位有偏差；若 Backlog 1 落地可顺势评估。
  3. **平台适配状态面板**：设置页展示 yt-dlp 提取器健康度与已知失效平台，辅助用户理解失败原因（SnapAny 用户评价证明"改版跟进速度"是核心体验）。

### 4.4 音乐模块（omni-service 复用 music-downloader）

Python 服务将 music-downloader 技能的 `MusicDownloader` 能力暴露为 REST（逻辑**不重写**，直接 import 移植同目录源码）：

**平台适配器接口化（借鉴 lx-music 音源抽象 + Gopeed 插件思想，§4.8）**：五平台各自实现统一 `PlatformAdapter`（`search / download / lyric / health` 四方法），主流程只面向接口——单平台失效自动标记降级并回退下一平台（即五平台回退链的工程形态），且支持**单平台适配脚本热更**：接口被改版时修复单个适配器即可，不必发版。

| 端点 | 说明 |
|---|---|
| `GET /api/music/search?q=<原始文本>` | 聚合五平台搜索结果（网易云优先），返回平台/音质可用性/是否原唱命中；自然语言解析（`陈奕迅的孤勇者`/`陈奕迅,孤勇者`）在服务端完成，与脚本解析器同源 |
| `POST /api/music/download` | `{artist, song, quality: standard\|high\|lossless, saveDir}` → 创建音乐任务 |
| `POST /api/music/download-by-id` | 兜底通道：`{neteaseId, artist, song, quality}`（搜索降级时用歌曲 ID 精确下载） |
| `GET /api/music/task/{id}` | 单任务状态（复用脚本的原唱校验/完整音频校验/歌词落盘结果） |
| `WS /ws/events` | 统一事件推送：`music.progress` / `music.done` / `music.warning` |

**继承自 music-downloader 的稳健策略**（写入产品行为）：

1. **原唱校验**：比对 `artist` 字段，拒绝翻唱/Remix/Live 误抓；同名多版本按"原版度"打分（Live/DJ/伴奏等后缀扣分）。
2. **完整音频校验**：先写 `.part.mp3`，达标（≥1.5MB）才原子改名为最终 `.mp3`。
3. **真实时间轴歌词**：官方 `/api/song/lyric` 优先 → 镜像内联歌词兜底 → 「暂无歌词」占位；LRC 与 MP3 同目录落盘。
4. **五平台回退链**：网易云 → QQ → 酷狗 → 咪咕 → 汽水；某平台降级时 UI 明确告警（黄色提示条），不静默出错。
5. **音质三档**：standard(128k) / high(320k，默认) / lossless(FLAC)。

**产品化差异**：搜索结果页为"音乐工作台"（见 §7.6），支持试听候选版本、查看命中平台与音质、批量文本导入（沿用脚本 `陈奕迅 孤勇者` 等自然语言格式解析）。

### 4.5 任务管理器（主进程）

- **调度**：优先级队列（手动置顶 > 新建）；全局并发 `max-concurrent-downloads` 由 aria2 承担，yt-dlp/music 任务由主进程信号量控制（默认视频 2 并发、音乐 4 并发，均可配置）。音乐并发 UI 上限 4，但 omni-service 内部对**同一平台**的请求串行化并保持 ≥1s 间隔（队列缓冲），避免高并发触发平台风控。
- **限速**：全局上限 → aria2 `max-overall-download-limit`；每任务 → `max-download-limit`。
- **定时/分时段调度**（§4.8，借鉴 AB Download Manager）：可配置速度计划表（时段 → 全局限速档，如 09:00–18:00 限速 2MB/s、闲时全速）与"定时开始/停止全部任务"；主进程定时器驱动，切换即时经 `changeGlobalOption` 生效，不依赖系统任务计划。
- **持久化**（SQLite，见 §5）：重启恢复队列；BT 任务凭 infohash/torrent 路径 re-add，普通任务凭 `.aria2` 控制文件/分片缓存续传。`awaiting` 任务凭 `task_files` 已存文件树直接恢复勾选面板；`parsing` 任务置回 `queued` 前重新触发解析；工具任务（running 中断）标记为 failed 并提示重跑（ffmpeg 中间产物不续传）。
- **统计口径**：`daily_stats` 仅聚合下载类任务（`type≠'tool'`），工具任务计入独立"处理次数"（M4 视需求扩展字段）。
- **文件名清洗（跨平台落盘前置）**：视频标题、种子内路径等第三方字符串统一 sanitize——Windows 非法字符 `<>:"|?*` 替换、控制字符剔除、保留名（CON/NUL/COM1…）处理、末尾空格/点剔除；超长路径按 MAX_PATH 260 截断处理，超限时提示更换保存目录。清洗在主进程统一实施，避免"UI 显示正常、落盘报错"类 bug。
- **已完成任务增量补下**：`select-file` 热更仅对 queued/running 任务有效；任务 completed 后 aria2 gid 已销毁，此时"补选文件"= 同 infohash re-add（优先复用任务库缓存的 `.torrent`，磁力走 BEP-9 二次获取元数据）+ 新 `select-file`，aria2 对已存在文件秒校验跳过，体验无感。
- **失败重试**：网络类失败自动指数退避重试 3 次；音乐平台降级类失败不自动重试，转为 UI 建议操作（如"用歌曲 ID 精确下载"）。所有失败在 Inspector 中**结构化归因**（DNS / TLS / HTTP 状态码 / 平台风控 / 磁盘空间五类）并附一键出口动作（热更引擎 / 改用磁力 / ID 精确下载 / 清理空间），借鉴 Motrix/AB 的任务诊断实践（§4.8）。
- **回收站**：删除任务默认保留文件并移入回收站分组，二次清除才删文件。

### 4.6 系统集成

| 能力 | 实现 |
|---|---|
| 托盘 | 显示聚合速度；菜单：新建任务 / 暂停全部 / 恢复全部 / 退出；关闭主窗默认最小化到托盘 |
| 系统通知 | 任务完成/失败（Windows Toast / macOS Notification / Linux libnotify） |
| 剪贴板监听 | 检测到 `magnet:` 或受支持视频 URL 时弹轻提示"检测到链接，点击新建任务"（可关闭）；与 `magnet:` 协议唤起、拖拽共用 **30s 去重窗口**——同一链接只触发一次新建流程，避免"浏览器点磁力 + 剪贴板已有该链接"双重弹窗 |
| `magnet:` 协议注册 | 系统级注册，浏览器点击磁力直接唤起 OmniGet 新建任务 |
| 拖拽 | `.torrent` 文件拖入主窗口即开始解析 |
| 开机自启 | `app.setLoginItemSettings`（默认关） |

### 4.7 本地工具箱（后处理，零 AI / 零 GPU）

> 对标 suno.cn 等创作平台工具链（伴奏/人声分离、12 轨全轨分离、智能母带、格式转换）中**本地可承受**的部分；刻意走轻量路线，与 AI 创作工具划清边界。

**设计原则**：

1. **只做确定性 DSP**：全部能力基于 ffmpeg 滤镜与经典信号处理，不接入大模型、不做云端推理、不要求 GPU——后处理应"开箱即算"。
2. **零新增二进制**：引擎就是包内 ffmpeg sidecar，无新依赖。
3. **复用任务模型**：工具任务 `type='tool'`、`engine='tool'`，走统一队列/状态机（queued→running→completed，无 verifying）、进度/取消语义齐全；独立信号量（默认 2 并发，不计入下载并发）。
4. **入口贴合下载流**：任务右键「发送到工具箱」预填源文件；工具箱页也可独立选文件。产物默认落 `源目录/工具箱输出/<工具名>/`。

**工具清单**：

| 工具 | 对标（suno.cn 工具链） | 实现 | 代价 |
|---|---|---|---|
| 音频格式转换 | 平台通用能力 | ffmpeg 转码（mp3/flac/wav/m4a/opus，码率/采样率可选） | 秒–分钟级，单核 |
| 音频裁剪/拼接 | — | ffmpeg `-ss/-t` 无损剪切优先（关键帧对齐），concat 拼接 | 秒级 |
| 响度标准化（母带-lite） | "智能母带"的轻量替代 | `loudnorm`（EBU R128，目标 -14 LUFS）+ 峰值限制 | 实时率 ~10x |
| **人声/伴奏分离（L1）** | 平台的伴奏/人声分离 | **中心声道消除法**（纯信号处理）：立体声左右相减抵消中央人声得伴奏；中央成分提升得近似人声 | 实时率 ~20x；效果依赖混音（立体声歌曲好、单声道无效），UI 如实标注"轻量模式" |
| 视频压缩/分辨率转换 | — | H.264 CRF 模式 + 三档预设（原画质/均衡/高压缩） | 分钟级 |
| GIF/动图截取 | — | 视频片段 → GIF/WebP，帧率与宽度可选 | 秒–分钟 |
| 字幕转换 | — | srt/ass/vtt 互转 + 导出纯文本 | 秒级 |
| 音频元数据编辑 | — | ID3/Vorbis 标签与封面写入（与音乐模块 LRC 联动） | 即时 |

**明确不做 / Backlog**：

- **神经网络音轨分离（L2，Demucs 类 12 轨）**：效果远超 L1，但属模型推理——CPU 处理 4 分钟歌曲需数十分钟、包体 +200MB，违背"零模型"原则，**不内置**；用户呼声高时以"可选增强组件"独立立项。
- **MIDI 导出**：需音高检测/转录模型，同上不做。
- **歌词生成等生成式 AI 能力**：明确不做（§1.1 定位）。

### 4.8 开源同类产品价值复用（GitHub 对标）

> 对标四个代表性开源项目（2026-09 状态核实）：**Motrix**（Electron+aria2，已停更于 v1.8.19）、**Gopeed**（Go+Flutter，活跃）、**lx-music-desktop**（40k+★，活跃）、**AB Download Manager**（Kotlin/Compose，活跃）。

| 项目 | 与 OmniGet 关系 | 采纳复用 | 教训引以为戒 |
|---|---|---|---|
| **Motrix** | 同为 Electron + aria2 RPC，功能面参考最多 | 任务详情信息密度（peer/分文件/tracker）——对应 Inspector 设计；**Tracker 多订阅源管理器**（手动增删 + 订阅源 + last-ok 展示，§4.2）；**任务诊断结构化**（§4.5） | ① fork 专用 aria2 而非官方发行版，维护者离开后社区无法接手 → OmniGet 坚持官方发行版 + TOFU 校验（§8）；② 旧技术债积累至停更 → 依赖例行升级；③ 停更后社区以 Motrix Next 重建，验证"全功能下载管理器"需求长期存在 |
| **Gopeed** | 多协议下载管理器（HTTP/BT/磁力） | **适配器可插拔思想**：音乐 PlatformAdapter 接口化（§4.4）、工具箱管线化（§4.7）与其模块化架构同构；其 JS 插件系统启发 Backlog"平台适配脚本热更" | 浏览器扩展与插件市场——生态形态与定位不符，不采纳（与 §4.3.2 对 SnapAny 的结论一致） |
| **lx-music-desktop** | 音乐平台聚合的近亲 | **音源抽象层**：软件不内置资源、平台以适配器接入、单源失效一键切换 → 强化 §4.4 的接口化 + 单平台脚本热更工程形态；歌单/试听交互参考 | 2023 年遭 DMCA 投诉下架 → §9 合规口径（工具定位、降级告警、免责声明、不聚合资源站）必须严格执行 |
| **AB Download Manager** | 现代下载器 UI 参照 | **定时下载/分时段限速**（§4.5，经 aria2 `changeGlobalOption` 实现，零引擎成本）；队列分类/排序习惯；其浏览器扩展证明"接管下载"是强需求，OmniGet 以剪贴板+协议+拖拽替代 | — |

**复用总原则**：只取已被社区验证的"任务管理 / 调度 / 适配器架构"层价值；凡涉及生态形态（插件市场、浏览器扩展、在线服务）与合规红线（聚合资源）的均不采纳。

---

## 5. 数据模型（SQLite）

```sql
-- 任务主表
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,           -- uuid v7
  type          TEXT NOT NULL,              -- bt|magnet|video|music|http|tool
  params        TEXT,                       -- 工具箱参数 JSON（§4.7，仅 type=tool）
  engine        TEXT NOT NULL,              -- aria2|ytdlp|music|tool（tool = 主进程 ffmpeg 调度器，§4.7）
  source        TEXT NOT NULL,
  name          TEXT,
  status        TEXT NOT NULL DEFAULT 'parsing',
  save_dir      TEXT NOT NULL,
  total_bytes   INTEGER DEFAULT 0,
  downloaded    INTEGER DEFAULT 0,
  threads       INTEGER DEFAULT 16,         -- 每任务多线程/连接数
  seed_ratio    REAL DEFAULT 0,
  infohash      TEXT,                       -- BT/磁力
  format_id     TEXT,                       -- 视频
  no_watermark  INTEGER,                    -- 仅短视频: 1=优先无水印原始流, 0=保留原样; 非短视频存 NULL
  wm_level      TEXT,                       -- 实际去水印级别: direct|fallback|post(后处理), 完成后回填
  quality       TEXT,                       -- 音乐: standard|high|lossless
  engine_gid    TEXT,                       -- aria2 gid / yt-dlp pid / music task id
  error         TEXT,
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  deleted_at    INTEGER                     -- 回收站：非 NULL 即处于回收站分组（§4.5），二次清除才物理删除
);
CREATE INDEX idx_tasks_status ON tasks(status, created_at DESC);

-- 多文件资源的文件级选择与进度
CREATE TABLE task_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,                 -- 相对路径（文件树用 / 分层）
  size       INTEGER NOT NULL,
  selected   INTEGER NOT NULL DEFAULT 1,    -- 勾选=1，取消=0（→ aria2 select-file 排除）
  downloaded INTEGER DEFAULT 0,
  UNIQUE(task_id, path)
);

-- 设置键值
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Tracker 缓存
CREATE TABLE trackers (url TEXT PRIMARY KEY, last_ok_at INTEGER, source TEXT);

-- 统计页聚合（M4）：应用启动与每日 0 点后从 tasks 增量重算，统计页只读本表不扫全量任务
CREATE TABLE daily_stats (
  day             TEXT PRIMARY KEY,         -- 'YYYY-MM-DD'（本地时区）
  completed_count INTEGER DEFAULT 0,        -- 当日完成任务数（按 completed_at 归日）
  completed_bytes INTEGER DEFAULT 0,        -- 当日完成体积合计
  peak_speed_bps  INTEGER DEFAULT 0         -- 当日峰值速度（主进程滑动窗口采样回填）
);
```

---

## 6. IPC 与 API 设计

### 6.1 渲染层 ↔ 主进程（IPC 白名单，经 preload contextBridge）

| 通道 | 方向 | 载荷 | 说明 |
|---|---|---|---|
| `task:create` | R→M | `{source, threads, saveDir, noWatermark?}` | 新建任务入口（自动嗅探类型；短视频默认 `noWatermark=true`） |
| `task:parseFile` | R→M | `.torrent` 路径 | 本地种子解析 → 文件树 |
| `task:confirmSelection` | R→M | `{taskId, selectedPaths?[], formatId?, threads}` | 确认勾选，开始下载（BT/合集传 `selectedPaths`；视频传 `formatId`；主进程按任务类型分派校验） |
| `task:control` | R→M | `{taskId, action: pause\|resume\|remove\|top, withFiles?}` | 任务控制（`remove` 默认保留文件移入回收站，`withFiles=true` 二次清除才删文件） |
| `task:retry` | R→M | `{taskId}` | 失败任务手动重试 |
| `task:openFolder` | R→M | `{taskId}` | 打开保存目录（资源管理器/Finder/文件管理器） |
| `task:list` | R→M | `{filter}` | 列表查询（含分文件数据） |
| `music:search` | R→M | `{q}`（原始文本，自然语言解析在 omni-service 侧，与脚本解析器同源） | 代理 omni-service |
| `music:download` | R→M | `{artist, song, quality, saveDir?}` | 音乐工作台下载动作（代理 omni-service） |
| `engine:update` | R→M | `{engine: 'ytdlp'\|'service'}` | 手动触发引擎热更（yt-dlp 二进制 / omni-service 单平台适配脚本，§4.3.1 失败兜底按钮） |
| `tool:create` | R→M | `{tool, sourcePath, params, saveDir?}` | 工具箱任务创建（§4.7；任务右键"发送到工具箱"预填源文件） |
| `settings:get/set` | R→M | key/value | 设置读写 |
| `event:tasks` | M→R | `TaskEvent[]`（节流 4Hz 批量） | 进度/状态广播 |
| `event:engines` | M→R | `EngineHealth` | 引擎健康状态广播 |

> 性能约定：进度事件在主进程按 250ms 窗口合并后再推送渲染层，列表行用虚拟滚动（`@tanstack/react-virtual`）支撑 10k+ 任务。

### 6.2 主进程 ↔ 引擎

| 链路 | 协议 | 要点 |
|---|---|---|
| → aria2c | JSON-RPC over WebSocket `127.0.0.1:16800/jsonrpc` | `rpc-secret` 随机 32 字节，仅绑定回环；订阅 `aria2.onDownloadProgress` 等 |
| → yt-dlp | 子进程 spawn | stdout 逐行解析进度；退出码 0/1/2 分类处理 |
| → omni-service | HTTP + WS `127.0.0.1:16801` | `/health` 心跳 10s；WS 事件与主进程任务流合并 |
| → ffmpeg（工具箱） | 子进程 spawn（按需短生命周期） | 非常驻引擎，无健康检查；由 tool 调度器按任务拉起，`-progress pipe:1` 输出经 same 解析入任务事件流；并发由工具信号量（默认 2）约束 |

### 6.3 omni-service REST 示例

```jsonc
// POST /api/music/download  请求
{ "artist": "陈奕迅", "song": "孤勇者", "quality": "high", "saveDir": "D:/Music" }

// 响应（202）
{ "taskId": "018f3c…", "status": "running",
  "pipeline": "netease", "lrc": true,
  "guards": { "artistMatch": true, "minBytes": 1572864 } }
```

---

## 7. UI / UX 设计（重点章节）

> 依据三份设计规范融合：**Linear 式克制**（frontend-skill）+ **反 AI 味工程规则**（design-taste）+ **记忆点美学**（frontend-design）。产品 UI 走"工具感 + 精密感"，拒绝营销化文案与卡片堆砌。

### 7.1 设计原则

1. **一层主工作区**：主窗口 = 侧边导航 + 任务工作区 + 可关闭右侧 Inspector；任务行不用卡片盒子，用 `divide-y` 1px 分隔线分区（信息密度高时"线优先于盒子"）。
2. **单一强调色**：全站仅一个强调色（Electric Blue `#3E8BFF`，深色下 `#5AA0FF`），承载"进行中/可操作"语义；成功/警告/失败为固定语义色，不参与装饰。
3. **数字等宽**：所有速度、大小、百分比用 Geist Mono（中文界面数字亦然），表格对齐零抖动。
4. **状态完备**：每个列表/面板必须有 loading 骨架（与最终布局同形）、空态（构成式插画 + 一个动作按钮）、错误态（行内红字 + 重试）。
5. **触觉反馈**：所有可点元素 `active:scale-[0.98]`；悬停显示行内操作（对齐迅雷任务行交互习惯）。

### 7.2 反模式清单（实现评审硬性卡点）

- 禁用 Inter / Roboto / 系统默认字体；禁 emoji（一律 Phosphor 图标）。
- 禁纯黑 `#000`（用 `#0B0C0E`）、禁 AI 紫渐变、禁霓虹外发光（用 1px 内描边 `border-white/10` + 内阴影 `inset 0 1px 0 rgba(255,255,255,.06)` 的玻璃质感）。
- 禁三等分卡片横排；禁装饰性渐变背景出现在常规操作区。
- 禁用 `h-screen`（用 `100dvh` 语义）；禁 `calc()` 手写栅格（用 CSS Grid）。

### 7.3 设计 Token（`styles/tokens.css`，双主题）

```css
:root[data-theme='dark'] {
  --bg: #0B0C0E;            /* 应用底 */
  --surface: #131518;       /* 面板/悬浮层 */
  --surface-2: #1A1D21;     /* 行 hover */
  --border: rgba(255,255,255,.08);
  --text-1: #E6E8EB; --text-2: #8B909A; --text-3: #5C6370;
  --accent: #5AA0FF;        /* Electric Blue（深色提亮档） */
  --accent-press: #3E8BFF;
  --success: #34D399; --warning: #FBBF24; --danger: #F87171;
  --glass: rgba(19,21,24,.72);  /* 顶栏/对话框 backdrop-blur-xl + 1px 内描边 */
}
:root[data-theme='light'] {
  --bg: #F7F8F9; --surface: #FFFFFF; --surface-2: #F0F2F4;
  --border: rgba(15,23,42,.08);
  --text-1: #17181A; --text-2: #5C6370; --text-3: #9AA1AC;
  --accent: #2563EB; --accent-press: #1D4ED8;
}
/* 字体 */
--font-sans: 'Geist', 'MiSans SC', 'PingFang SC', 'Microsoft YaHei UI', sans-serif;
--font-mono: 'Geist Mono', 'JetBrains Mono', monospace;
/* 圆角 / 间距 */
--radius-ctl: 10px; --radius-panel: 14px; --radius-dialog: 18px;
--space-unit: 4px;   /* 全站 4 的倍数栅格 */
/* 动效 */
--spring: cubic-bezier(0.16, 1, 0.3, 1);   /* CSS 场景 */
/* Framer 场景统一 spring(stiffness:100, damping:20) */
```

### 7.4 信息架构

```
┌─ 侧边导航（72px，可折叠为纯图标 56px）
│   Logo OmniGet
│   全部任务 / 下载中 / 已完成
│   ── 分类 ──
│   种子与磁力(BT) / 视频 / 音乐 / 工具箱
│   ── 库 ──
│   回收站
│   ── 底部 ──
│   设置 ｜ 主题切换
└─ 工作区
    顶栏（玻璃拟态）：搜索任务 ｜ + 新建任务（主按钮）｜ 全局速度迷你图
    任务列表（虚拟滚动）
    底部状态栏：↓ 12.4 MB/s  ↑ 1.1 MB/s ｜ 运行中 6 · 排队 3 ｜ 引擎健康点 aria2 ● ytdlp ● music ●
```

主界面线框（深色）：

```
┌────┬──────────────────────────────────────────────────────────────┐
│ ▣  │  🔍 搜索任务…                        [ + 新建任务  ⌘N ]      │ ← 玻璃顶栏
│    ├──────────────────────────────────────────────────────────────┤
│ 全部│  正在下载 · 6                                    [暂停全部] │
│ 下载│  ──────────────────────────────────────────────────────────  │
│ 完成│  ▶ KJHDSUI21                          812.4 MB / 5.1 GB      │
│ BT  │    ├ 16 连接 · 4 peers        12.4 MB/s · 剩余 00:06:12      │
│ 视频│    ├ ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░  16%                              │
│ 音乐│  ──────────────────────────────────────────────────────────  │
│ 回收│  ▶ 周杰伦 - 晴天 [320k·网易云]         8.2 MB / 9.8 MB        │
│ 设置│    ├ 5.2 MB/s · 剩余 00:00:02  ♪ LRC 已就绪                   │
│    │    ├ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░  84%                          │
│    ├──────────────────────────────────────────────────────────────┤
│    │  ↓12.4MB/s ↑1.1MB/s  运行6·排3   aria2● ytdlp● music●      │ ← 状态栏
└────┴──────────────────────────────────────────────────────────────┘
```

- **任务行**（迅雷习惯的现代版）：首行 = 状态图标 + 名称 + 右侧体积；次行 = 引擎上下文（连接数/peers、平台徽标、音质）；第三行 = 细进度条（3px，强调色，暂停变灰、失败变红）+ 速度/ETA 等宽数字；hover 行尾浮出操作：`暂停/继续 · 置顶 · 打开目录 · 删除`。
- **Inspector（右侧 360px 抽屉，`layoutId` 共享元素过渡）**：任务大图进度、BT 的文件树+分文件进度+peer 列表、视频的格式与字幕信息、音乐的校验流水线状态（原唱命中/音频校验/歌词）、以及完整引擎日志。

### 7.5 新建任务流（核心交互，支持多源 + 线程数 + 文件勾选）

**入口**：`+ 新建任务`（⌘/Ctrl+N）、托盘菜单、剪贴板检测、拖入 `.torrent`、`magnet:` 协议唤起。

**对话框（640×520，`radius-dialog` 玻璃面板，spring 缩放入场）**：

```
┌────────────────────────────────────────────────────────────┐
│  新建任务                                              ✕   │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ ⛓ 粘贴磁力 / 视频链接 / 音乐名，或选择种子文件        │  │
│  │                                                      │  │
│  │  [ magnet:?xt=urn:btih:dc9e7581…              ] 粘贴 │  │
│  │  [ 选择 .torrent 文件 ]                              │  │
│  └──────────────────────────────────────────────────────┘  │
│   ↳ 已识别：磁力链接 · 30 个文件 · 需先获取元数据            │
│                                                            │
│  解析结果（文件树）                       [全选] [反选]      │
│  筛选: [视频] [音频] [图片] [其他] · [分辨率/体积] 🔍 搜索文件名 │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ ☑ V/                        4.9 GB                   │  │
│  │   ☑ VID_001.mp4    516.2 MB    ▓ 0%                  │  │
│  │   ☑ VID_002.mp4    510.8 MB    ▓ 0%                  │  │
│  │   ☐ promo.jpg         0.2 MB                         │  │
│  │ ☑ P/                          41 MB                  │  │
│  │   ☑ 001.jpg          1.8 MB                          │  │
│  └──────────────────────────────────────────────────────┘  │
│  已选 27/30 个文件 · 4.95 GB / 4.94 GB（排除 0.2 MB）       │
│                                                            │
│  多线程  ──●────────── 16 连接      ⓘ aria2 连接数/yt-dlp 并发分片 │
│  ☑ 原始画质（无水印） ⓘ 仅对抖音/快手等短视频生效      │  ← 短视频链接时显示
│  保存到  [ D:\Downloads            ] [浏览] [记住路径]      │
│  ☐ 下完即停（做种比例 0）    ☐ 下载完成后通知               │
│                                                            │
│                              [ 取消 ]  [ 立即下载 (27) ]    │
└────────────────────────────────────────────────────────────┘
```

**流程状态机**：

```
输入 → 自动嗅探 ─┬─ magnet:   → aria2 元数据(BEP-9) → 文件树 → awaiting
                 ├─ .torrent  → 本地 bencode 解析    → 文件树 → awaiting
                 ├─ 视频URL    → yt-dlp -J           → 格式选择器/合集勾选 → awaiting
                 │               （短视频：短链302还原 → 无水印format优先，§4.3.1）
                 ├─ 音乐名     → omni-service 搜索    → 音乐工作台(§7.6) → awaiting
                 └─ HTTP 直链  → HEAD 探测           → 单文件卡片（大小/文件名）→ awaiting
确认勾选 → threads 写入任务 → 提交引擎（aria2: select-file；yt-dlp: -f/--concurrent-fragments）
```

交互细节：

- **多线程滑杆**：1–64 档，轴上标注推荐区间（8–32）；拖动时实时显示将映射的引擎参数（aria2 `max-connection-per-server` / yt-dlp `--concurrent-fragments`）；BT 任务该项显示为" peers 上限"语义。
- **文件树勾选**：三态复选框（父节点半选）；目录行聚合大小；勾选即时重算"已选 N 个文件 · 合计 X GB"；`取消勾选`的文件在任务详情中始终可见，随时可增量补下（进行中任务走 `--select-file` 热更新；已完成任务走 re-add 流程，见 §4.5）。
- **解析中态**：磁力元数据等待期展示动画（雷达扫描 + "正在从网络获取文件清单…"），超时 90s 提示改用 tracker 重试。
- **错误态**：链接无法解析 → 输入框下方行内红字 + 平台兼容性提示（"该站点 yt-dlp 暂不支持或需要 cookie"）。

### 7.6 音乐工作台

```
┌──────────────────────────────────────────────────────────┐
│  搜索：  [ 陈奕迅 孤勇者                    ] [搜索]      │
│  支持自然语言："陈奕迅的孤勇者" / "陈奕迅,孤勇者"          │
├──────────────────────────────────────────────────────────┤
│  ✓ 孤勇者 — 陈奕迅        网易云 · high 320k   [下载]     │ ← 原唱校验命中
│  ○ 孤勇者 (Live) — 陈奕迅  网易云 · 有翻唱风险  [试听]     │ ← 原版度扣分项
│  ○ 孤勇者 — 陈奕迅        QQ音乐 · standard   [下载]     │
├──────────────────────────────────────────────────────────┤
│  音质： ( ) 标准 128k   (•) 高品 320k   ( ) 无损 FLAC     │
│  ⚠ 网易云搜索接口降级中 → 建议粘贴歌曲ID使用精确下载       │
└──────────────────────────────────────────────────────────┘
```

- 候选行标注**命中平台徽标、音质可用档位、原唱/翻唱风险**（继承 music-downloader 的校验结果，UI 直接呈现）。
- 支持**批量导入**：多行文本/文件粘贴（沿用脚本解析器），生成批量任务进入音乐队列。

### 7.7 迅雷参考对照（借鉴点收敛）

| 迅雷设计 | OmniGet 采用 | 差异化处理 |
|---|---|---|
| 居中"新建任务"大输入框 | ✔ 统一多源对话框 | 单框嗅探四类资源 + 解析后勾选 |
| 任务行内 hover 操作 | ✔ 暂停/置顶/删除浮出 | 操作图标统一 Phosphor，无多色噪音 |
| 左侧分组导航（全部/下载中/已完成/垃圾箱） | ✔ 同构 + 增加类型分组（BT/视频/音乐） | 分组计数徽标实时更新 |
| 底部状态栏（速度/免流提示） | ✔ 速度 + 引擎健康灯 + 迷你速度曲线 | 去广告位，纯运维信息 |
| 右侧任务详情侧滑 | ✔ Inspector 抽屉 | 增加 BT peer 表、音乐校验流水线可视化 |
| 悬浮速度球 | M4 可选：迷你悬浮窗（置顶小窗显示聚合速度） | 默认托盘速度替代，减少常驻遮挡 |
| 边下边播 | 不做转码播放 | 提供"打开目录 / 用系统播放器打开" |

### 7.8 动效规范（Framer Motion）

| 场景 | 规范 |
|---|---|
| 任务进出场 | `AnimatePresence` + `layout`：新任务从顶部 spring 落入，完成的任务折叠收敛进"已完成"分组 |
| 列表首载 | `staggerChildren`（每行 delay `index*40ms`，仅首屏 10 行） |
| 新建对话框 | `scale 0.96→1 + opacity` spring(100/20)；关闭反向 160ms |
| Inspector | `layoutId="task-inspector"` 共享元素从行卡片展开为抽屉 |
| 进度条 | 宽度用 `transform: scaleX`（禁 width 动画）；速度数字用 mono 滚动翻牌（可选） |
| 永续微动效 | 仅三处：空态插画缓浮（y ±4px）、扫描中磁力雷达、顶栏迷你速度曲线滚动；全部隔离为 memo 化叶子组件 |
| 性能红线 | 只动 `transform/opacity`；所有 spring 不用 linear easing；`will-change` 仅加在动画元素 |

### 7.9 键盘与快捷键

| 快捷键 | 动作 |
|---|---|
| `⌘/Ctrl+N` | 新建任务 |
| `Space` | 暂停/继续选中任务 |
| `⌘/Ctrl+F` | 搜索任务 |
| `Delete` | 移入回收站 |
| `⌘/Ctrl+1..6` | 切换左侧分组 |

---

## 8. 打包与分发

| 平台 | 目标 | 要点 |
|---|---|---|
| Windows | NSIS 安装包（x64） | sidecar 经 `extraResources` 按 `engines/win-x64/` 分发；NSIS 协议注册 `magnet:`；可选代码签名（EV 证书） |
| macOS | DMG（arm64 + x64） | ad-hoc 签名起步；公证（notarytool）待证书；`LSUIElement` 控制托盘行为；`CFBundleURLTypes`（Info.plist）注册 `magnet:` |
| Linux | AppImage + deb | FUSE 免安装运行；engines 目录同构；`magnet:` 协议运行时 `app.setAsDefaultProtocolClient` 注册 |

- **omni-service 构建**：`pyinstaller --onefile service/main.py`，产物按平台放入 `engines/<platform>/`；Python 依赖锁 `requirements.lock`（fastapi/uvicorn/requests + 移植的 music 模块）。
- **引擎更新策略**：yt-dlp 与 tracker 列表属"高频失效资产"——应用内置更新器从 GitHub Releases 拉取 yt-dlp 新版二进制（校验 SHA256），tracker 列表每日后台刷新（失败降级缓存）。信任模型为 **TOFU**（首次运行记录指纹，后续更新逐次比对；SHA256 清单与二进制同源发布，不做供应链级签名验证），§9 供应链条目同此口径。
- **自动更新**：electron-updater（GitHub Releases 通道），差分更新 + 更新前校验签名。
- **首次启动向导**：选择默认下载目录、主题（深色默认）、是否注册 `magnet:` 协议与剪贴板监听。
- **系统基线**：Windows 10+ / macOS 10.15+ / 主流 Linux 发行版（glibc 2.28+）；Electron 33 已不支持 Windows 7/8.1，官网与安装页明示最低要求。

---

## 9. 安全与合规

- **Electron 加固**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，渲染层仅经 preload 白名单 API；CSP：`default-src 'self'; img-src 'self' https: data:; media-src 'self' http://127.0.0.1:16801; connect-src 'self' http://127.0.0.1:16801`——`img-src` 放行 https 仅用于解析结果的封面缩略图预览（§4.3.2 防下错）；`media-src`/`connect-src` 仅放行回环 omni-service（音乐试听流），**不放行任何远程脚本**。CSP 放宽项与本产品功能一一对应，评审时逐条核对。
- **本地服务加固**：aria2 RPC 与 omni-service 仅绑定 `127.0.0.1`，RPC secret 启动时随机生成、仅经内存/命令行传给引擎子进程，落盘仅限用户数据目录下的 SQLite（POSIX 600 / NTFS ACL 限定当前用户，Windows 无单文件 600 模型）；omni-service 校验调用方 token（主进程启动时注入，经环境变量传递，不出现在进程列表参数中）。
- **下载内容合规**：设置页提供"内容来源声明"开关与免责提示；音乐模块保留 music-downloader 的**降级告警**行为（平台接口受限时明确提示，不静默抓取）。短视频去水印功能遵循"个人离线留存"定位：UI 明示不得二次分发受版权保护内容、不提供去平台元信息的批量处理；无水印直取仅选择平台本已对外提供的原始资源，不做破坏性破解。
- **隐私**：所有数据（任务库、cookie、设置）仅存本地；遥测默认关闭，仅崩溃转储可选手动上报。
- **供应链**：sidecar 二进制发布时记录 SHA256 并在启动时校验；electron-builder 产物提供校验和清单。

---

## 10. 路线图（按里程碑顺序，不含时间估计）

| 里程碑 | 范围 | 验收标准 |
|---|---|---|
| **M1 骨架 + BT/磁力/HTTP** | Electron 壳、任务模型、aria2 适配器、新建任务对话框（多源嗅探+文件树勾选+多线程滑杆）、托盘/协议注册 | 用 `dc9e7581…` 磁力完成"解析→勾选→多线程下载→断点续传→校验完成"全链路 |
| **M2 音乐** | omni-service 打包、音乐工作台、五平台回退、原唱校验/音频校验/歌词落盘、批量导入 | 五平台各完成一次下载；降级场景出现黄色告警而非失败 |
| **M3 视频** | yt-dlp 适配器、格式选择器、合集勾选、字幕/封面、cookie 注入、分片并发、短视频去水印（§4.3.1 三级策略）、转音频提取与预览/筛选增强（§4.3.2） | B 站 1080P 高码率 + YouTube 4K（有 cookie）各一次成功；抖音/快手分享短链各完成一次无水印直取，并覆盖一次 L2 候补场景；B 站视频转 320k MP3 一次成功 |
| **M4 打磨发布** | 双主题、动效细化、回收站、统计页（读 `daily_stats`，§5）、迷你悬浮窗、本地工具箱（§4.7）、自动更新、三平台打包 | 全部交互状态（骨架/空态/错误）评审通过；工具箱四件套（转换/裁剪/响度/分离 L1）各完成一次实测；安装包签名与更新链路可用 |

依赖关系：M2、M3 可并行（分别只依赖 M1 的任务模型与队列）。

---

## 11. 风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| 1 | yt-dlp 随平台改版频繁失效 | 视频任务失败率升高 | 应用内一键更新引擎二进制；解析失败引导"检查更新"，更新器独立于主版本发布 |
| 2 | 第三方音乐 API 不稳定（网易云搜索降级、QQ/汽水网络拦截、酷狗/咪咕接口变动） | 音乐任务失败 | 完整继承五平台回退链；降级时 UI 明确告警；提供"歌曲 ID 精确下载"兜底通道；omni-service 独立小版本热更 |
| 3 | aria2 RPC / omni-service 端口被本机其他软件占用 | 引擎启动失败 | 两引擎均端口探测自动顺延（16800/16801→16810）；omni-service 端口由主进程以环境变量下发；secret 强随机 |
| 4 | PyInstaller 单文件被杀软误报 | Windows 安装受阻 | onedir 备选打包；提交微软误报申诉；签名后误报率显著下降 |
| 5 | 磁力元数据获取慢/失败（冷门资源） | 用户卡在解析态 | 90s 超时 + 内置 tracker 每日刷新 + DHT 引导节点；UI 提供"改用 .torrent"出口 |
| 6 | 大任务列表渲染性能 | UI 掉帧 | 虚拟滚动 + 主进程 250ms 事件合并 + Zustand 切片订阅 |
| 7 | 版权与合规风险 | 产品分发受限 | 定位为通用工具、不内置任何资源站；内容声明开关；不提供任何站点导航 |
| 8 | 短视频去水印能力随平台风控失效（接口加密、签名校验升级） | 无水印直取失败率上升 | L1→L2→L3 三级降级（§4.3.1）；提取器通道走 yt-dlp 内置更新器热更；L3 后处理不依赖平台接口，永远可用；Inspector 如实标注处理级别 |
| 9 | 去水印内容被二次分发引发授权争议 | 品牌与法律风险 | 设置页明示"仅供个人离线留存，不得二次发布"；去水印默认关联回 `no_watermark` 任务级审计字段；不提供批量改写/去除平台元信息功能 |

---

## 附录 A：与参考脚本 torrent_dl.py 的能力对照

| 脚本能力 | OmniGet 承接 |
|---|---|
| bencode 解析 / infohash / 磁力生成 | Node 侧 `bencode` 库 + 设置页"种子信息"查看器（infohash 复制、磁力生成；base32→hex 归一化见 §4.2 解析流水线） |
| `--list` / `-k` 关键词过滤 | 文件树搜索框 + 类型快筛 |
| `--select 1,3,5-10 / VID,mp4` | 文件树三态勾选（等价 `--select-file`），保留按类型批量勾选 |
| `-x / -j / --seed-ratio / --port` | 多线程滑杆、并发设置、做种比例、端口设置 |
| DHT/LPD/peers/tracker 参数集 | 默认值继承脚本推荐值，可在设置·BT 高级中调整 |
| 磁力模式无法预览文件 | 由 BEP-9 元数据流程补齐（§4.2），补上脚本声明的短板 |
| 依赖系统 aria2c | 改为 sidecar 内置分发 + 自动更新，免安装 |

## 附录 B：music-downloader 能力承接清单

| 技能能力 | OmniGet 承接 |
|---|---|
| 五平台搜索/下载/歌词 | omni-service REST（§4.4），逻辑不重写 |
| 原唱校验 + 原版度打分 | 搜索结果行直接标注"原唱命中/翻唱风险" |
| 完整音频校验（≥1.5MB 原子落盘） | 保留，UI 校验流水线可视化 |
| 官方 LRC 优先的三级歌词回退 | 保留，任务详情显示歌词来源 |
| `--id` 精确下载兜底 | 歌曲卡片"用 ID 精确下载"入口 + 降级告警引导 |
| standard/high/lossless 三档 | 音质单选组（默认 high） |
| 批量文本/文件/Excel 解析 | 批量导入面板（文本/文件；Excel 由 M4 视需求增加） |
| 已知限制（§技能文档） | 全文落入 §11 风险表 #2 与产品告警文案 |
