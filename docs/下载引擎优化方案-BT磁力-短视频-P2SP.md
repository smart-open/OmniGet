# 下载引擎优化详细落地方案（BT/磁力 · 短视频 · P2SP 多源）

> 日期：2026-10-02（R7 调研）
> 来源：GitHub 生态深度检索（anacrolix/torrent、libtorrent、Evil0ctal/Douyin_TikTok_Download_API v5、JoeanAmier/TikTokDownloader、XHS/KS-Downloader、xunlei-open/xunlei-dlsdk、aria2 1.37 官方手册逐项核实）+ 本工程代码现状勘察。
> ⚠ 所有 aria2 选项均对照官方 1.37 手册核实存在性（R5 教训：改造外部 CLI 参数前必须验证选项真实存在）。

---

## 一、本工程现状基线（勘察结论）

### BT/磁力链路
| 项 | 现状 | 位置 |
|---|---|---|
| 磁力元数据 | `pause:true + bt-save-metadata` 方案，90s 超时轮询；**未用 bt-metadata-only**；无元数据缓存复用（同 infohash 二次任务仍要等 DHT） | `src/main/adapters/aria2.ts:89-146`、`:23` |
| infohash 查重 | 已有（DB 命中秒开文件树） | `src/main/task/manager.ts:347-365` |
| Tracker | 8 个订阅源（XIU2 best/all + ngosang best/all + 4 个 jsdelivr CDN 镜像），单源上限 120 条；**仅启动时刷新一次**——`trackers.ts:3` 注释写"每日刷新"但无定时器（注释与实现不符） | `src/main/trackers.ts:12-47` |
| DHT | enable-dht/dht6 ✓、LPD ✓、dht.dat 持久化 ✓、entry-point 已配 router.bittorrent.com / dht.transmissionbt.com | `src/main/aria2/options.ts:47-73` |
| 端口 | `listen-port: '6881'` **单端口**、未配 `dht-listen-port` | 同上 |
| NAT 穿透 | **无 UPnP/NAT-PMP 端口映射**（全仓库无相关代码） | — |
| bt-* 选项 | bt-max-peers 200、bt-request-peer-speed-limit 10M、bt-tracker-connect-timeout 10、上传限速 1M、seed-ratio 0（无限做种） | `options.ts:56-63,127` |
| BT 加密 | 未配置（bt-force-encryption / bt-require-crypto 均未设） | — |

### HTTP/直链
- 多连接分段已有：`max-connection-per-server = clamp(threads,1..16)`、`split = clamp(threads,1..64)`、`continue:true`、`min-split-size:1M`（`options.ts:117-125`）。
- **无多源/镜像合并**：HTTP 任务只 `addUri([单 URL])`（`aria2.ts:286`）。
- `--uri-selector` / `--optimize-concurrent-downloads` 未配置。

### 视频（yt-dlp sidecar）
- 全托管 yt-dlp：`-J` 解析、`--progress-template` 进度、`--concurrent-fragments`、合集 `--playlist-items`、字幕/封面嵌入（`src/main/adapters/ytdlp.ts`）。
- 抖音三层降级已有：L1 无水印启发（format 排序）→ L2 `--extractor-args douyin:api=mobile` + iPhone UA 重试 → L3 ffmpeg delogo 后处理产 `_nowm` 副本（`ytdlp.ts:144,313-329,368-398`）。
- Cookie：单全局文件 `ytdlp.cookieFile`（Netscape 格式），**无分站管理**。
- 平台识别：douyin/kuaishou/xiaohongshu/xigua/weibo 标记（`manager.ts:409`）。

### 调度/设置
- 并发闸门 `download.maxConcurrent`（0=不限，FIFO）；定时限速计划 `schedule.rules` 已实装。
- **单任务限速 `max-download-limit` 类型已声明未实装**（`options.ts:36`）。
- 设置页未暴露 BT 端口/DHT 端口；健康页为被动归因（health.ts 24h 滚动窗口）。

---

## 二、GitHub 生态盘点

### 1. BT/磁力
| 项目 | 核心借鉴点 |
|---|---|
| **anacrolix/torrent**（Go，2014 起 7×24 生产验证） | uTP、**Holepunching（NAT 打洞）**、WebSeed、BT v2（BEP-52）、**流式下载/Seek/Readahead**（边下边播核心能力）；下游 TorrServer、hTorrent、distribyted |
| **libtorrent**（qBittorrent 底座） | uTP + 智能分段调度 + holepunching，"能连上 peer"的基准线 |
| **XIU2/TrackersListCollection** | tracker 订阅事实标准（本工程已用） |
| **aria2 1.37 官方手册** | 一批尚未启用的 BT 调优选项（见 P0 清单） |
| **qBittorrent/Transmission 优化共识** | **端口映射是 BT 速度第一影响因素**（可连接性决定 peer 数量；Transmission 打通 NAT-PMP 后速度数倍提升） |

### 2. 短视频平台
| 项目 | 机制 | 借鉴点 |
|---|---|---|
| **Evil0ctal/Douyin_TikTok_Download_API**（v5，Apache 2.0） | 纯 Python 实现 a_bogus/X-Bogus/X-Gnarly/X-Dynosaur 签名 + **无头浏览器自动铸造访客身份（身份池自维护）** + LRU 轮换/令牌桶/熔断/全链路可观测；短链/完整链/分享文案全收；Docker 三镜像（API+Worker+Go 下载 sidecar） | 风控应对完整工程范式：**身份池 + 健康分级 + 可观测** |
| **JoeanAmier/TikTokDownloader**（DouK-Downloader，GPLv3） | 抖音/TikTok 视频/图集/实况/直播流、批量账号作品、剪贴板监听、临时目录+原子移动、完整性校验、跳过已下载 | ⚠️ **作者已因合规停止维护签名算法**（用户自备）——自研签名的维护成本/风险信号 |
| **XHS-Downloader / KS-Downloader** | 小红书/快手无水印解析（直接取平台原始资源链接，非后期去水印） | 补平台覆盖的接口口径 |
| **yt-dlp**（本工程主路径） | extractors 全量 + extractor-args | 保持主路径，避免自研签名 |

**行业共识**：无水印 = 直接取平台自己的干净流，而非事后裁水印；抖音风控 = a_bogus（SM3 双哈希 + RC4 变种 UA 编码，长度 168/172）+ msToken + Cookie + 设备指纹，随版本频繁变更。

### 3. 迅雷（P2SP）
| 项 | 结论 |
|---|---|
| **xunlei-open/xunlei-dlsdk**（官方） | P2SP SDK 覆盖 Win/mac/Linux（Node/C++/C#/Java/Python/Unity），**但需注册 APP ID/API Key、README 无许可证、依赖迅雷云端调度**——商业授权形态，开源产品不可直接嵌入 |
| 迅雷下载开放引擎（MiniThunderPlatform） | 历史免费嵌入形态已收缩 |
| P2SP 原理拆解 | = 多源同文件分段并行（官方源 + 镜像 + P2P 缓存节点按字节区间动态调度后合并）。**其中"多源 HTTP 分段"部分可用 aria2 原生能力自实现**（aria2 支持多 URI 指向同一文件并行拉取） |

**结论：不嵌迅雷引擎（许可/合规风险）；自实现 "P2SP-lite" 多源聚合下载。**

---

## 三、落地方案（按优先级）

### P0 —— BT/磁力提速（纯配置层，约 2 天，收益最大）

#### P0-1 UPnP/NAT-PMP 自动端口映射（第一杠杆）
- 引入 `nat-api`（npm，UPnP + NAT-PMP 双协议），aria2 online 后在主进程异步映射：
  - `listen-port` TCP（BT 数据）
  - `dht-listen-port` UDP（DHT/UDP tracker）
- 位置：aria2 supervisor `onOnline` 之后触发；失败静默 + health 留痕；应用退出时撤销映射。
- 预期：家宽 NAT 后可连接性显著改善（社区实测速度数量级提升）。

#### P0-2 端口范围与 DHT 入口扩充（`options.ts`）
```
listen-port: '6881-6891'      // 原 '6881' 单端口；官方默认即 6881-6999
dht-listen-port: '6881-6891'  // 新增（选项已核实：UDP，支持范围）
dht-entry-point 追加备用节点   // 保留现有 router.bittorrent.com:6881
```
⚠ 已核实：`--dht-bootstrap-node` **不存在**（aria2 只有 `--dht-entry-point`），现配置口径正确，勿引入幻影选项。

#### P0-3 磁力元数据提速三件套
1. `bt-load-saved-metadata=true`：磁力任务先读本机已存 `.torrent`，命中即跳过 DHT——把 `bt-save-metadata` 产物收集进 `userData/torrents/`，同 infohash 二次任务**秒出文件树**（现要等 90s 超时窗口）。
2. `parseMagnet()` 合并磁力自带 `tr=` 参数进该任务 `bt-tracker`（与订阅源并集）。
3. 90s 未取到元数据 → toast 建议改用种子文件（UX 硬性标准：失败必须可见反馈 + 出口动作）。

#### P0-4 Tracker 定时刷新（`trackers.ts`）
- 补每日定时刷新（修复注释与实现不符）；
- aria2 崩溃重启后重注入（复用 `scheduler.invalidateSchedule()` 的重放模式）；
- 刷新后对运行中任务逐个 `changeOption` 已有（`manager.ts:1034-1048`），保持。

#### P0-5 防 QoS 与僵尸任务（选项均已核实存在）
```
bt-force-encryption=true   // arc4 加密握手，绕运营商 BT QoS；个别 peer 会拒绝——做成设置项，默认开
bt-stop-timeout=1800       // 连续 30 分钟 0 速自动停止，防死种占并发槽
bt-detach-seed-only=true   // 并发计数排除纯做种任务
```

### P1 —— P2SP-lite 多源聚合下载（对标迅雷核心，约 2-3 天）

aria2 原生支持「多个 URI 指向同一文件时并行分段拉取」（多源架构官方特性）。本工程现在只传单 URL。

1. **新建任务对话框**：支持粘贴多个镜像 URL；主进程按 Content-Length（或首段哈希）校验一致性，一致才合并为一个任务（防止拼错文件）。
2. **调度选项**（已核实存在）：
   - `optimize-concurrent-downloads=true`（官方公式 N = A + B·log₁₀(带宽 Mbps)，默认 5:25，按带宽自动扩并发）
   - `uri-selector=adaptive`（首连接选最优，其余轮测未试镜像）
3. **进阶**（借鉴音乐引擎多镜像思路）：直链解析聚合器——对常见大文件 CDN 提供"同资源多源探测"，探测命中（同长度/同区间哈希）后并入下载源列表。
4. 顺手实装闲置类型 `max-download-limit` 单任务限速（`options.ts:36` 已声明未用）。

### P1 —— 短视频平台增强（约 3-5 天）

分三层，按性价比排序：

1. **链接解析层**（主进程纯 TS，低成本高收益）：
   - 分享文案/短链统一展开：`v.douyin.com`、`xhslink.com`、`v.kuaishou.com` 302 跟随 + 正则提取作品 ID（Evil0ctal 口径：短链/完整链/`modal_id`/分享文案全收）；
   - 平台识别扩展进 `markShortVideo`；解析失败归因接健康页。
2. **Cookie 分站管理**：`ytdlp.cookieFile` 单文件 → per-domain cookie 组；设置页 UI 管理，yt-dlp 按 host 选择注入。
3. **解析服务 sidecar（可选进阶）**：自托管 Evil0ctal v5（Docker 或本地进程）作为抖音/TikTok 元数据兜底 API，yt-dlp 解析失败时先问解析服务再走 delogo 降级。
   - ⚠ **不建议自研 a_bogus/X-Bogus**：算法随平台版本频繁变更，JoeanAmier 已因合规停止维护签名算法——维护成本极高且有合规灰区。
4. **补平台**：对照 XHS-Downloader/KS-Downloader 的接口口径，评估 yt-dlp 对小红书/快手覆盖率，缺口平台经解析服务补齐。
5. 健康页（`health.ts`）新增 douyin/kuaishou/xiaohongshu 平台项（复用 24h 滚动归因窗口）。

### P2 —— 深水区（约 1-2 周，可选）

1. **BT 流式预览**（对标 anacrolix/torrent 流式能力）：
   - 路线 a（低成本）：`bt-prioritize-piece=head=2M,tail=1M`（选项已核实，默认分段 1M）+ 本地 HTTP 服务对流已完成区间做顺序预览——覆盖 80% "先看再下"需求；
   - 路线 b（高成本）：引入 Go anacrolix sidecar 替换 BT 引擎，获 uTP + holepunching + 真 Seek/Readahead。
2. **peer-id-prefix 伪装**：`--peer-id-prefix=-qB4650-`（qBittorrent 指纹；社区常用提升 peer 接纳率技巧；有轻微争议，若做默认 qB 前缀）。
3. **迅雷 SDK**：仅未来商业化合作时评估 `xunlei-dlsdk`（需 APP ID/API Key + 商用条款 + 隐私合规评估）。

---

## 四、优先级矩阵

| 项 | 工作量 | 收益 | 风险 |
|---|---|---|---|
| P0-1 UPnP 端口映射 | 0.5d | ★★★★★ BT 速度 | 低（失败静默降级） |
| P0-2/3/4/5 BT 配置批 | 1.5d | ★★★★ 元数据秒开/防僵尸 | 低 |
| P1 多源聚合下载 | 2-3d | ★★★ HTTP 速度 | 低（需一致性校验） |
| P1 短链展开 + 分站 Cookie | 1-2d | ★★★ 可用性 | 低 |
| P1 解析服务 sidecar | 2-3d | ★★★★ 平台覆盖 | 中（风控漂移） |
| P2 BT 流式预览 | 3-7d | ★★ 体验 | 中 |

**建议节奏**：P0 全部 + P1 短链展开先做（合计 3-4 天）；多源聚合与解析 sidecar 随后；P2 视需求。

---

## 五、风险与合规备注

1. 迅雷引擎嵌入：xunlei-dlsdk 为商业授权（APP ID/API Key + 云端依赖），未获授权前不可用于开源发行版。
2. 抖音签名自研：算法高频变更（a_bogus 168/172 双长度、SM3+RC4 变种），且头部开源项目已因合规收缩——走 yt-dlp 主路径 + 可选自托管解析服务。
3. BT 端口映射涉及用户路由器配置变更：UI 需明示（设置项 + 首次映射成功/失败 toast），失败时引导手动端口转发。
4. 所有新增 aria2 参数需先对照官方手册验证（本方案已核实：bt-metadata-only、bt-load-saved-metadata、bt-prioritize-piece、bt-force-encryption、bt-stop-timeout、bt-detach-seed-only、dht-listen-port、optimize-concurrent-downloads、uri-selector 均存在；**dht-bootstrap-node、peer-id 不存在**）。
