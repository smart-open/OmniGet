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
