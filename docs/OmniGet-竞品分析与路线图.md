# OmniGet 产品规划：竞品分析与路线图（Backlog v2）

> 2026-10-01。基于 GitHub 同类项目的调研分析，替代/接续《OmniGet-开发任务计划.md》的 Backlog 章节。
> 2026-10-02 文档整理：原《OmniGet-开发任务计划.md》（56 任务全部 ✅，纯历史存档）压缩为「里程碑完成存档」并入本文末章，原文件删除；任务验收口径溯源至《OmniGet-产品技术设计文档》§10。
> 结论先行：**OmniGet 的差异化锚点 = 「下载 + 音乐/视频引擎 + 本地工具箱」三合一**；最大能力缺口 = **浏览器扩展生态**与**队列自动化**。

---

## 一、竞品深度分析（9 款）

### 1. Motrix（~51K★，Electron + aria2）
- **能力**：HTTP/FTP/BT/磁力/Metalink/ED2K 全协议、界面精美、全平台
- **现状与启示**：核心仓库近乎停更（社区分叉 Motrix-Next/IMFile 接棒）——Electron+aria2 技术路线已被验证可支撑 50K★ 体量，但**引擎侧单点依赖 aria2** 的项目在 aria2 停更后陷入被动。OmniGet 的多引擎（aria2+yt-dlp+内嵌音乐引擎）架构是正确的对冲。
- **可借鉴**：系统托盘体验、任务分组 UI；**应规避**：单引擎锁定。

### 2. Gopeed（~21K★，Go + Flutter）
- **能力**：HTTP/BT/磁力、全平台原生、轻量、**插件生态（JS 扩展）**、Web UI
- **启示**：Go+Flutter 的性能/包体优势明显；其 JS 插件生态与 lx-music 音源脚本同源——OmniGet 的适配脚本注册表（声明式 host 重写）是合规的中间形态，**不建议**升级为任意代码执行。
- **可借鉴**：Web UI 远程访问（局域网手机提交任务到桌面端）。

### 3. AB Download Manager（~15K★，Windows/Linux/Android）
- **能力**：动态分片加速、**浏览器扩展自动拦截网页下载**、下载队列、计划任务、按类型自动归档；社区评价「比 IDM 年轻十年」
- **启示**：是当前与 IDM 体验最接近的开源选手，其成功点高度集中在「浏览器扩展 + 队列自动化」——这正是 OmniGet 的两大空白，列为最高优先级。

### 4. File Centipede（文件蜈蚣，C++/自研）
- **能力**：HTTP/FTP/SSH/WebDAV/BitTorrent 全协议、浏览器扩展抓视频（含加密流）、**内置工具箱（HTTP 请求器、URI 编解码、种子创建/转换、校验和计算）**、WebDAV/FTP 文件管理器
- **启示**：「下载器 + 工具箱」组合已被验证有用户价值，与 OmniGet 的 ffmpeg 工具箱定位互相印证；其工具箱偏「网络/文件向」，OmniGet 偏「音视频向」，互补不重叠。
- **可借鉴**：校验和计算、种子创建等轻工具补充。

### 5. MediaGo（Go + 前端 Web UI）
- **能力**：**浏览器插件嗅探网页视频**、M3U8 直播/点播下载、**Docker 无头部署 + Web UI 远程访问**、追剧订阅
- **启示**：嗅探型下载（而非 yt-dlp 通用提取）在国内站点覆盖上更即时；Web UI 远程是差异化卖点。

### 6. Stacher 7（yt-dlp GUI，Electron）
- **能力**：yt-dlp 全参数图形化、**配置预设（Preset）体系**、批量队列、格式选择器
- **启示**：**「命令参数 → 可保存/分享的预设」**是 yt-dlp GUI 的成熟交互范式，OmniGet 的下载参数（格式/字幕/cookie/命名模板）可收敛为预设。

### 7. yt-dlp-gui / VidBee（Tauri + Vue 新生代）
- **能力**：轻量（Tauri 包体优势）、1000+ 站点、现代 UI
- **启示**：Tauri 阵营包体 ~10MB vs OmniGet ~81MB——**安装包瘦身（Sidecar 裁剪/按需下载引擎）**需提上日程（§11 已有 262MB 超预算记录）。

### 8. IMFile（Motrix 分叉增强）
- **启示**：分叉生态证明 Motrix 用户存在未被满足的诉求（更新停滞+功能增强）；OmniGet 的持续维护本身就是竞争力。

### 9. 横向参照（IDM/FDM/JDownloader）
- IDM：动态分段 + 浏览器集成 = 行业基准；FDM：队列/计划/类型归档；JDownloader：**链接抓取（LinkGrabber）+ 批量自动化 + 验证码处理**
- 共同结论：**「浏览器扩展 + 批量链接抓取 + 队列调度」是下载器的三条标配护城河**。

### 10. 二轮深挖（2026-10-02，新增 10 款）

> 完整条目与待办已并入 `docs/backlog.md` §六（#16–#24），此处仅记结论。

- **yt-dlp 前端代**：MeTube（自托管 Web UI，2026-08 仍在更新）、VidBee（活跃，捆绑 Node 解决 yt-dlp JS 运行时）、Parabolic、Seal（Android，yt-dlp+ffmpeg+aria2 三件套内嵌）
- **⚠ 全生态硬变更**：yt-dlp 自 2025-11 起下载 YouTube 需外部 JS 运行时（Deno/Node + yt-dlp-ejs，官方 issue #15012）——OmniGet 引擎 2026.08.19 已在此变更之后，**YouTube 兼容性需立即排查**（backlog #16 🔴）
- **流媒体引擎带**：N_m3u8DL-RE（DASH/HLS/MSS + AES 解密 + 直播，MediaGo 内核）——aria2 无法覆盖的分段加密流场景（backlog #17/#20）
- **内容管理带**：Tube Archivist / Pinchflat（订阅自动下载库）、spotDL sync（歌单双向同步）——订阅自动化是下一战场（backlog #18/#22）
- **国内短视频深水区**：f2（2.4K★，直播录制/弹幕/主页批量，内置 ABogus 签名对抗风控）、TikTokDownload（8.4K★，f2 接棒）——签名自研路线的合规与维护风险再次被印证不可取（backlog #11 决策正确）
- **B 站专项**：BBDown（弹幕/章节/多轨）——yt-dlp 盲区，暂缓观察（backlog #23）
- **三轮深挖（2026-10-02，工具与生态带，新增 10 项）**：lux（国内站点 Go 引擎）、streamlink（直播间插件化直录）、OpenList（AList 易主争议后的社区分叉，网盘聚合/WebDAV 出口）、LosslessCut（范式已被 OmniGet 工具箱无损族覆盖）、MKVToolNix、beets / MusicBrainz、subliminal / Bazarr、yt-dlp 插件目录、rclone、slskd。结论：真实增量缺口 = 直播间 URL 直录入口（#25）、网盘/WebDAV 下载源（#26，P1 候选）、yt-dlp `--embed-metadata`（#27）；其余判定见 backlog #28–#32

### 11. 四轮深挖（2026-10-04，活跃度核验与新生态带）

> 背景：六期路线图制定前的生态复核（GitHub 检索 + 社区动态），验证既有结论时效性并捕捉新生态带。

- **Motrix-Next（精神续作，2026 全年活跃，v4.0.0-beta）**：Tauri 2 + Rust + Vue3 重写，包体缩减 75%（~20MB），下载引擎改用维护分叉 **Aria2 Next**（修复原 aria2 遗留问题 + **原生 ED2K 支持**）。启示：① Tauri 化趋势确认，但 OmniGet 多引擎 + 工具箱 + 渲染层复用（mini 窗/Web UI）与 Electron 深度耦合，重写成本不匹配——包体瘦身走引擎按需下载路线（#3）；② **aria2 上游停更风险被社区用分叉正面回应**，OmniGet 应将「引擎韧性」列为长期观察项；③ ED2K 是 OmniGet 协议面缺口（aria2 原生不支持），需求已被验证但依赖引擎选型结论。
- **Media Downloader（Qt）**：yt-dlp / gallery-dl / lux / svtplay-dl 多 CLI 前端范式——「多引擎适配器路由」与 OmniGet manager 引擎路由同构，交叉印证架构正确。
- **音乐聚合带 2026 仍活跃**：musicdl（2026-03 仍在加 Deezer 支持）、go-music-dl、Audiovault（自托管音乐库管理）、咪咕无损下载器话题热度——五平台聚合 + 原唱校验仍是独有能力，音乐纵深投入方向正确。
- **「下载器 → 媒体服务器供给端」成型**：ytdl-sub（YAML 订阅 → Plex/Jellyfin/Emby/Kodi 媒体库形态）、jellyfetch、youtube-playlist-navidrome-sync（yt-dlp 音频 + 元数据内嵌 + download archive + Navidrome 同步）——下载器输出的目录结构/元数据与媒体服务器约定兼容成为明确趋势；OmniGet 命名模板 + 内嵌元数据（#27）+ MusicBrainz（#29）基建已备，增量仅为目录约定与 NFO 导出。
- **结论**：三期规划的三大主题（发布就绪 / 音乐纵深 / 视频纵深）全部被验证，无新增 P0 缺口；新增两个低成本差异化方向（媒体服务器友好归档、NFO 导出）与一个长期观察项（aria2 引擎韧性），据此扩展为六期。

---

## 二、能力矩阵对照（OmniGet vs 主流）

| 能力 | Motrix | Gopeed | ABDM | 文件蜈蚣 | MediaGo | Stacher | OmniGet |
|---|---|---|---|---|---|---|---|
| HTTP 多线程/续传 | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| BT/磁力（含勾选） | ✅ | ✅ | — | ✅ | — | — | ✅ |
| 视频/音乐站通用提取 | — | — | — | 部分 | 部分 | ✅ | ✅（含音乐五平台） |
| 音乐五平台 + 原唱校验 + 试听 | — | — | — | — | — | — | ✅（独有） |
| 短视频无水印 L1/L2/L3 | — | — | — | — | 部分 | — | ✅（独有） |
| 本地 ffmpeg 工具箱 | — | — | — | ✅（网络向） | — | — | ✅（音视频向，19 工具） |
| 浏览器扩展拦截 | — | — | ✅ | ✅ | ✅ | — | ❌ **最大缺口** |
| 下载队列/计划任务 | 部分 | — | ✅ | — | — | ✅ | 部分（调度限速已有，任务队列无） |
| 批量链接抓取 | — | 插件 | — | ✅ | — | — | ❌ |
| Web UI / 远程提交 | — | ✅ | — | — | ✅ | — | ❌ |
| 下载内容预设/参数预设 | — | — | — | — | — | ✅ | ❌ |
| 平台失效公示/健康面板 | — | — | — | — | — | — | ✅（独有） |
| 适配脚本热更（合规形态） | — | 插件 | — | — | — | — | ✅（声明式） |

---

## 三、后续产品规划清单

> 2026-10-02 精简：规划项清单、状态与实施记录统一维护在 `docs/backlog.md`，本文不再重复。
> P0–P3 优先级框架（判定依据见 §一/§二 竞品分析）：

- **P0 — 补齐下载器标配护城河**：浏览器扩展、任务队列与并发调度、批量链接抓取（R1–R3）
- **P1 — 放大差异化**：下载参数预设体系、Web UI 本地远程、安装包瘦身、按类型自动归档（R4–R7）
- **P2 — 工具箱扩展**：视频后处理族、音频处理族、图片互转、多输入工具、校验和/种子工具、视频批量串联（T1–T6）
- **P3 — 观察项**：图片/图集/电商下载（暂缓）、神经网络分离 L2（可选组件已落地）、MIDI 导出（独立立项）、歌词生成 AI（不做）、开放社区执行脚本（不做，合规）

---

## 五、里程碑完成存档（记录每一次功能变更里程碑）

> 各里程碑对应的版本号与变更明细见根目录 `CHANGELOG.md`（0.x.y：中间版本号随里程碑递增，初始 0.1.0）。
> 逐任务验收口径与横切约定（DoD、安全加固自检、性能回归、兼容矩阵）溯源至《OmniGet-产品技术设计文档》§4/§7/§9/§10；逐任务明细与完成记录原文见 git 历史（删除前最后版本）。

| 里程碑 | 完成时间 | 关键记录 |
|---|---|---|
| T0 工程基建（8 任务） | 2026-09-29 | Electron 33 + Vite + React 18 + TS 严格；DB 迁移 v1 自动应用；端口分配 16800/16801；TOFU 指纹校验；Windows 无 MSVC 经 better-sqlite3 prebuild + npmmirror 镜像解决（方法记入 README） |
| M1 骨架 + BT/磁力/HTTP（12 任务） | 2026-09-29 | 磁力 BEP-9 全链路（pause 取元数据 → 勾选 → unpause）；.torrent bencode 解析 + base32→hex 归一化；虚拟滚动任务列表；持久化恢复 + 增量补下；单测 32 + e2e 通过；修正 `enable-lpd` → `bt-enable-lpd` 选项名 |
| M2 音乐（8 任务） | 2026-09-29 ~ 09-30 | 初版 Python FastAPI sidecar（PyInstaller onefile 38.7MB，Defender 无检出）；REST 真实下载 E2E 过（忘情水 8.5MB）；**2026-09-30 起被内嵌 TS 引擎取代**（`src/main/music/`，删 service/ 全链路，真取消 + omniget-preview:// 试听协议） |
| M3 视频（11 任务） | 2026-09-30 | yt-dlp 2026.08.19 + ffmpeg 9.0.2 essentials；`-J` 解析 + 进度模板 + 合集回放 + 字幕/封面/cookie；短视频 L1/L2/L3（delogo 副本）三层降级；热更器 SHA256+TOFU 原子替换 E2E 过 |
| M4 打磨发布（17 任务，56 任务全完） | 2026-09-30 | 回收站/统计页/快捷键/首启向导/工具箱八件套/诊断归因五类/Tracker 管理器/定时调度；Inspector 抽屉（layoutId morph）；Windows NSIS 真机出包 81.3MB（winCodeSign 特权缺失以 `signAndEditExecutable:false` 绕过）；CI 三平台 build.yml；七视图三态走查通过 |
| Backlog 实施（R1-R7/T1-T6） | 2026-10-01 | 见本文 §三 状态列：浏览器扩展 MV3 + 本地桥接、并发队列闸门、批量抓取、视频参数预设 MVP、Web UI 最小版、引擎按需下载机制（manifest+SHA256）、按类型归档、工具箱多输入/种子创建/批量串联、健康页、i18n 骨架 |
| R7 引擎优化 + 音乐修复（0.6.0） | 2026-10-02 | UPnP/NAT-PMP、磁力元数据缓存、多源聚合、短链展开、单任务限速、健康页平台项、分站 Cookie、peer 指纹伪装；网易云 `ar` 字段/空歌手/咪咕兜底修复、下载失败视图、试听长条播放器 |
| R7 续 + R4 续批次（0.7.0，Backlog #4/#8/#11/#16–#22） | 2026-10-02 | N_m3u8DL-RE 引擎接入（清单解析 6 例 + 真机 68MB E2E）、直播录制 MVP、订阅追更中心（DB v2）、双档案去重、SponsorBlock、短视频解析服务 sidecar 兜底、yt-dlp JS 运行时探测、迷你悬浮窗、预设导入导出/命名模板、BT 文件树虚拟化、sanitize 平台差异化；单测 73 → 93 |

**关键工程数据（存档备查）**：
- sidecar 全家桶 ~262MB，超 §3.3 预算（~65MB 口径不成立）→ 引擎按需下载机制已就绪（R6），发布侧需在 Releases 提供 `<platform>-<arch>/manifest.json`
- 单测规模：T0~M4 收口时 33 → 2026-10-01 47 → 2026-10-02 73（音乐专项 + R7 回归）→ 2026-10-02 晚 93（R7 续批次：nm3u8-parse/video-extract/sanitize 等）
- 音乐架构变更：Python sidecar → 主进程内嵌 TS（设计文档 §4.4/§6.3 相应章节为历史设计）
