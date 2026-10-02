# OmniGet Backlog

> 2026-10-02 由《遗留问题清单》《OmniGet-产品技术设计文档》《OmniGet-竞品分析与路线图》（原「产品规划-竞品分析与路线图」）《下载引擎优化方案-BT磁力-短视频-P2SP》合并而来，仅收录**未完成**项；已完成内容见各原文档 / git 历史。
> **约定**：任务完成后在条目前追加 `✅`（含完成日期）。
> 状态标记：`🔴 发布阻塞 / 🟠 待办 / 🟡 低优先（条件触发）/ ⏸ 观察项（暂缓/不做）`

---

## 一、发布阻塞 / 外部资源类

### 1. 🔴 macOS 签名与公证（等待 Apple 证书）
- **现状**：`electron-builder.yml` mac 段已有 `identity` / `notarize` / `hardenedRuntime` / `entitlements` 注释化占位；代码侧已就绪。
- **待办**：
  - [ ] Apple Developer 账号 + 证书接入 CI（`CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`）
  - [ ] 取消 yml 注释 + 提供 `build/entitlements.mac.plist`
- **备注**：无证书期间分发口径（2026-10-01 确认暂无 Apple 开发者账号）：未签名 dmg，用户首开需右键 →「打开」或 `xattr -cr /Applications/OmniGet.app`；应用已实现 TOFU 引擎指纹校验，未签名不影响运行时安全闸门。

### 2. 🟠 Windows CI 代码签名
- **现状**：本地构建因 winCodeSign 特权缺失以 `signAndEditExecutable: false` 绕过（exe 无图标/版本信息印刻）。
- **待办**：
  - [ ] CI 上开启 `signAndEditExecutable`（恢复 exe 图标/版本信息），见 `electron-builder.yml` 内注释
  - - [ ] 可选：EV 代码签名证书（设计文档 §8，可显著降低杀软误报）

### 3. 🟠 GitHub Releases 发布侧资产（引擎按需下载生效前提）
- **现状**：R6 引擎按需下载机制已就绪（`updater/engine-fetch.ts`，manifest SHA256 + TOFU），但下载端点在发布侧资产缺失时会明确报"manifest 获取失败"。
- **待办**：
  - [ ] GitHub Releases 提供 `<platform>-<arch>/manifest.json` 与引擎文件资产
  - [ ] 创建首个 release（electron-updater 需 latest 元数据，拉不到时静默跳过；Linux 手动更新通道版本比对同样依赖）

---

## 二、功能待扩展

### 4. ✅（2026-10-02）视频参数预设体系扩展（R4 续）
- **现状**：MVP 已落地——新建对话框内视频参数可保存/应用/删除（`download.videoPresets`）。
- **已完成（2026-10-02）**：
  - [x] ✅ 预设导出/分享（Stacher Preset 范式）——自描述 JSON 信封（`omniget-video-presets`），导出/导入按钮收口主进程对话框 + 1MB 上限；导入自动去重（同名同参跳过、同名不同参追加「(导入)」）
  - [x] ✅ 命名模板纳入预设体系——`VideoPreset.opts.template`，对话框内任务级输入（初始取全局 `naming.template`），yt-dlp 单视频路径 `video.template` 非空时优先于全局

### 5. 🟡 BT 外网探测国内可达性（自建探测端点，可选）
- **现状**：BT 端口外网可达性检测依赖 check-host.net / ipify，国内部分网络环境两者均被阻断，UI 已明示降级。
- **待办**：
  - [ ] 如需求强烈，考虑自建轻量 TCP 探测端点

### 6. ✅（2026-10-02）sanitize 按平台差异化
- **现状**：已实现平台原生口径——`sanitizeFilename(name, platform = process.platform)`：Windows 维持全量清洗（非法字符/保留名/末尾空格点）；POSIX（Linux/macOS）仅中和控制字符与 `/`，`aux.txt`、末尾空格/点、`\` 等合法文件名不再改写；超长截断与 `.`/`..` 中和全平台生效。回归测试已补（`sanitize.test.ts`）。

### 7. ✅（2026-10-02）NewTaskDialog BT 文件树虚拟化
- **现状**：已实现「展开节点扁平化 + 窗口化」——`useVirtualizer`（与任务列表同依赖）仅渲染可视区 ±10 行；默认全展开（视觉与旧递归一致），目录行新增折叠箭头；嵌套勾选三态、`#index` 命中高亮行为不变。

### 8. ✅（2026-10-02）迷你悬浮窗
- **现状**：已落地——托盘菜单「迷你悬浮窗」开关；frameless/alwaysOnTop('screen-saver')/skipTaskbar 不可缩放小窗（236×58，默认停靠主屏右下），复用主渲染层 bundle（`?view=mini` 分支渲染 `MiniWidget`：聚合速度 + 迷你曲线 + 运行/排队计数，整窗拖拽，关闭即销毁可随时重开）。主进程多窗口口径已收敛：`getMainWindow()` 按身份标记排除悬浮窗（托盘/剪贴板/协议唤起/activate 均已切换）。

---

## 三、人工走查 / 真机回归（多环境）

### 9. 🟠 主题走查
- [ ] 浅色（石墨灰）主题全组件走查：对比度、边框可见性
- [ ] 七主题逐一切换走查：侧栏/顶栏/对话框/Inspector/状态栏配色协调

### 10. 🟠 性能与平台回归
- [ ] 任务列表 10k mock 60fps 滚动实测
- [ ] macOS / Linux 冒烟（真机）
- [ ] NSIS 安装包真机安装 → 新建 → 下载 → 卸载（`release/OmniGet Setup 0.1.0.exe` 81.3MB 已产出）
- [ ] 音乐五平台逐平台人工回归（网易/QQ/酷狗/咪咕/汽水——TS 内嵌引擎迁移后待实测；镜像 API 属时效性资产，异常时优先对比 git 历史 Python 版实现，commit ac9824c 之前）

---

## 四、观察项（维持原判定，记录备查）

| 项 | 判定 | 依据 |
|---|---|---|
| 图片/图集/电商图片批量下载 | ⏸ 维持暂缓（用户排除） | 短视频图集/电商主图属"素材采集"赛道，与下载器定位有偏差；风控模型不同需独立立项 |
| 神经网络音轨分离 L2（Demucs 类） | ⏸ 可选组件已落地；不再内置 | 违背"零模型"原则（包体 +200MB） |
| MIDI 导出 | ⏸ 维持独立立项 | 需音高检测/转录模型 |
| 歌词生成等生成式 AI | ⏸ 明确不做 | 产品定位（§1.1） |
| 开放社区执行脚本生态 | ⏸ 明确不做（合规） | 声明式适配脚本热更形态已落地，不升级为任意代码执行 |
| 浏览器插件 / 在线版 / API 服务形态扩张 | ⏸ 维持不做 | 剪贴板 + `magnet:` 协议 + 拖拽 + 已落地的 MV3 扩展已覆盖主诉求 |
| 窗口控件失败反馈 | ⏸ 不再补 | Electron 单向 IPC 固有形态（`ipcRenderer.send` 无 Promise），主进程取不到窗口时 no-op 属预期 |

---

## 五、下载引擎优化遗留（R7，源自《下载引擎优化方案-BT磁力-短视频-P2SP.md》，2026-10-02 并入后原文件删除）

> ✅ 已完成部分（P0 全部、多源聚合、短链展开、单任务限速、健康页平台项、分站 Cookie、peer 指纹伪装）记于 AGENT.md §10 R7 批次；以下为未完成项。

### 11. ✅（2026-10-02）短视频解析服务 sidecar（快手/小红书补平台）
- **现状**：已落地自托管解析服务兜底——设置 → 下载新增「短视频解析服务（可选）」卡片（`sidecar.videoApiUrl`，白名单 + http(s) 校验 + 测试连接）。yt-dlp 解析失败（快手/小红书无 extractor、抖音风控）且平台在 sidecar 覆盖面（douyin/tiktok/kuaishou/xiaohongshu/xigua/weibo）时，自动 POST 自托管 Evil0ctal/Douyin_TikTok_Download_API v5 的 `/api/hybrid/video_data` 混合解析取直链：任务持久化改道 http 直链管线（type/engine 改写 + `params.outName` 标题命名含扩展名，parseHttp 命名与 aria2 `out` 共用），探测/下载统一浏览器 UA + 原分享页 referer（直链校验常见要求），HEAD 被拒时 GET Range 首字节兜底探测；直链有效性仍由 HEAD 探测 + 内网校验把关；命中/失败均回写健康面板（引擎列翻为 sidecar）并经通知条公示。响应提取按「优先级路径 → 启发式兜底」两级容错（play_addr → download_addr → mainMvUrls → master_url → 启发式），图集/纯图文不误判（`video-extract.test.ts` 9 例）。
- **注意**：兜底直链为带签名的时效 URL——重试/重启恢复启动前自动重问解析服务刷新（刷新失败沿用旧直链，不阻断重试）；sidecar 任务预检宽容放行（HEAD/GET Range 均被拒时不判死任务，跳过预检直接下载，错误由下载段暴露）。附带修复：http 直链任务单路径创建此前返回 awaiting，确认时会撞 confirmSelection 状态守卫抛 IllegalTransitionError——现返回 started 直关框（与批量路径口径一致）。
- **⚠ 安全口径**：`sidecar.videoApiUrl` 为用户显式配置的自托管地址，需支持本机/局域网部署，故放行 http 且不做内网校验（与 `engines.mirror` 的纯 https 口径不同，属有意的信任边界取舍：配置该地址即信任该服务）；连接测试只回传 ok/detail 摘要，不回显响应头与响应体。
- **⚠ 合规边界**：不建议自研 a_bogus/X-Bogus 签名——算法高频变更，头部开源项目已因合规停止维护签名算法（本实现只消费自托管服务公开 API，未内置任何签名逻辑）。

### 12. 🟡 直链解析聚合器（P2SP-lite 进阶）
- **现状**：用户主动粘贴多个镜像 URL 已可合并为单任务并行下载（content-length 校验 + addUri 多 URI）。
- **待办**：
  - [ ] 对常见大文件 CDN 做"同资源多源探测"自动聚合（需维护 CDN 指纹表）
- **暂缓原因**：手动多镜像已覆盖核心场景，自动探测收益/成本比低。

### 13. 🟡 DHT 入口节点扩充（可选）
- **现状**：`dht-entry-point` 为 router.bittorrent.com:6881（IPv6 走 dht.transmissionbt.com）；dht.dat 已持久化，冷启动可复用。
- **待办**：
  - [ ] 如发现 DHT 入网慢，追加备用 entry point（收益存疑，暂不动）

### 14. ⏸ BT 流式预览（暂缓，条件触发）
- **路线 a（低成本）**：`bt-prioritize-piece=head=2M,tail=1M`（选项已核实存在）+ 本地 HTTP 服务对已完成区间顺序预览——覆盖 80% "先看再下"需求；
- **路线 b（高成本）**：引入 Go anacrolix/torrent sidecar 替换 BT 引擎，获 uTP + holepunching + 真 Seek/Readahead。
- **暂缓原因**：本地 HTTP 服务 + UI 工作量大，等用户需求反馈再排期。

### 15. ⏸ 迅雷 SDK（维持不做）
- **依据**：`xunlei-open/xunlei-dlsdk` 为商业授权（需 APP ID/API Key + 依赖迅雷云端调度），开源产品不可嵌入；仅未来商业化合作时评估。

---

## 六、竞品深挖（2026-10-02，第二轮 GitHub 调研）

> 调研范围：第一轮 9 款之外的活跃开源项目——MeTube、VidBee（2026-09 仍在活跃开发）、Parabolic、Seal（Android）、spotDL、f2 / TikTokDownload、N_m3u8DL-RE、BBDown、Tube Archivist / Pinchflat；**第三轮（2026-10-02）追加工具与生态带**——lux、streamlink、OpenList（AList 分叉）、LosslessCut、MKVToolNix、beets / MusicBrainz、subliminal / Bazarr、yt-dlp 插件生态、rclone、slskd（#25–#32）。
> 本轮两大发现：① **yt-dlp 外部 JS 运行时硬性要求**（直接影响现有 YouTube 兼容性，列 P1 排查）；② **HLS/DASH 流媒体引擎与订阅自动化**是两条完整的能力带缺口（此前矩阵未覆盖）。
> 第三轮结论：工具箱「无损族」（LosslessCut 核心范式）已基本落地；真实增量缺口 = **直播间 URL 直录入口**、**网盘/WebDAV 下载源**、**yt-dlp 元数据内嵌**。

### 16. 🟠 yt-dlp JS 运行时兼容性排查（EJS / Deno / Node）——探测/注入已落地
- **依据**：yt-dlp 自 2025-11 起下载 YouTube 必须外部 JS 运行时（Deno/Node.js + yt-dlp-ejs，官方公告 issue #15012）；OmniGet 引擎为 2026.08.19（晚于该变更），**YouTube 任务可能已静默失败**；MeTube/VidBee/spotDL 均已给出对策（VidBee 捆绑 Node 作为运行时、spotDL 提供 `--download-deno` 自助）。
- **已完成（2026-10-02）**：
  - [x] ✅ 探测模块 `orchestrator/jsruntime.ts`：enginesDir（deno/node 与 yt-dlp 同目录，官方同目录查找面）→ 系统 PATH 兜底，30s TTL 缓存
  - [x] ✅ yt-dlp spawn/exec 全部注入 enginesDir 前置 PATH（同目录 + PATH 双查找面）
  - [x] ✅ 健康页 yt-dlp 引擎 detail 公示运行时状态（`<版本> · JS 运行时：deno（引擎目录）/缺失`）
  - [x] ✅ 引擎清单增加 deno（按需下载位，kind=tool 不入 TOFU；待 #3 release 资产提供 `deno.exe` + SHA256）
- **待办**：
  - [ ] 真机验证：本机直连 YouTube 超时无法实测 EJS 报错形态，需代理环境复测（健康页公示已可让用户侧自行发现）
  - [ ] 调查零包体方案：Electron 主进程 `ELECTRON_RUN_AS_NODE=1` 包装器充当 node 运行时（VidBee 方案增包体 ~50MB，优先验证免增方案）
- **⚠ 影响面**：仅 YouTube 等依赖 nsig 挑战的站点；国内站点提取不受影响，故未在历史回归中暴露。

### 17. 🟠 HLS/DASH 流媒体引擎（N_m3u8DL-RE）——两阶段全部落地
- **依据**：nilaoda/N_m3u8DL-RE——DASH/HLS/MSS 点播+直播、AES-128/SAMPLE-AES 解密、多轨选择与 ffmpeg 混流；MediaGo 即以其为内核。aria2 对分段 HLS + 加密场景无能为力，这是完整能力带缺口。
- **第一阶段（2026-10-02）**：嗅探器分型 `.m3u8`/`.m3u`/`.mpd` 清单链接（仅按 pathname 判定防误报）→ `platform:'hls'` 走 yt-dlp 引擎（generic extractor 原生支持分段流与 AES-128），此前此类链接落 http 类型必然产出损坏的 .m3u8 文件。
- **第二阶段（2026-10-02）——专用引擎接入，全部经 v0.6.0-beta 真机核实**：
  - [x] ✅ 新适配器 `adapters/nm3u8.ts`：spawn N_m3u8DL-RE（`-M format=mp4` 混流，ffmpeg 经 enginesDir PATH 注入自动发现；`--thread-count` 对接任务并发）；分片进度逐行解析（`N/M xx%`，实测格式）；exit 0 后 stat 产物回填真实字节数；pause=SIGTERM（tmp 分片保留，重跑自动跳过已下分片）；engineGid=taskId
  - [x] ✅ 清单解析纯函数 `nm3u8-parse.ts`（6 例单测）：master 变体列表（引号感知属性解析）→ 对话框格式选择；变体经 `url=<URI正则>:for=best` + `-sa for=best` 精确锁定；media/MPD 单条目自动最佳
  - [x] ✅ manager 全量接线：engine 路由（RE 在位→nm3u8，缺失回落 yt-dlp）、确认/暂停/恢复/移除/重试/重启恢复/产物落库/并发闸门/健康面板「nm3u8」引擎行；TOFU 指纹闸门复用（ensureVerified）
  - [x] ✅ 引擎清单增加 `N_m3u8DL-RE`（**发布侧直接放置解包后单文件，免 zip 解压支持**；单文件 ~13MB）；真机 E2E：真实 m3u8 → demo.mp4（68MB）通过
- **待办（增强，条件触发）**：
  - [ ] 直播录制：RE `--live-real-time-merge --live-record-limit` 选项已核实存在，待 UI（录制时长选择）+ 嗅探 live 清单分型
  - [ ] 字幕轨道选择（`-ss` 已核实）与命名模板对接；audioOnly 选项对 hls 任务当前忽略（对话框隐藏）

### 18. ✅（2026-10-02）订阅中心（频道 / UP主 / 歌单自动追更）——MVP 落地
- **依据**：Pinchflat / Tube Archivist（自托管订阅自动下载库，容器化）、spotDL `sync`（歌单与本地目录双向同步、删歌联动）——「订阅自动化」是下载器向「内容管理」演进的高价值方向，OmniGet 已有定时调度器与批量抓取基建，边际成本低。
- **已完成**：
  - [x] ✅ DB 迁移 v2（subscriptions 表）+ 模块 `subscribe.ts`：CRUD、`yt-dlp -J --flat-playlist` 抓条目（过滤嵌套播放器）、档案差集、createTask+confirmSelection 直通自动入队
  - [x] ✅ 设置页「订阅追更」卡片：添加（名称/URL/间隔 1h~1d）/立即检查/删除，展示累计入队与上次检查/错误；IPC 四通道 + bridge
  - [x] ✅ 定时器：10min tick，到期源串行检查；单源单次上限 20 条；入队即登记档案防重复；新增经通知条公示
- **边界**：保存目录取全局下载目录；默认参数（无预设/模板）；检查依赖 yt-dlp 引擎。

### 19. ✅（2026-10-02）yt-dlp 外部下载器 aria2c（可选加速）
- **依据**：Seal 内嵌 yt-dlp + ffmpeg + aria2 三件套并以 aria2c 为默认下载器；CLI 社区成熟范式 `--downloader aria2c --downloader-args "-x 16 -k 1M"`。OmniGet 自带 aria2 零包体成本。
- **已完成**：设置 `download.ytdlpAria2c`（默认关）+ 队列与归档分区开关；开启且 aria2c 在位时注入 `--downloader aria2c --downloader-args "aria2c:-x 8 -k 1M"`（官方文档选项口径）；enginesDir 已在子进程 PATH，按名解析即达。

### 20. ✅（2026-10-02）直播录制（HLS 直播流落盘）——RE 路线 MVP
- **依据**：f2 支持抖音/TikTok 直播流批量采集与弹幕转发；N_m3u8DL-RE 支持直播录制；Bililive-recorder 专精 B 站。国内直播录制需求真实且无桌面端开源整合方案。
- **已完成**：nm3u8 适配器解析期判定直播流（media 清单无 `#EXT-X-ENDLIST`）→ `ParseOutput.live` → 对话框显示录制时长选择（30min/1h/2h/不限）→ `--live-real-time-merge --live-record-limit HH:mm:ss`（选项经 v0.6.0-beta --help 核实）；手动暂停停止。
- **边界**：实时 pipe 混流（`--live-pipe-mux`）与定时分段未启用；yt-dlp 回落路线不支持直播录制。

### 21. ✅（2026-10-02）SponsorBlock 集成（YouTube 广告段标记/剔除）
- **依据**：yt-dlp 原生 `--sponsorblock-mark` / `--sponsorblock-remove`（社区众包广告段数据库），零外部依赖。
- **已完成**：对话框视频选项「SponsorBlock：标记赞助/广告段为章节」→ `ConfirmSelectionInput.video.sponsorBlock` → `--sponsorblock-mark all` 参数注入（随任务参数持久化，resume 重放）。
- **依据**：yt-dlp 原生 `--sponsorblock-mark` / `--sponsorblock-remove`（社区众包广告段数据库），零外部依赖。
- **待办**：[ ] 新建对话框视频选项加「跳过赞助/广告段」开关（仅 YouTube 任务显示），映射 L1/L2 参数注入。

### 22. ✅（2026-10-02）已下载去重（--download-archive）
- **依据**：spotDL sync / Pinchflat 均以 archive 文件为去重底座；OmniGet 重复粘贴同一合集 URL 会重复下载。
- **已完成**：双档案设计（`task/archive.ts`）——自有 `download.archive`（`sha1:<hex>` 键，URL 明文不落盘）：创建期命中拒绝（文案给关闭路径）、完成/订阅入队即登记；yt-dlp 原生 `ytdlp.archive`（`--download-archive`，合集条目级去重）。设置 `download.dedupe` 默认开，关闭后两档案均不启用。合集/订阅源 URL 不入自有档案（防订阅源被封死），条目级由 yt-dlp 档案负责。

### 23. ⏸ 弹幕下载与压制（B站 xml→ass，BBDown 范式）
- **暂缓原因**：BBDown 专属能力，yt-dlp 不产弹幕；需独立 B 站 API 适配 + xml→ass 转换工具（可先入工具箱）。等需求反馈。

### 24. ⏸ 主页级批量抓取（f2 / TikTokDownload 范式）
- **依据**：f2（2.4K★）支持用户主页/合集/点赞/收藏列表批量解析下载；TikTokDownload（8.4K★，已由 f2 接棒）。OmniGet 合集树已覆盖 playlist 场景，「主页全量 + 筛选下载」为增量。
- **⚠ 合规印证**：f2 内置 msToken/ABogus 等签名算法并遭平台风控对抗——再次印证 backlog #11「不自研签名」决策正确；主页批量仅基于公开 flat-parse 接口。
- **暂缓原因**：与 #18 订阅中心重叠度高（订阅=主页批量的自动化形态），先做 #18。

### 25. 🟡 直播间 URL 直录入口（streamlink 范式，条件触发）
- **依据**：streamlink（~11K★，活跃）以**平台插件**把直播间地址（B站/斗鱼/虎牙/抖音/Twitch/YouTube 等）解析为流清单/直链，LiveRecorder 等无人值守录制脚本生态均以其为底座。OmniGet #20 直播录制已走 N_m3u8DL-RE 路线，但入口仅限 `.m3u8/.mpd` 清单链接——用户手里通常是**直播间地址**（形如 `live.bilibili.com/xxx`），当前嗅探无分型，落 http 类型必然失败。
- **待办**：
  - [ ] 直播间 URL 分型（各平台直播间页 URL 规则表）→ 经 yt-dlp `-g`/平台公开 API 间接取流清单喂给 RE（零新依赖优先）
  - [ ] streamlink 二进制兜底评估：Python 生态、单文件分发难，仅当间接取流路线对主流平台失效时再议
- **触发条件**：#20 已有录制时长 MVP，等直播录制使用反馈后排期。

### 26. 🟠 网盘/WebDAV 下载源（OpenList，AList 分叉）
- **依据**：AList（~48K★）2025-06 易主争议后社区分叉 **OpenList**（40+ 网盘聚合——百度/阿里/夸克/OneDrive 等，WebDAV 与直链双出口，开源免费，社区已完成闭源 API 清查）。国内用户「网盘文件转直链/本地下载」需求真实，OmniGet 下载源目前完全无网盘能力；**不自研任何网盘协议**，只消费用户自托管 OpenList 的标准出口。
- **待办**：
  - [ ] WebDAV 任务类型：Basic/Digest 认证头（凭据安全存储，不入日志），分片下载走 aria2（`--header` 注入 Authorization）
  - [ ] 设置页「网盘聚合（可选）」卡片：OpenList 端点配置 + 浏览目录 + 提交下载（与 #11 短视频 sidecar 同款交互范式）
- **⚠ 安全口径**：沿用 #11 信任边界——用户显式配置的自托管地址放行 http、不做内网校验；凭据仅注入请求头，响应摘要不回显。
- **优先级**：P1 候选（补齐能力矩阵「下载源」维度的最大空白）。

### 27. 🟠 yt-dlp 元数据内嵌（--embed-metadata）
- **依据**：yt-dlp 原生 `--embed-metadata`（含 `--embed-chapters` 合并进同参数），零外部依赖；`adapters/ytdlp.ts` 已有 `--embed-thumbnail`（M3-5），元数据/章节内嵌未接——下载的影视/合集缺章节与标签信息。
- **待办**：
  - [ ] 对话框视频选项「内嵌元数据与章节」开关，映射 `--embed-metadata --embed-chapters`，随任务参数持久化（resume 重放）。

### 28. 🟡 工具箱轨道族补充（MKVToolNix 范式）
- **依据**：MKVToolNix（V102，2026-09 仍活跃）差异化 = 轨道提取/轨道属性/章节/附件封装。盘点确认 OmniGet 工具箱 **LosslessCut 核心范式已覆盖**（无损剪切×2、拼接、多区域合并、去音轨，均 `-c copy`），剩余增量收敛为两项：
- **待办**：
  - [ ] 「轨道提取」：视频内音轨/字幕轨导出为独立文件（`ffmpeg -map 0:a:0/-map 0:s:0 -c copy`，零新依赖）
  - [ ] 「外挂字幕封装」：视频 + srt/ass → mkv/mp4 封装（`-c copy`，流拷贝秒级）
- **⏸ 不引入 mkvmerge 独立二进制**（~30MB 增量，ffmpeg 覆盖主场景；仅轨道属性批量编辑需求出现再议）。

### 29. ⏸ beets / MusicBrainz 音乐刮削（暂缓）
- **依据**：beets（MusicBrainz 自动匹配 + 元数据归整）。OmniGet 音乐五平台引擎自带标题/歌手/封面元数据，MusicBrainz 增益仅在 yt-dlp 音频下载场景；beets 为 Python 生态不内嵌。
- **触发条件**：若立项「本地音乐库整理」专项再评估；过渡路线 = 工具箱单工具调 MusicBrainz 公开 API 补标签。

### 30. ⏸ 字幕库自动匹配（subliminal / Bazarr 范式，暂缓）
- **依据**：Bazarr（30+ 字幕提供商哈希匹配，NAS 生态标配，活跃）。下载器场景 yt-dlp 已抓站内字幕（M3-5）；BT 影视外挂字幕匹配有价值，但需独立服务/Python 运行时。
- **触发条件**：需求反馈后先做「OpenSubtitles API 单工具」入工具箱（文件哈希匹配 + 字幕下载落盘），不引入 Bazarr 全家桶。

### 31. ⏸ yt-dlp 外部插件目录（观察，倾向不做内置入口）
- **依据**：yt-dlp 原生插件机制（`yt_dlp_plugins` 包 / `--use-plugins`，社区 extractor 长尾，EJS 本身即插件形态）。允许用户向引擎目录自放插件包可解锁长尾站点且免热更主引擎，但等同「用户自带任意代码执行」，与适配脚本声明式热更的合规形态边界冲突（同 §四「开放社区脚本不做」判定）。
- **处置**：不做内置入口/管理 UI；高级用户自行放置插件目录属引擎目录既有查找面，无需产品支持。

### 32. ⏸ rclone / slskd（不做）
- **rclone**（70+ 云存储后端）：下载器场景 aria2 直链 + #26 WebDAV 已覆盖主诉求；二进制 ~50MB 违背包体预算（§3.3），不引入。
- **slskd**（Soulseek P2P 音乐网络）：版权合规风险高，明确不做（同 §四 生成式 AI 的定位排除口径）。
