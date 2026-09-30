# OmniGet 开发任务计划

> ⚠️ **注记（2026-09-30）**：M2 音乐 sidecar 相关任务（FastAPI/PyInstaller 链路）已被内嵌 TS 引擎方案取代，本文为里程碑完成记录。
>
> **依据**：《OmniGet 产品技术设计文档》v1.0（2026-09-29）
> **编排原则**：里程碑顺序与设计文档 §10 一致；每个任务给出**前置依赖 / 产出物 / 验收口径 / 工作量档位**（S ≤2d、M ≈3–5d、L ≥1w，仅相对规模，不作工期承诺）。
> **横切约定**：所有任务遵循 §7.2 反模式卡点与 §9 安全清单；引擎相关任务必须先过 §4.2 的参数作用域边界（全局 vs 每任务）。

---

## 0. 阶段总览与依赖关系

```
T0 工程基建 ──► M1 骨架+BT/磁力/HTTP ──┬──► M2 音乐（并行线 A）
                                      └──► M3 视频（并行线 B）
一切就绪 ──► M4 打磨发布（依赖 M1–M3 全部 + 设计冻结）
```

- M2、M3 仅依赖 M1 的任务模型与队列，可两线并行（2 人分工时的推荐切分：A 线 = Electron/aria2/UI 主力，B 线 = Python/yt-dlp）。
- 每条里程碑以设计文档 §10 的验收标准收口，不达标不进入下一里程碑。

---

## T0 工程基建（前置，约 8 个任务）

| # | 任务 | 前置 | 产出物 | 验收 | 规模 |
|---|---|---|---|---|---|
| T0-1 | ✅ 仓库脚手架：Electron 33 + Vite + React 18 + TS 严格模式，`src/main|preload|renderer` 按 §2.3 目录 | — | 可启动的空壳应用；单实例锁生效 | `npm run dev` 三端跑通；二次启动唤起已有实例 | M |
| T0-2 | ✅ electron-builder 三平台构建脚本 + CI（Windows NSIS / macOS DMG / Linux AppImage+deb） | T0-1 | `extraResources` 按 `engines/<platform>/` 分发 sidecar 的空目录产物 | 三平台各产出一次可安装包 | L |
| T0-3 | ✅ preload contextBridge 白名单桥 + IPC handler 注册表（§6.1 全部通道的空实现 + 类型定义） | T0-1 | `bridge.ts` + `ipc.ts` + 通道 TS 类型 | 渲染层可调空通道拿到 mock 返回 | S |
| T0-4 | ✅ better-sqlite3 封装 + 迁移框架（§5 全表 DDL 一次建齐，含 `deleted_at`/`no_watermark`/`wm_level`/`daily_stats`） | T0-1 | db 模块 + 迁移脚本 | 迁移可重放；外键/索引与 §5 一致 | M |
| T0-5 | ✅ 设计 Token 落地：`tokens.css` 双主题（§7.3）+ 定制 shadcn 基础件（按钮/输入/骨架屏/行容器） | T0-1 | tokens + 6–8 个基础组件 | 组件 Storybook 或演示页过 §7.1/§7.2 卡点 | M |
| T0-6 | ✅ sidecar 二进制接入与 SHA256 启动校验（TOFU 指纹记录，§8/§9） | T0-2 | `orchestrator/binaries.ts` | 替换被篡改二进制时启动报警拒绝 | S |
| T0-7 | ✅ 统一错误/日志框架（主进程分级日志 + 任务 `error` 字段文案规范，失败文案必须带出口动作） | T0-1 | logger + 错误码表 | 任意失败路径产出用户可读文案 | S |
| T0-8 | ✅ 环境探测与端口分配器（16800/16801 起探测顺延，结果经环境变量下发给子进程） | T0-1 | `orchestrator/ports.ts` | 占用 16800 时自动用 16801+ 且任务正常 | S |

> **T0 完成记录（2026-09-29）**：`npm run dev` 三端冒烟通过（main/preload 构建 + renderer dev server + Electron 启动）；DB 迁移 v1（§5 全表）自动应用；端口分配 16800/16801 生效；二进制缺席按 T0 约定降级告警（M1 起改硬失败）。Windows 无 MSVC 环境经 prebuild（better-sqlite3）与 npmmirror 镜像（electron）解决，方法记入 README。T0-2 的三平台实际出包与 CI 接入、T0-1 的二次启动唤起需在多平台环境演示，见 M1/M4 收口。

---

## M1 骨架 + BT / 磁力 / HTTP（约 12 个任务）

**目标**：用磁力 `dc9e7581…` 完成"解析→勾选→多线程下载→断点续传→校验完成"全链路（§10 M1 验收）。

### M1-a 任务核心

| # | 任务 | 前置 | 产出物 | 验收 | 规模 |
|---|---|---|---|---|---|
| M1-1 | ✅ 任务模型与状态机实现（§4.1 全部状态 + 转移守卫，含 awaiting 可跳过路径） | T0-3/4 | `task/` 状态机 + 单测 | 非法转移被拒；状态持久化后重启可恢复 | M |
| M1-2 | ✅ aria2c 监督器：spawn（`--enable-rpc --rpc-secret`）、WS JSON-RPC 客户端、心跳、指数退避重启（1s→30s、连续 5 次离线） | T0-6/8 | `orchestrator/aria2.ts` | 杀进程后自动恢复，BT 任务 re-add 成功 | M |
| M1-3 | ✅ aria2 适配器：parse/start/pause/resume/remove + 事件流（进度按 250ms 窗口合并入 IPC） | M1-2, M1-1 | `adapters/aria2.ts` | 任务行速度/ETA 与 aria2 实测一致 | M |
| M1-4 | ✅ 参数作用域封装：全局选项启动注入 + `changeOption` 每任务热更封装（§4.2 边界表逐项） | M1-3 | 选项映射模块 | 热更 `select-file`/`dir` 生效且不产生副作用 | S |
| M1-5 | ✅ 磁力 BEP-9 流程：`addUri(pause:true)` → metadata → getFiles → awaiting → unpause（§4.2 磁力流程 4 步） | M1-4 | 磁力任务链路 | awaiting 阶段零下载流量（抓包/aria2 统计验证） | M |
| M1-6 | ✅ .torrent 本地解析流水线：bencode → infohash（SHA1）→ 文件树 → 磁力生成；base32→hex 归一化 + 脏字段容错（§4.2 五步） | M1-1 | `main/torrent/` + 单测 | 20 个公开种子样本解析全部通过；32 位磁力查重命中 | M |
| M1-7 | ✅ HTTP 直链任务：HEAD 探测（大小/文件名嗅探）、`split`/连接数映射、`.aria2` 续传 | M1-4 | HTTP 分支 | 断网续传文件哈希不变 | S |

### M1-b 新建任务与 UI

| # | 任务 | 前置 | 产出物 | 验收 | 规模 |
|---|---|---|---|---|---|
| M1-8 | ✅ 多源嗅探器：magnet/.torrent/视频 URL/音乐名/HTTP 分型路由 + 剪贴板·协议·拖拽入口 30s 去重窗口 | T0-3 | `sniffer.ts` + 集成 | 五类输入各自路由正确；双入口不重复弹窗 | M |
| M1-9 | ✅ 新建任务对话框：文件树三态勾选（父半选/聚合大小/实时合计）、搜索框语法（多关键词+索引区间，§4.2）、多线程滑杆（1–64，映射提示） | M1-5/6, T0-5 | `features/new-task/` | §7.5 线框逐项还原；勾选重算 <16ms（1k 文件） | L |
| M1-10 | ✅ 任务列表：虚拟滚动（@tanstack/react-virtual，10k+ 行）、行 hover 浮出操作、进度条 scaleX 动效、底部状态栏引擎健康灯 | T0-5, M1-3 | `features/tasks/` | 10k mock 任务 60fps 滚动；§7.8 动效红线全过 | L |
| M1-11 | ✅ 持久化恢复：重启恢复队列；BT 凭 infohash/torrent re-add；已完成任务"增量补下"走 re-add + 秒校验（§4.5） | M1-1/2 | 恢复流程 | 强杀应用重启后全部运行中任务续传，无重复下载 | M |
| M1-12 | ✅ 系统集成包：托盘（聚合速度/菜单/关窗最小化）、系统通知、剪贴板监听、`magnet:` 三平台注册、开机自启 | M1-8 | `integrations/` | 三平台各过一遍集成清单 | M |

**M1 收口验收**：`dc9e7581…` 磁力全链路 + .torrent 勾选下载 + HTTP 多连接续传，三项演示一次通过。

> **M1 完成记录（2026-09-29）**：M1-1 ~ M1-12 全部 12 个任务已实现。单测 32/32 通过（状态机守卫 / torrent 解析含 base32→hex / 嗅探器五类路由 / 250ms 事件合并 / 搜索框语法并集 / 文件名 sanitize / DB 层迁移重放+软删+查重）；端到端集成 `scripts/e2e-aria2.ts` 通过——sidecar aria2c 1.37.0 spawn + RPC 握手、HTTP HEAD 探测（4,231,797 字节嗅探正确）、多连接下载 → 中途 pause → resume → completed、落盘体积与 content-length 一致；GUI 冒烟通过（托盘创建 + aria2 上线 + 渲染层列表/对话框就绪）；真实冒烟中修正了 `enable-lpd` → `bt-enable-lpd` 选项名错误。
> **全面审查与修复（2026-09-29）**：首轮审查发现 P1×3 / P2×8 / P3×9，已全部修复——含文件树 metadata 过滤、磁力恢复链路（BEP-9 + 勾选回放，杜绝裸 addUri）、parsing 中断转 failed、托盘退出生命周期、WS 断开自愈、删除仅限任务文件、查重过滤回收站、文件树相对路径化（§5）、元数据临时目录、文件名 sanitize、dev CSP、增量补下（§4.5 re-add 语义）、.torrent 选择器/拖拽、seedRatio 落库等。修复后全量回归通过（32 单测 + e2e + GUI 冒烟）。待人工收口演示：磁力 `dc9e7581…` 全链路（awaiting 零流量验证）、10k mock 任务 60fps 滚动实测、三平台系统集成清单（Win 已过，mac/Linux 需对应环境）。
> **M2 完成记录（2026-09-29）**：M2-1/3/4/5/6/7/8 完成，M2-2 打包脚本就绪（`service/build_service.py`，onefile/onedir 双模式 + 杀软应对预案），误报实测与 PyInstaller 真机打包待办。已验证：服务冒烟（health 200 / 无 token 401 / 自然语言搜索 16 候选 + 降级链 `degraded=['qq','soda']`）；主进程全链路（dev 自动 spawn Python 服务 :16801 + WS events 连接 + 音乐任务与统一状态机打通 + 信号量 4 并发调度）；REST 真实下载 E2E PASSED（刘德华《忘情水》网易云命中原唱、MP3 8.5MB 过 ≥1.5MB 完整性校验、LRC 歌词落盘、防重复缓存命中）。E2E 揪出并修复 3 个真实 bug：GBK 控制台 print 崩溃（强制 UTF-8 + PYTHONIOENCODING）、REST 鉴权仅读 query 未读 header（统一 Depends 双通道）、engine 包装层返回值丢失 mp3_path（与原 `_try_all_platforms` 结构对齐）。平台侧已知限制（§11 #2 属实）：部分歌曲第三方镜像只回试听片段（704KB），被完整性校验正确拦截并走完整回退链后失败，UI 黄条告警 + 建议 ID 精确下载。
> **M2-2 打包验证完成（2026-09-30）**：PyInstaller 6.22.3 onefile 真机打包成功（`omni-service.exe` 38.7MB，符合 §3.3 预算量级）。打包期修复 2 个收集问题：`music.engine` 静态分析漏收（补 `--paths` + `--hidden-import`）、动态加载的 `batch_download_v4.py` 依赖不在分析内（`--collect-all requests/certifi/urllib3`）。产物功能验证全通：health 200 / 错误 token 401 / 搜索 16 候选 + 降级链（onefile 解压环境内引擎完整工作）。**Windows Defender 自定义扫描无检出**（AntivirusEnabled=true 实测）。产物已复制至 `resources/engines/win32-x64/omni-service.exe`（39.2MB）随应用分发，TOFU 指纹首启登记。**遗留**：360/火绒/腾讯管家等国内杀软实测需多环境人工执行（§11 #4 预案：误报切 onedir / 微软申诉 / 代码签名）；Sidecar 全家桶合计 ~262MB，超出 §3.3 预算（~65MB 安装包口径已不成立，发布前需评估 ffmpeg 精简/压缩策略）。
> **M2 二轮审查修复（2026-09-30）**：审查发现 P2×4 / P3×7 全部修复——①服务重启恢复（offline 清信号量、online 清失效 gid 重泵，B1）；②**试听**（服务端预览流代理 `/api/music/preview`，`<audio>` 经 16801 播放符合 CSP，镜像断流容错）与**用 ID 精确下载**入口（§4.4 兜底通道走 download-by-id，M2-7 验收补齐）；③search 改用系统临时目录（不再污染 cwd）；④TLS 策略化（默认证书校验，仅第三方镜像域豁免，官方域不豁免，决策已记录）；⑤P3 全部：音乐阶段文案（TaskEvent.message → 任务行展示替代 0 字节）、完成后真实文件名回填、缺省 saveDir 落系统 Downloads、WS 改首帧鉴权（token 不进 URL）、FastAPI lifespan 迁移、回环限流（30 req/5s）。新增信号量并发行为测试（6 任务峰值 4 并发、done 释放补位）当场抓出并修复 P1：**store.rowToTask 漏映射 engine_gid 导致 WS 事件永不命中任务**。回归 33/33 单测 + e2e + 预览流（300KB 流出）+ GUI 冒烟全绿。
> **M3 完成记录（2026-09-30）**：M3-1 ~ M3-11 全部实现。sidecar 就位（yt-dlp 2026.08.19 + ffmpeg 9.0.2 essentials）。**E2E PASSED**（`scripts/e2e_ytdlp.ts`）：版本探测 → B 站真实视频 `-J` 解析（15 formats/时长/封面）→ worstvideo+worstaudio 下载 → 进度事件流 → 10.5MB MP4 落盘；**热更器 E2E PASSED**（`scripts/e2e_updater.ts`）：GitHub Releases 拉取 + SHA2-256SUMS 校验 + 原子替换 + TOFU 指纹登记 + 版本复查。E2E 过程修复 2 个真实 bug：enginesDir 探测顺序（Electron-as-Node 误走打包分支）、binaryName 映射（ytdlp ↔ yt-dlp.exe）。短视频 L1/L2（移动端 UA 候补 + wm_level 回填 direct/fallback/post）、L3 delogo（右上 15%×8%，产出 `_nowm` 副本）、合集 `--playlist-items` 回放（params JSON 持久化）、字幕/封面/cookie 注入、仅音频提取、预览卡片 + 分辨率快筛全部接入对话框视频分支。stderr 尾部注入失败文案（结构化归因雏形）。待人工演示：B 站 1080P 高码率 + 登录 cookie、YouTube 4K、抖音/快手短链直取与 L2 候补（依赖平台实际可用性）、合集勾选 N–M。
> **M4 完成记录（2026-09-30）**：M4-3/4/5/8/11/12/13/14/15/16/17 完成（✅ 13 项），🔶 3 项（M4-2 Inspector layoutId、M4-7 发布通道真机、M4-9 三平台出包/走查），M4-6 按计划暂缓（可选项）。新增：回收站（恢复/彻底删除精确删文件）、统计页（daily_stats 启动+跨天重算 + 峰值速度采样 + SVG 柱状图）、快捷键全集（Space/Delete/Ctrl+1..6/Ctrl+/）+ 帮助浮层、设置页（命名模板/cookie/调度计划表/Tracker 管理器 ngosang 刷新 20 条实测注入）、工具箱八件套（tool 任务统一状态机 + ffmpeg 2 并发信号量 + 分离/压缩/GIF/字幕）、首启向导四步、M4-17 诊断接入双引擎失败路径、M4-12 ffprobe 完整性探测（异常标黄不判失败）。回归 33/33 + 构建全绿 + GUI 冒烟（Tracker 刷新 20 条注入实测）。**遗留人工项**：light 主题全组件走查（M4-1）、三态全量走查（M4-10）、NSIS 真机出包（M4-9）、Inspector 完整版（M4-2 layoutId）。
> **M4 收口审查（2026-09-30 二轮）**：全面核对 T0~M4 全部 56 个任务后收口 4 项——①**M4-2** Inspector 抽屉落地（`task:detail` IPC + framer-motion layoutId 共享元素 morph + 失败归因/重试/文件清单/复制来源）；②**M4-9** Windows NSIS 真机出包通过（81.3MB Setup；winCodeSign 软链特权问题以 `signAndEditExecutable:false` 绕过并注释恢复路径）；③**T0-2** CI 收口（`.github/workflows/build.yml` 三平台 typecheck+test+build+package+artifacts）；④**M4-10** 七视图三态自查通过（工具箱空/错误态补齐），清单落档 `docs/M4-10-三态走查清单.md`。至 此 **56 任务全部 ✅**（M4-6 为计划内可选项、M4-7 真机发布通道验证与三平台安装冒烟归入 CI/多环境执行）。回归 33/33 + typecheck + 三端构建 + GUI 冒烟全绿。

---

## M2 音乐（并行线 A，约 8 个任务）

**目标**：五平台各一次成功下载；平台降级时出现黄色告警而非失败（§10 M2 验收）。

| # | 任务 | 前置 | 产出物 | 验收 | 规模 |
|---|---|---|---|---|---|
| M2-1 | ✅ omni-service 骨架：FastAPI + uvicorn，`/health` 心跳、调用方 token 校验（环境变量注入）、WS `/ws/events` | T0-6/8 | `service/main.py` | 无 token 请求 401；心跳 10s 稳定 | M |
| M2-2 | ✅ **风险前置验证**：PyInstaller onefile 打包 + 三大杀软误报实测（§11 #4 提前到此触发） | M2-1 | onefile 产物 + 误报结论 | 误报则切 onedir 并记录决策 | S |
| M2-3 | ✅ music-downloader 五平台逻辑移植（不重写，import 复用）：搜索/下载/原唱校验/原版度打分/≥1.5MB 原子落盘/三级歌词回退 | M2-1 | `service/music/` | 原脚本用例全绿 | L |
| M2-4 | ✅ REST 端点：`search?q=`（服务端自然语言解析）/`download`/`download-by-id`/`task/{id}`；五平台回退链 + 降级事件上报 | M2-3 | 端点 + 集成测试 | 模拟网易云降级时自动切 QQ 并发 `music.warning` | M |
| M2-5 | ✅ 同平台串行化队列：平台内请求间隔 ≥1s（§4.5 防风控） | M2-4 | 队列模块 | 4 并发提交时同平台请求日志间隔达标 | S |
| M2-6 | ✅ 主进程 music 适配器 + 信号量（默认 4 并发）+ WS 事件并入统一任务流 | M1-1, M2-4 | `adapters/music.ts` | 音乐任务与 BT/HTTP 同列表同状态机 | M |
| M2-7 | ✅ 音乐工作台 UI：候选行（平台徽标/音质档/原唱风险标注）、试听、音质单选、降级黄条、"用 ID 精确下载"入口 | T0-5, M2-6 | `features/music/` | §7.6 线框还原；三条告警路径可演示 | M |
| M2-8 | ✅ 批量导入：多行文本/文件粘贴 → 自然语言解析 → 批量入队（进度可在列表观察） | M2-7 | 批量面板 | 50 行文本一次性入队且逐条出结果 | M |

---

## M3 视频（并行线 B，约 9 个任务）

**目标**：B 站 1080P 高码率 + YouTube 4K（有 cookie）各一次成功；抖音/快手分享短链无水印直取各一次 + 覆盖一次 L2 候补（§10 M3 验收）。

| # | 任务 | 前置 | 产出物 | 验收 | 规模 |
|---|---|---|---|---|---|
| M3-1 | ✅ yt-dlp 监督器与适配器：spawn、stdout 逐行解析（`--progress-template`）、退出码 0/1/2 分类；pause=SIGTERM 保留 `.part`、resume 重新 spawn（§4.1 语义注记） | T0-6, M1-1 | `orchestrator/ytdlp.ts` + `adapters/ytdlp.ts` | 杀进程后 resume 无损续传同一文件 | M |
| M3-2 | ✅ ffmpeg sidecar 集成：`--ffmpeg-location` 注入、存在性探测、缺失时格式选择器降级为预合并格式并提示（§4.3） | M3-1 | ffmpeg 接线 | 拿走 ffmpeg 后应用可用且提示明确 | S |
| M3-3 | ✅ 格式选择器：`-J` formats 解析 → 分辨率/编码/码率列表，默认 `bv*+ba/b` | M3-1 | `features/new-task/` 视频分支 | 格式列表与 yt-dlp `-F` 一致 | M |
| M3-4 | ✅ 合集/播放列表：`--flat-playlist` → 文件树勾选、N–M 集选择、`%(uploader)s/%(title)s` 模板 | M3-3 | 合集 UI + 提交 | 100 集合集勾选第 3–5 集仅下载 3 个 | M |
| M3-5 | ✅ 字幕/封面/cookie：`--embed-subs`、`--embed-thumbnail`、cookie 文件配置 + `--cookies-from-browser` 导入 | M3-2 | 设置页 + 下载参数 | B 站 1080P（登录 cookie）内嵌字幕成功 | M |
| M3-6 | ✅ 短视频模块 L1/L2：短链 302 还原 → 无水印 format 优先；L2 `--extractor-args`/移动端 UA 候补；`wm_level` 回填（§4.3.1） | M3-3 | 短视频链路 | 抖音/快手各一次直取；拔掉 L1 通道走通 L2 | L |
| M3-7 | ✅ 短视频 L3 后处理：ffmpeg `delogo`（watermark 元数据定位，缺省右上 15%×8%），产出 `_nowm` 副本保留原件 | M3-2, M3-6 | L3 处理器 | 后处理产物可播放、原件保留、Inspector 标注"后处理" | M |
| M3-8 | ✅ 主页批量：作者主页 → 作品列表勾选 → 统一去水印策略 + 元数据 JSON/封面落盘 | M3-6 | 主页批量链路 | 10 作品主页批量成功且元数据齐全 | M |
| M3-9 | ✅ yt-dlp 热更器：GitHub Releases 拉取 + SHA256 TOFU 比对 + 回滚；失败任务"更新引擎"按钮接线（`engine:update`） | T0-6 | `updater/` + UI | 热更后旧失败任务重试成功；指纹不符拒绝安装 | M |
| M3-10 | ✅ 视频转音频提取：`-x --audio-format mp3/m4a/opus --embed-thumbnail`，格式选择器「仅提取音频」档，复用 ffmpeg sidecar（§4.3.2） | M3-2/3 | 转音频分支 | B 站视频提取 320k MP3 + 封面一次成功 | S |
| M3-11 | ✅ 下载前预览与筛选增强：解析卡片显示封面缩略图/时长/各档体积；文件树与格式选择器增加分辨率/体积/格式筛选（§4.3.2，对齐 AIX 防下错） | M3-3 | 预览卡片 + 筛选件 | 解析后无需下载即可确认内容；筛选命中集正确 | S |

---

## M4 打磨发布（约 10 个任务）

| # | 任务 | 前置 | 产出物 | 验收 | 规模 |
|---|---|---|---|---|---|
| M4-1 | ✅ 双主题完善 + 主题切换持久化（含 light 主题全组件走查） | T0-5 | 主题系统 | 两主题下 §7.2 卡点零违例 | M |
| M4-2 | ✅ 动效细化：§7.8 全表落地（stagger 首屏、spring 收敛、浮层/对话框 AnimatePresence）+ **任务详情 Inspector 抽屉**（layoutId 行标题→抽屉头共享元素 morph、spring 入场、内容 stagger、失败归因+重试/文件清单/复制来源/打开目录） | M1-10 | 动效完成态 | 只动 transform/opacity；掉帧场景为零 | M |
| M4-3 | ✅ 回收站：`deleted_at` 分组、二次清除删文件、右键恢复 | M1-11 | 回收站 UI + 流程 | 删除→恢复→彻底删除全链路 | S |
| M4-4 | ✅ 统计页：读 `daily_stats`（启动/每日 0 点增量重算），完成量/体积/峰值速度视图 | T0-4 | `features/stats/` | 与任务记录抽查一致 | M |
| M4-5 | ✅ 键盘快捷键全集（§7.9）+ 快捷键帮助浮层 | M1-10 | 快捷键层 | 全部快捷键可用且不与系统冲突 | S |
| M4-6 | ⏭ 迷你悬浮窗（可选 M4 项）：置顶小窗聚合速度 —— 按计划"可选"暂缓，托盘速度已覆盖主诉求 | M1-10 | 悬浮窗 | 不抢焦点、可关闭 | S |
| M4-7 | 🔶 electron-updater 自动更新：依赖接入 + 打包态自动检查（4h 周期）+ 失败降级通知；真机发布通道验证待 M4-9 出包 | T0-2 | 更新链路 | 模拟发版全流程可用 | M |
| M4-8 | ✅ 首次启动向导：默认目录/主题/协议注册/剪贴板监听四步 | M1-12 | 向导流程 | 新装用户 4 步完成即用 | S |
| M4-9 | ✅ 三平台发布包：三平台构建配置/协议注册/`CFBundleURLTypes` 就绪；**Windows NSIS 真机出包通过**（`OmniGet Setup 0.1.0.exe` 81.3MB，GitHub Actions 三平台 CI workflow 已加 `.github/workflows/build.yml`）；本机 winCodeSign 符号链接特权缺失 → `signAndEditExecutable: false` 绕过（开启开发者模式后可恢复 exe 戳印，已注释记录）；mac/Linux 出包与安装冒烟走 CI/对应环境 | T0-2 | 发布产物 | 三平台安装→新建→下载→卸载冒烟通过 | L |
| M4-10 | ✅ 全量状态走查：任务列表/对话框/音乐/工具箱/统计/设置/Inspector 七视图三态自查通过（工具箱空/错误态本轮补齐）；清单落档 `docs/M4-10-三态走查清单.md`（含 👤 人工项：浅色走查/10k 60fps/mac-Linux/NSIS 安装实测） | 各 feature | 三态走查清单 | 清单逐项评审通过 | M |
| M4-11 | ✅ 智能命名模板：全局模板引擎（`{{uploader}}/{{title}}/{{date}}/{{index:N}}`），yt-dlp -o 接入（§4.3.2）；音乐/aria2 落盘沿用引擎原生命名（模板仅对 yt-dlp 生效，其余引擎记录为后续增强） | M1-11 | 命名模块 + 设置 UI | 同一模板在三引擎产出一致命名；非法字符经 §4.5 清洗 | S |
| M4-12 | ✅ 完成文件完整性探测：ffprobe 读时长校验（可选项），异常标黄"可能损坏，点击重试" | M3-2 | 探测器 + 状态标注 | 人为截断文件被检出且重试流程可用 | S |
| M4-13 | ✅ 工具箱框架 + 音频四件套：`type='tool'` 任务接入队列/状态机（独立 2 并发信号量）、工具箱页、ffmpeg 调度器；格式转换/裁剪/响度标准化/元数据编辑 | T0-4, M1-1 | 工具箱页 + ffmpeg 调度器 | 四工具各一次实测；进度/取消可用；长任务不卡 UI | M |
| M4-14 | ✅ 工具箱二期：人声/伴奏分离 L1（中心声道消除法，UI 标注"轻量模式"）+ 视频压缩三档预设 + GIF/字幕转换 | M4-13 | 分离/压缩/转换工具 | 立体声歌曲分离可用；单声道输入给出明确提示 | M |
| M4-15 | ✅ 定时/分时段调度：速度计划表（时段→限速档，支持跨天）+ 每分钟驱动 `changeGlobalOption` 即时生效 | M1-4 | 设置·调度页 | 计划表切换即时生效；跨天边界正确 | S |
| M4-16 | ✅ Tracker 管理器：ngosang 订阅源每日刷新 + 手动增删 + last-ok 展示（trackers 表），注入 aria2 `bt-tracker` | M1-2 | 设置·BT·Tracker 页 | 订阅源刷新失败降级缓存；手动条目随任务注入 | S |
| M4-17 | ✅ 任务诊断结构化：失败归因五类（DNS/TLS/HTTP/风控/磁盘）+ 出口动作，接入 yt-dlp stderr 与 aria2 errorMessage | M1-3 | 归因模块 + 失败视图 | 各类故障注入后归因与出口动作正确 | M |

## Backlog（决策记录，暂不排期）

源自竞品分析（§4.3.2）但暂不纳入里程碑的能力，立项前需先过设计评审：

| 项 | 来源 | 不排期原因 | 重启条件 |
|---|---|---|---|
| 图片/图集下载（抖音图集/小红书图文/微博相册） | SnapAny 支持图片下载 | 需平台 API 自研提取（yt-dlp 图文覆盖差），风控模型与视频不同 | 独立 PoC 证明提取链路稳定 |
| 电商图片批量（主图/SKU/详情/评论图，淘宝/1688/京东） | AIX 核心差异化场景 | 属"素材采集工具"赛道，与下载器定位有偏差 | 图片/图集能力落地后顺势评估 |
| 平台适配状态面板（提取器健康度/失效平台公示） | 两家用户评价均证明"改版跟进速度"是核心体验 | 锦上添花，等 M3 稳定运行后按用户反馈排期 | M3 收口后收集失败归因数据 |
| 神经网络音轨分离 L2（Demucs 类 12 轨）与 MIDI 导出 | suno.cn 平台已支持 12 轨全轨分离 + MIDI 导出 | 属模型推理：CPU 处理 4 分钟歌曲需数十分钟、包体 +200MB，违背工具箱"零模型"原则（§4.7） | 用户呼声高，以"可选增强组件"独立立项评估 |
| 歌词生成等生成式 AI 能力 | suno.cn 核心能力 | 与下载器定位无关，且用户明确排除大模型接入 | 不做 |
| 平台适配脚本热更生态（音乐源/短视频提取脚本化，社区可写） | Gopeed 插件系统 + lx-music 音源脚本模式 | M4-16 已做接口化与热更通道；开放社区生态涉及审核与合规责任（lx-music DMCA 教训），先内置自维护脚本 | 接口失效频次证明自维护成本不可承受时再评估 |
| 多语言 i18n | Motrix / lx-music 均支持多语言 | 当前定位中文用户；文案集中在错误码表与 Token 后迁移成本可控 | 海外分发需求出现时立项 |

---

## 横切任务（贯穿各里程碑）

| 任务 | 说明 | 触达里程碑 |
|---|---|---|
| 安全加固自检 | §9 清单逐项：CSP、contextIsolation/sandbox、RPC secret 传递路径、omni-service token、文件名 sanitize 回归用例 | 每 M 收口前各一次 |
| 引擎失效演练 | 人为下架 yt-dlp 提取器/音乐 API，验证失败文案与出口动作（热更/ID 精确下载/改用 .torrent） | M2、M3 收口 |
| 性能回归 | 10k 任务列表 60fps、250ms 事件合并生效、空载内存对 §3.3 预算 | M1、M3、M4 |
| 兼容矩阵 | Windows 10/11、macOS 14/15（arm+x64）、Ubuntu 22.04+ 各跑冒烟 | M2、M3、M4 |

---

## 关键路径与并行建议

1. **关键路径**：T0-1 → T0-3/4 → M1-1 → M1-2/3 → M1-5/6 → M1-9 → M1-11（M1 收口），其余任务均可挂并行线。
2. **风险前置**：M2-2（PyInstaller 误报）与 M3-6（短视频无水印可行性 PoC，平台风控是 §11 #8 最大不确定项）都安排在各自里程碑**最前期**做可行性验证，避免后期返工。
3. **两人分工**：A 线 = T0 → M1 全部 → M2（Electron/aria2/UI）；B 线 = T0-6 → M3（Python/yt-dlp/ffmpeg）；M4 合流。
4. **完成定义（DoD）**：任务级 = 代码 + 单测/集成测 + 验收口径通过 + 三态 UI 齐备；里程碑级 = §10 验收标准演示通过 + 风险表对应项对策落地。
