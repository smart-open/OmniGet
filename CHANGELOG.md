# Changelog

> OmniGet 产品变更记录。版本号遵循 `0.x.y` 约定：**x（中间版本号）随功能里程碑递增**，y 为里程碑内的小修/加固版本。初始版本 0.1.0。
> 格式参考 Keep a Changelog；日期为里程碑完成时间。里程碑与验收口径溯源至《OmniGet-产品技术设计文档》§10。

## [0.12.0] - 2026-10-05

### 五期（1.0-rc → 1.0）生态补齐——代码侧三项落地

- **任务队列深度（调度合并编排）**：`ScheduleRule` 扩展「星期几」（`days`，缺省每天）与「停运窗口」（`mode: 'pause'`）——限速档与停运窗口共用一张规则表、同一个每分钟 tick；跨零点时段（22:00–06:00）的凌晨段按「窗口开始日」判定星期（周五窗口跨入周六凌晨不被当天星期误掐断）；停运窗口进入 → 仅暂停**运行中**的下载引擎任务（aria2/ytdlp/nm3u8；queued 任务由闸门持队不派发——若转 paused，窗口结束的批量恢复会绕过并发闸门直接重 spawn 突破 maxConcurrent），启动在途任务限时重试（90s），重试耗尽仍无法暂停的广播 warning 公示；窗口结束仅恢复被调度暂停的任务（用户手动暂停的不越权代恢复）+ 补泵启动队列。音乐/工具引擎有独立信号量，不在停运编排范围（备案）。旧规则数据（无 days/mode 字段）按「每天 + 分时限速」兼容解析（DB 无迁移，`schedule.rules` 键内归一）
- **订阅源队列分组**：DB v5 迁移 `tasks.queue_group` 列（可空）——订阅创建的任务自动携带源名（SubscriptionHost 通道，含增量补下/排队暂停恢复等全部 7 处启动闸门入口）；启动泵派发序改 `interleaveByGroup` 分组轮转（同组 FIFO 保抓取顺序、跨组交替），单订阅源批量追更不再饿死手动任务；任务列表行展示分组角标（纯函数 `task/queue-order.ts` + 单测独立成文件）
- **Web UI 远程强化**：①局域网远程访问开关（`bridge.lan`，opt-in 默认关，专用 IPC `bridge:setLan`）——LAN 模式绑定 0.0.0.0、Host 白名单放行局域网 IP（token 全端点强制兜底，DNS rebinding 拿不到 token）；桥接生命周期操作全量串行化（消除 listen 在途时二次触发的双 server 泄漏竞态）、重启前等待端口释放（防静默顺延 16821+ 致扩展/面板 URL 失效）、绑定失败回滚设置并上抛（渲染层 toast 真实原因，不再假报成功）；设置页展示本机局域网面板地址；②任务管理端点：`/api/tasks` 支持 status 过滤（合法值白名单 + SQL 层下推）/关键词搜索/分页、`/api/stats` 聚合速度与计数、`POST /api/task/:id/:action`（pause/resume/remove/retry，remove 走软删入回收站）；③Web 面板升级：聚合速度/运行/排队/完成/失败头部汇总、进度条 + 体积 + 速率、逐任务暂停/继续/重试/移除按钮（移除带 confirm）、名称/链接过滤、移动端窄屏适配
- **i18n 扩展语种**：新增繁體中文（zh-TW）与日本語（ja）全量字典（键集与 zh-CN 一致）；语言下拉随 `LOCALES` 自动扩展；`initLocale` 未知持久化值回退 zh-CN；新增渲染层键位齐平（全键集逐键对比）/回退/插值单测；设置页保存预校验补限速档格式（与主进程 LIMIT_RE 同口径，杜绝「保存成功但规则被静默丢弃」）

### 测试

- 五期批次 4 组新单测（调度器 sanitize/时段星期匹配、分组轮转 5 例、i18n 键位齐平与插值、DB v5 迁移列断言）；另五期自审查修复批次补跨零点星期判定回归锁（周五 22:00–06:00 的周六凌晨仍属窗口）；typecheck 双端通过

### 遗留（人工/外部资源项，roadmap 五期原样保留）

- 任务列表 10k 60fps 实测与 macOS/Linux 真机走查（#9/#10）；三平台签名/公证齐备（macOS 证书等待外部资源）→ 1.0 正式发布打 tag；停运窗口/局域网远程真机回归

## [0.11.2] - 2026-10-05

### 第十轮全功能审查修复（六域子代理并行：下载核心 / 音乐 / 视频·直播·弹幕·字幕·NFO / 工具箱 / 网盘·集成·更新·设置 / 横切 IPC·安全·DB·全局 UX；P1×6 / P2×20 / P3 逐项清账）

- **P1 下载核心（增量补下）**：`completedAt` 锚点在 re-add 起跑成功瞬间被消费（防双计的正确设计），但 allowOverwrite 判据也是同一锚点——此后恢复泵/重试/回收站恢复/aria2 崩溃重启等任何二次起跑裸 start 撞 saveDir 原完成文件报 `File already exists`，任务陷入不可修复的失败循环。改随 params 持久化 `incremental` 标记，覆盖放行与记账回撤解耦（`allowOverwriteForTask` 统一三处出口）
- **P1 音乐（归档漏删）**：`music.template` 带目录段（官方预设 `{{artist}}/{{album}}/`）时产物在 saveDir 子目录，task_files 存量 basename 登记 join 回 saveDir 根——「删除（含文件）」`rm force` 静默成功、mp3/lrc 永久残留且库行已注销。改用 `music_tracks` 绝对路径反查补齐（新旧任务都覆盖）；顺带 `deleteTaskFiles` 补 `recursive`（demucs 目录产物此前必 ENOTEMPTY 残留数百 MB）
- **P1 视频（NFO 全部非法）**：XML 声明行缺闭合 `>`（`standalone="yes"?`）——Jellyfin/Emby/tinyMediaManager 解析必失败，自动钩子与手动导出两条路径的产物全部不可用；新增 `video/nfo.test.ts` 锁定
- **P1 工具箱（R9 修复未生效）**：batch-convert 的 `hasVideo` 判定违背 `probeStreams`「只返回 audio/subtitle 流」的约定恒 false——音频目标遇无声视频的剔除分支从未触发，整批产物仍会拖死。按约定修正为「探测成功且无音轨即剔除音频目标」（mp4 目标因 map 全带 `?` 无需剔除）
- **P1 网盘（凭据写入即丢失）**：WebDAV 明文降级分支把已 JSON 编码的 payload 单层落库，`getSettingParsed` 读取时解析一层得对象而 `read()` 只认 string——safeStorage 不可用环境保存凭据后永远 401。save 改双重编码 + read 兼容对象形态（存量行），新增往返回归测试
- **P1 横切（SSRF 漏网）**：N_m3u8DL-RE 清单解析链（`fetchManifestText`/`probeMasterLive`）`redirect:'follow'` 且无内网校验——公网 302 跳内网的响应体被解析后回显渲染层，击穿 net-guard。改手动重定向逐跳 `isInternalUrl`（上限 3 跳）
- **P2 下载核心**：①磁力/种子解析期在途查重缺失——创建期预写 infohash（解析窗口内二次粘贴明确拒绝）+ 解析后按 infohash 补查（覆盖 .torrent 与并发解析窗口，命中即撤单）；②「处理中」视图数据源漏 `awaiting`（渲染层过滤器声明包含但主进程 SQL 不返回，任务在待确认阶段切换视图即「消失」）；③aria2 中途重启把用户**主动暂停**的任务一并重置 queued 自动续传（保留 paused 语义仅清 gid，resume 走无 gid 分支重过启动闸门）；④磁力快速通道**部分命中**从静默降级改明确报错（此前勾 5 个只下 1 个无任何提示）
- **P2 音乐**：①SSRF 重定向闸门补全调用面——`fetchToFile`/`fetchJson`/`getText` 此前仍 follow 重定向（openStream 同型漏网，共享 `fetchWithGuardedRedirects` helper 收口四处）；②QQ/酷狗/咪咕/汽水链目标音频已存在（如歌词缺失重下）时 rename 撞 Windows EPERM → 六个 br 全试一遍白耗流量 → 五平台全空——`fetchToFile` 目标已存在兜底（不重拉流）+ `onForeign` 标记贯通 + 四平台分支补 cached 语义（取消清理/改名跳过，防误删既有产物）；③自定义 `music.template` 后 skip_existing 永不命中（产物已被改名/迁目录）——补音乐库 title/artist 命中兜底（按 cached 返回，杜绝「(2)」副本堆积）；④歌单超 100 首静默截断——`MusicPlaylistInfo.total` + UI 黄字「共 N 首，仅加载前 100 首」
- **P2 视频/直播**：①`videos.duration_sec` 是死列（永不写入，封面墙时长恒「—」、NFO duration 永不输出）——`generateCover` 顺带回填；②直播判据引擎无关化——RE 缺席回落 yt-dlp 直录的路径无 roomUrl，完成入档案/失败熔断记账的直播豁免漏网（创建期持久化 `liveRoom` 标记，`isLiveRecordingTask` 统一判据）；③直播任务重试前重解清单（时效直链拿旧清单必 403/404）；④**直播断流自动重连**（30s × 3 次，凭 roomUrl 重解清单，广播通知，耗尽后维持 failed）；⑤OpenSubtitles 入库钩子失败从纯日志改广播 warning（配额/凭据类错误用户可见，「未匹配」保持静默）；⑥弹幕压制 `fetchCid` 补 UA/Referer（B站 view 接口无浏览器头被风控 -352/-412，功能等于不可用）
- **P2 工具箱**：①batch-convert 剔除清单随 completed 事件带给用户（此前仅 log，用户以为全部文件已转换，BuildResult 新增 notice 字段）；②音乐库补标签按 basename 解析查询词（目录名含「 - 」时把目录当歌手名，错误命中会写回原文件）；③subtitle-mux 选 mp4 容器遇图形字幕轨（PGS/DVB）build 期探测并给明确出口（mov_text 无法编码图形字幕，此前 stderr 尾行晦涩）
- **P2 网盘/更新/设置**：①全新安装 aria2 引擎补齐成功后**自动拉起监督器**（此前首次 spawn 从未发生、重启链无触发点，核心引擎直到用户手动重启都不可用）；②应用自动更新 error/downloaded 事件经通知栏广播（文件头声称「降级为通知」但零通知路径）；③Linux 托盘创建失败时不注册关窗拦截（无托盘环境把窗口拦成 hide = 僵尸进程，注释与实现此前相反）
- **P2 横切**：①`sidecarProbe` 探测面收敛到设置项（此前接受渲染层任意 URL 做「可达性+状态码回显」探测，唯一未持久化输入的 oracle）；②渲染进程崩溃 `render-process-gone` 自动 reload（上限 3 次）+ 通知——此前白屏死置、下载照跑但无任何 UI 出口
- **P3 要点**：before-quit 补停订阅/调度/tracker 三个周期定时器（shutdown 12s 窗口内到期会落库/重拉引擎）；HTTP 直链探测改手动重定向逐跳内网校验 + len=0 等长镜像不再被静默剔除；NFO 归档日期取库行 created_at（此前恒取导出时刻）+ poster 拷贝失败降级「仅 NFO」；弹幕实体解码容错非法码点；videos.path 幂等索引；tool 任务隐藏必报错的暂停按钮；工具箱预览扩展名补 mkv/mka/m4b；WebDAV 凭据保存文案不再谎称「加密存储」；musicDownload 音质档位白名单；咪咕/汽水搜索补专辑名映射（{{album}} 恒 Unknown Album）；镜像主机公网判定缓存加 5min TTL（防 rebinding 钉死）；musicbrainz-tag 扩展名校验前移（不白耗 MusicBrainz 配额）；向导加「跳过」按钮 + 默认目录加载失败行内提示 + 设置 → 外观新增「重新运行向导」入口；bt.upnp/forceEncryption 保存提示重启生效；歌单接口响应体 8MB 上限；QQ 317ak 链按所选音质分档（此前标准档也先拉无损再丢弃）；字幕落盘保留原始扩展名（vtt/sub 不再误存 .srt）；弹幕超 3000 条截断在完成消息附注

### 测试

- 新增 2 组回归 6 例（NFO XML 声明/转义/日期 4 例、WebDAV 凭据往返与对象形态兼容 2 例）；全量 171/171，typecheck 双端通过

## [0.11.1] - 2026-10-05

### 第九轮全面审查修复（五域子代理并行：主进程编排 / 渲染层 UX / 音乐·工具箱·热更 / IPC·安全 / 三四期新功能；P1×1 / P2×13 / P3×25）

- **P1 批量转码**：mp4 目标遇纯音频输入、音频目标遇无声视频输入时硬 `-map` 落空是初始化期致命错误，多输出单命令原子语义下**整批产物全失**——改 async build 逐输入 ffprobe 探流，无可提取流的输入参数期剔除（全剔除则抛错走 failed 事件），map 全部加 `?` 容忍缺流
- **P2 主进程编排**：①音乐 POST 在途删除（入回收站）补偿检查漏 `isTrashed`——status 仍 queued 条件不命中，引擎照常下载且产物永不进 task_files；②aria2 崩溃重启链**端口永不重探**（被占即无限重启循环，`ENGINE_PORT_OCCUPIED`「自动换端口」承诺仅 bootstrap 兑现）——每次 spawn 前重探顺延；③重启链完全绕过 TOFU 指纹闸门——`checkBinary` 移入 spawnAndConnect；④在途去重未豁免直播（与已下载去重预检口径矛盾，且解析后 source 改写为清单直链、互斥键漂移）；⑤RE 缺席时抖音直播漏进 sidecar 兜底链，伪造「风控」假归因
- **P2 渲染层**：⑥任务视图 load 失败后数据源守卫卡死**永久骨架屏**（错误态在守卫之后永不可达）；⑦音乐库/视频库加载失败伪装成「空库」空态（三态缺错误态，HealthPage 同型问题复发）；⑧新建对话框预设保存/删除乐观更新失败不回滚（UI 说谎）；⑨音乐/视频库「打开所在目录」失败零反馈（unhandled rejection）；⑩歌词模式持久化失败静默（写操作无反馈 + UI 不回滚）
- **P2 音乐/热更**：⑪QQ/酷狗/咪咕/汽水下载链 `.part` 临时文件名固定——同名歌曲并发任务交错写入损坏产物（M2 修复只落在网易云，随机后缀下沉 `fetchToFile` 全链路）；⑫preview://remote 封面代理 SSRF 防线不覆盖重定向——undici 默认 follow，公网 302 跳内网自动跟随回显，`openStream` 改手动重定向逐跳 `isInternalUrl` 校验；⑬CSP `img-src https:` 通配与「封面走主进程代理防 IP 暴露」设计矛盾（渲染层已零直连使用，收敛为 `'self' data: omniget-preview:`）
- **P3 要点**（全清单见 git 历史）：启动在途暂停补偿补 `merger.drop`（aria2 分支与 ytdlp 对称，防暂停被回放撤销）；启动失败清 gid 前先 remove 引擎侧残留条目（磁力 parse 期暂停态 gid 会话孤儿）；磁力查重命中 failed 任务给出可读出口（此前裸 IllegalTransitionError）；直播清单直链不入去重档案/失败不做无意义熔断记账；engine-fetch 206 Content-Range 错位丢弃响应体重发（此前消费错位残段必然 SHA 失败）；yt-dlp 热更下载失败自清 `.new.tmp` 残片 + 256MB 体积硬上限；音乐库补标签改 `.bak` 回滚替换 + ffmpeg 60s 兜底超时；弹幕压制 6h 兜底超时；OpenSubtitles 明文回退键 JSON 编码（纯数字 Key 被吞）+ HTTP 429 专属文案；NFO 自动钩子不覆盖已有 `.nfo/-poster.jpg`（手动导出保留覆盖）+ 缺失条目禁用导出按钮；订阅部分失败也落 `last_error`（此前被清空）+ 改 URL/源类型重置检查状态；弹幕压制勾选框排除合集任务（误导文案）；demucs 指纹校验移入 acquireSlot（校验窗口可取消不空占槽）；`toolReveal` 拒 `..` 段 + realpath 失败即拒绝；`ensureVerified` 快速指纹失败不再命中缓存；旧库迁移补拷 `-wal`；netdiskDownload 路径黑名单与 listWebdav 口径对齐；MediaLibrary 汇总加 seq 守卫 + 缺失文件不计体积；音乐 started 分支主动重载；脚本启停双 toast 去重；HelpOverlay 键位说明补全；Inspector 显式 `withFiles:false`；NFO 死参数 `size` 移除

### 遗留清账（同日第二批，backlog 〇-E 观察项）

- **A6 删除含文件补清残片**：yt-dlp 未完成下载的 `.part`/`.part-FragN`/`.ytdlp` 残片不在 task_files 登记体系内，删除运行中任务永久残留磁盘——remove 前捕获适配器产物追踪，按产物名前缀清理（N_m3u8DL-RE 临时分片无公开命名契约，不猜删，留注释备案）
- **D7 sidecar 供应链加固（重）**：①**q3aql/aria2-static-build 仓库已从 GitHub 消失**（repo/releases 均 404，CI aria2 收集已断）——主源切继任仓库 dmesg00/aria2-static-builds（win 7z/ linux glibc，同资产命名风格，已实测 bsdtar 解 7z + digest 一致），abcfy2/aria2-static-build 作未覆盖平台兜底；darwin 现役源均无静态构建，缺失时给出手动放置出口的明确报错；②下载侧校验全量接入——BtbN 官方 checksums.sha256（已核实条目格式）+ GitHub API assets[].digest（官方 sha256）覆盖 aria2/deno/N_m3u8DL-RE；③顺带修复 `fetchFfmpeg` 的 ghLatest 双重路径 bug（拼出 /releases/latest/releases/latest → 404，该步骤此前必失败）
- **D8 settingsGet 黑名单模式化**：精确键 + 命名模式双层（`*.token/secret/password/auth/credential` 段、`*.key(.enc)` 结尾）——凭据键历史上两次事后补漏，模式层让未来新增凭据键默认拒绝；已核对渲染层现有读取键无一命中（无误伤）
- **D10 便携模式统一 Chromium profile**：新增 `adoptPortableUserData()`（锁判定后、ready 前）——`app.setPath('userData')` 把缓存/GPU cache/localStorage 一并收拢到应用数据目录，legacyDataDir 改用重定向前快照（迁移语义不纠缠）；enginesDir/preview 白名单/图标回退链等消费点已逐一核实不受影响；失败静默保留系统 userData 行为
- **B11**：顶栏搜索注释口径修正（任务视图间保留 query 为有意行为）

### 测试

- 全量 165/165 回归通过，typecheck 双端通过（无新增测试——本轮以既有用例守边界）

## [0.11.0] - 2026-10-04

### 四期「统一内容管理与工具箱」（roadmap 四期四项落地；移动端提交维持条件触发不排入）

- **统一媒体库**：侧栏「库」组合并为单一「内容库」入口——顶部分段切换（音乐/视频，带实时计数与汇总体积，任务完成/删除事件自动刷新）；子视图沿用音乐分组列表与视频封面墙；**库与磁盘/回收站口径打通**——列表条目新增 `exists` 磁盘标注（文件被移动/删除的条目可见但禁播放/预览/补标签），任务「彻底删除（含文件）」时 `music_tracks`/`videos` 库行随产物注销（封面文件一并清理），「删除·保留文件」保留库行
- **OpenSubtitles 字幕自动匹配升级为入库钩子（backlog #30 升级）**：API Key 迁移 safeStorage 凭据通道（新模块 `opensubtitles/credentials.ts`，同 #26 netdisk 口径——`opensubtitles.key.enc` 加密落 settings、读取黑名单不回显、专用 IPC 写入、safeStorage 不可用降级明文留痕）；设置 → 下载新增「内容库入库钩子」卡片（开关 `video.subtitleHook` 默认关 + 语言偏好 + Key 保存）；视频任务完成登记后 fire-and-forget 自动按文件哈希匹配字幕落盘视频旁（成功经通知条公示，失败留痕不阻断完成链；未配置 Key 直接跳过）；工具箱「字幕匹配」工具参数留空时自动回退凭据通道
- **音频处理族工具扩展（roadmap 四期，ToolDef async build 范式，零渲染层增量）**：①「响度标准化」升级**两遍 EBU R128**——先完整解码测量（print_format=json）再 linear 模式应用（无二次动态压缩失真；测量失败自动回退单遍，测量解析/滤镜构建纯函数单测）；②新增「音频章节标记」工具（有声书场景）——时间轴文本（每行 `时:分:秒 标题`）→ FFMETADATA → mp3（ID3v2 CHAP）/m4a/m4b 章节轨，流拷贝秒级；默认章节名按时间轴顺序编号，末章 END 取 ffprobe 真实时长；③新增「批量转码」工具——T4 multi 多文件单任务一次转码（mp3/m4a/opus/flac/wav/mp4），产物名跨目录去重，失败/取消逐产物清理
- **NFO/媒体库元数据导出（roadmap 四期，Jellyfin/Emby 归档口径）**：新模块 `video/nfo.ts`——`<视频名>.nfo`（movie 方言：标题/来源/年份/时长）+ `<视频名>-poster.jpg`（复用库封面抽帧产物）；设置开关 `video.nfoExport`（默认关）自动随封面就绪落盘；视频库封面卡新增「导出 NFO/海报」行操作（手动触发随时可用，toast 反馈）

### 测试

- 新增 3 组单测 14 例（loudnorm 测量解析与滤镜构建 4 例 / 章节解析与 FFMETADATA 构建 6 例 / NFO XML 构建与转义 3 例 + 转义 1 例）；全量 165/165，typecheck 双端通过
- 落盘逻辑抽取：`saveSubtitleBesideVideo` 收口工具 compute 与入库钩子共用路径（重名追加序号口径不变）

### 回归审查修复（独立复核，10 项）

- **P1** 入库钩子解耦：字幕匹配抛错（「未匹配到字幕」为最常见正常结果）不再连带跳过 NFO 导出（各钩子独立容错）；钩子链 await 封面就绪 + 任务删除存活复核
- **P2** 批量转码 ffmpeg 双语义修复（多输出选项逐输出重复 + 显式 `-map i:a` 逐输入映射——此前所有产物都会取 0 号输入的流）；音频章节 `-map_metadata 0` 保留原标签（仅 `-map_chapters` 导入章节）；`prewrite` 写盘入 try（磁盘满/EACCES 此前泄漏工具并发信号量、队列永久卡死）；`acquireSlot` 前移至 async build 之前（loudnorm 两遍测量的全量解码纳入 ≤2 并发约束）+ `building` 集合支撑构建期取消
- **P3** 库列表 `exists` 改异步 stat（`existsSync` 同步阻塞主进程，断连网络盘冻结全应用）；`toolbox.submit` 返回全产物 → 多产物工具（批量转码/voice-sep）第 2..N 产物落 task_files（「彻底删除（含文件）」不再漏删）；safeStorage 降级明文时设置页不再谎称「加密存储」（status 回传存储形态）；字幕语言偏好保存前格式校验（此前 `Chinese` 落库但消费端静默回退 zh）

## [0.10.0] - 2026-10-04

### 三期「视频纵深：追更与录制中枢」（roadmap 三期四项落地；BT 流式预览维持条件触发不排入）

- **直播间 URL 直录入口（backlog #25）**：嗅探器新增直播间页分型（`live.bilibili.com`/`douyu.com`/`huya.com`/`live.douyin.com`，房间号段校验，先于普通视频域命中；douyu/huya 此前落 http 类型必然失败）→ 新模块 `live/resolve.ts`：yt-dlp `-J` 解析直播间页取最佳 HLS 清单直链（B站直播/斗鱼/虎牙/抖音 extractor 零新依赖），B站另备公开 API（`room_playing`）兜底——解析出的 `manifestUrl` 改写 `task.source` 喂 N_m3u8DL-RE 走既有 nm3u8 管线（录制时长选择复用直播流 UI）；RE 缺席回落 yt-dlp 原生录制；直播 CDN 校验 Referer 的平台（B站/抖音）按参数自动注入 `--header`；直播 URL 不入去重档案（重复录制常态）
- **弹幕下载与压制（backlog #23）**：新模块 `danmaku/convert.ts`——B站弹幕 XML → ASS 纯函数转换（滚动 `\move` 轨迹 + 底部/顶部定轨车道分配、颜色/字号/透明度、大括号特效注入防御、3000 条上限）；工具箱新增「弹幕转换」工具（runtime=node）；B站视频任务确认面板新增「弹幕压制」开关（完成时公开 API 取 cid → 拉弹幕 XML → ffmpeg subtitles 烧录 `_弹幕` 副本，原片保留，失败仅附注不判任务失败）
- **订阅中心升级（backlog #18 边界收敛）**：DB 迁移 v4（subscriptions 扩列 + videos 表）；订阅源新增**RSS/Atom 源**类型（`subscribe-rss.ts` 零依赖解析，enclosure > media:content > yt:videoId > link 取值优先级）；每源可指定**保存目录**（校验同任务创建口径）、**参数预设**（映射 `download.videoPresets` → 确认参数）、**命名模板**；条目级过滤——最短时长（秒；yt-dlp 条目带 duration，RSS 无时长信息视为通过）+ 标题关键词（逗号/顿号分隔任一命中）；设置页订阅卡片升级：编辑模式（回填/更新）、源类型/预设下拉与过滤输入，新通道 `subscribe:update`
- **视频媒体库 MVP**：DB v4 新增 `videos` 表；视频任务完成登记产物（标题/平台/体积/ffprobe 时长，同路径复用行保留封面）+ ffmpeg 抽帧封面（10% 时长位次，落 `userData/covers/`，fire-and-forget 失败留痕）；侧栏「库」组新增「视频库」视图——封面墙（16:9 卡片 + 时长角标）+ 检索 + 本地预览播放（`omniget-preview://local` Range 流式）+ 定位文件 + 移除条目（不删文件，二次确认）；MVP 只覆盖单视频/直播录制产物（合集任务走文件树不在此路径）

### 测试

- 新增 4 组单测（live/rooms 房间识别 3 例 / danmaku 转换 4 例 / subscribe-rss 解析与过滤 4 例 / sniffer 直播间分型扩展）；store 迁移测试升至 user_version=4；全量 151/151，typecheck 双端通过
- 顺带修复：i18n 缺 `nav.library` 键（侧栏「音乐库」此前显示键名回退）

## [0.9.0] - 2026-10-04

### 二期「音乐纵深」（roadmap 二期五项全落地）

- **无损音质档位**：产物扩展名不再硬编码 `.mp3`——下载完成按**文件头嗅探**（fLaC/ftyp/ID3/MPEG 同步字/OggS/RIFF）对齐真实容器扩展名（`.flac`/`.m4a` 等，lrc 主名不变）；酷狗 `tryKugou` 音质接线（此前 `void quality` 忽略音质参数，恒从最高 br 起试）——317ak br 链与 haitangw level 链均按档位收敛；`skip_existing` 扩展为多音频扩展名扫描（无损产物不被重复下载覆盖）
- **歌单/专辑页批量下载**：新增 `music/playlist.ts`——网易云歌单/专辑页 URL 分型（含 `y.music.163.com`、`#/playlist` 等页面变体）→ 官方公开 API 抓曲目列表（单批上限 100，合规红线：只消费公开接口不自研签名）；音乐工作台新增「歌单」面板：解析 → 曲目勾选（全选/清空）→ 逐曲按 ID 精确入队，并发闸门复用任务队列（≤4）
- **双语歌词（LRC 双轨）**：网易云歌词接口改取 `tlyric` 翻译轨（原 `tv:-1` 未消费），`mergeBilingualLrc` 纯函数按时间戳把译文行（无时间戳）合并进原文；工作台音质行新增「歌词」模式选择（原文/双语，`music.lyrics` 设置持久化，默认原文维持既有行为）
- **媒体服务器友好归档**：`naming.ts` 新增 `{{album}}` 变量与 `renderNamingSegments` 目录段渲染（逐段 sanitizeFilename、`..`/空段收口、最多 8 段）；音乐命名模板独立键 `music.template`（非空优先于全局 `naming.template`——视频侧 `toYtDlpOutputTemplate` 会把 `/` 中和为 `_`，共用键会互相污染）；`engine.applyNaming` 升级为支持 `{{artist}}/{{album}}/{{title}}` 目录结构（子目录建失败保留原位不判失败）；平台命中专辑名经 `engine.lastAlbum` → `music.done` 事件贯通；设置 → 模板新增音乐模板输入 + Navidrome 归档预设按钮
- **音乐库视图**：DB 迁移 v3 `music_tracks` 表；`music.done` 成功即登记（真实产物路径/lrc/标题/歌手/专辑/音质，同路径去重）；侧栏「库」组新增「音乐库」视图——按歌手/专辑分组浏览 + 检索 + 本地试听（`omniget-preview://local` 流式）+ MusicBrainz 一键补标签（复用 #29 查询纯函数 + ffmpeg `-c copy` 元数据回写原地替换 + 库行同步，TOFU 闸门同口径）+ 定位文件 + 移除条目（不删文件，二次确认）

### 测试

- 新增 4 组单测（lyrics 双轨合并 5 例 / playlist URL 分型 4 例 / 音频头嗅探与扩展名对齐 2 例 / 命名 album+目录段 3 例）；store 迁移测试升至 user_version=3；全量 139/139，typecheck 通过

## [0.8.0] - 2026-10-04

### 一期「发布就绪」（roadmap 1.1/1.3；backlog §一 #2/#3、#16、#21）

- **Windows CI 代码签名开启（§一 #2）**：`build.yml` win 打包以 CLI 覆盖 `-c.win.signAndEditExecutable=true`（CI 具备 winCodeSign 缓存解压的特权条件，恢复 exe 图标/版本信息印刻；本地 `electron-builder.yml` 维持 `false`，无特权机器构建不受影响）；EV 证书可选通道——向仓库 secrets 配置 `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` 即自动启用 signtool 签名，未配置（空值）时仅资源印刻
- **GitHub Releases 发布侧资产（§一 #3，引擎按需下载/自动更新通道激活）**：
  - `fetch-sidecars.mjs` 新增 deno（yt-dlp EJS 运行时）与 N_m3u8DL-RE 收集（软失败仅告警，不阻断出包）
  - 新脚本 `scripts/gen-engine-manifest.mjs`：按 `engine-fetch.ts` ENGINE_FILES 同口径扫描引擎目录，产出 `<platform>-<arch>/manifest.json`（逐文件 SHA256）+ 引擎文件本体
  - `build.yml` 新增 release job：tag 推送自动创建 GitHub Release——三平台安装包 + latest.yml/blockmap（electron-updater 元数据）+ 引擎资产一并挂载；资产按 `<platform>-<arch>-<文件名>` 扁平化（GitHub Release 资产是平铺命名空间，不支持子目录）
  - `engine-fetch.ts` 资产定位双口径：目录式 `<platform>-<arch>/manifest.json` 404 时回退扁平 `<platform>-<arch>-manifest.json`（自建镜像/raw 分支维持目录式）
- **SponsorBlock「跳过赞助/广告段」（#21 待办）**：`--sponsorblock-remove all` 物理剪切广告段（ffmpeg 在位才注入，随任务参数持久化、retry/resume 重放）；两个 SponsorBlock 选项收敛为**仅 YouTube 任务显示**（嗅探平台门控，此前标记选项对全部视频任务渲染）
- **EJS 零包体方案落地（#16 调查项，jsruntime 第三级回退）**：`ELECTRON_RUN_AS_NODE=1` 下 Electron 主二进制即 Node.js 运行时——把自身可执行文件以 node 名注册进引擎目录（落盘三级：硬链接零拷贝 → 符号链接 → 复制；`node --version` 实测验证；应用更新后按体积对齐重建），spawn yt-dlp 时注入环境变量（子进程继承，yt-dlp 链路均非 Electron 进程无副作用）——不增一分包体/下载量获得 Node 运行时，VidBee 式捆绑 Node（+50MB）路线不再需要；健康页公示「Electron 复用（零包体）」；与 deno 同口径不入 TOFU（主进程从不执行，备案）

### 回归审查修复（对本批次全部改动的审查）

- **P1 陈旧 shim 环境变量缺失**：应用更新后 enginesDir 的 node 硬链接仍指向旧 exe inode（体积对齐重建在 tier-3，一级查找先行命中），原实现仅对 `source='shim'` 注入 `ELECTRON_RUN_AS_NODE=1`——yt-dlp 无环境变量调起旧 Electron 二进制会启动 GUI 而非 Node 运行时；改为凡解析自引擎目录的 node 一律注入（该变量为 Electron 专属，真 node.exe 零感知）
- **P2 移除 shim 复制兜底**：跨卷（Windows 便携版）同步复制 ~200MB 发生在所有 yt-dlp spawn 经过的同步探测路径，阻塞主进程数秒以上；只保留硬链接（同卷）/符号链接（POSIX），跨卷降级「缺失」走 deno 按需下载主路径
- P3：fetch-sidecars 软失败后不再误报「全部就位」（区分核心四件套与按需下载引擎软失败计数）

### 遗留（外部资源 / 人工，roadmap 一期未关账项）

- macOS 签名与公证：等待 Apple Developer 证书（§一 #1）
- 音乐五平台逐平台人工回归（§三 #10）；yt-dlp EJS 真机验证需代理环境复测

## [0.7.3] - 2026-10-04

### 第七轮全面审查修复（五域并行：主链路 / 音乐网络 / 工具箱更新 / 渲染层 / 基建安全）

### 遗留项清账（同日第二批：「全部修复」指令驱动）
- **增量补下双重记账闭合**：re-add 不再提前清 `completedAt`（保留为「待回撤」锚点），经增量 job / 重启恢复泵 / 失败重试 / 排队暂停恢复四条起跑路径统一回撤——排队窗口「删除→恢复→完成」不再双计入 daily_stats
- **engine-fetch 断点续传 + 空闲超时**：`.part` 断点 Range 续传（续传前对既有部分求哈希，最终整包 SHA256 比对兜底；416/不支持 Range 自动重下）+ 60s 无进度空闲中断——替代硬 10min 总超时（弱网大引擎 ~200MB 从此可装完）
- **音乐下载流停滞检测**：`fetchToFile` 45s 无字节进度判定断流（走平台回退链继续试下一个镜像/平台）；试听流维持 `bodyTimeout=0`（`<audio>` 暂停播放依赖，不适用）
- **TOFU 覆盖面补全**：ffprobe 入指纹闸门（下载即登记 + `probeStreams`/yt-dlp 探测 spawn 前强制校验——此前替换 aria2c/yt-dlp/ffmpeg 被拦而替换 ffprobe 可静默执行）；demucs 留空走 PATH 时经 where/which 还原完整路径进同一指纹闸门（消除「填路径=受管、走 PATH=免检」双标）；deno 显式备案为接受项（主进程从不执行，无强制点）
- **CI 自动更新通道恢复（win）**：不再丢弃 `.exe.blockmap`（随 exe 同步重命名）+ 打包后生成 `latest.yml`（sha512 base64 手工计算）——发布资产挂上即恢复 electron-updater 整包/差量自动更新；mac/linux 维持手动检查通道
- **fetch-sidecars 下载侧 SHA256 预校验**：官方提供校验和资产时强制比对（yt-dlp `SHA2-256SUMS`），不符即拒绝安装；无校验和的源明确告知跳过
- **设置页反馈迁移**：顶部 flash 横幅在深滚动位置不可见——21 处成功/警示反馈统一改全局 toast（失败点显式 warning）；移除横幅渲染与遗留 state
- **mini 悬浮窗 / 主题名 i18n 接入**：MiniWidget（运行/排队/关闭按钮）与七主题名（侧栏/主题菜单/设置外观/向导）走 i18n（en locale 此前仍显示中文）
- **scripts/*.ts 纳入 typecheck**：`tsconfig.node.json` include 补 `scripts/**/*.ts`（清理 e2e 脚本两处未用 import）
- **渲染层测试破零**：tasks store 6 例（事件合流/错误清除/removed/未知任务防抖与记忆/置顶乐观回滚/load 乱序防护）；`run-tests.js` 收集范围扩展到 renderer/shared
- **测试反哺修复**：新用例抓到「unknownReloadSeen 在自动重载自身 load 成功后也被清空」——排除型视图无限重载修复未真正闭环；改记忆只在换视图时清空（`lastLoadFilter` 区分用户切换与自动重载）

### 回归审查修复（对本批次全部改动的三路二次审查）
- **P2 增量补下 allowOverwrite 未贯通**：排队暂停恢复 / 重启恢复泵 / 失败重试三条二次起跑路径裸 `start`——增量补下任务（saveDir 有原完成文件）只要离开「首次确认即有槽位」的理想时序就系统性撞 File already exists；三处按 completedAt 锚点存在与否放行覆盖
- **P2 回撤语义不一致**：confirmSelection 内联回撤 reverse 抛错仍清锚点（统计双计且锚点丢失不可重试）——收敛到 `consumePendingCompletion`（失败保留锚点下次再试）
- **P2 downloadById 取消误删**：按 ID 精确下载通道的取消清理未接 `lastProductForeign`——exists 兜底命中后取消会误删并发同歌任务/用户既有产物；补 foreign 判定 + cached 不改名
- **P2 角标停滞**：refreshCounts 过滤把 paused/queued→running 的跃迁一并滤掉——恢复任务后「处理中」角标不更新；applyEvents 标记真实跃迁（countsDirty）统一刷新
- P3：增量 re-add 清旧 engineGid；engine-fetch 校验 206 Content-Range 起始偏移（错位回退整包重下）；fetchToFile end 即停停滞表（大缓冲慢盘 flush 误杀）；previewUrl 失败留痕；env 主数据目录补 0o700；托盘批量操作补 catch（aria2 离线窗口 unhandledRejection）；对话框已开时剪贴板新链接给一次性提示；设置页引擎状态手动刷新同步 engineLoadFailed；fetch-sidecars 校验和清理失败不掩盖根因 + yt-dlp linux arm64 资产名改 aarch64（上游命名）；demucs PATH 解析跳过 Microsoft Store 别名 stub；磁力查重命中「进行中任务」改为明确报错（原会复用文件树后在确认时抛 IllegalTransitionError）

### 修复（P1）
- **排队任务「暂停→恢复」丢失文件勾选**：恢复分支裸 `aria2.start` 不带 `selectionFor`——部分勾选的 BT/磁力任务在并发排队窗口被暂停再恢复时，aria2 全量下载用户明确取消勾选的文件（对齐 recoverEngineTasks/retryTask 口径）
- **引擎按需补齐落盘前未建目录**：`engine-fetch` 的 `createWriteStream` 在 `mkdir` 之前——mac/Linux 打包态引擎目录回退到 `userData/engines`（必不存在）时，全新安装首启补齐全部失败且每次启动重复失败（对齐 updater/ytdlp.ts 同型修复）

### 修复（P2 主进程）
- **ytdlp/nm3u8 启动在途窗口收口（与 aria2 对称）**：`ensureVerified/ffmpegAvailable` 可达秒级，窗口内暂停会被 running 合法转移静默撤销、删除会幽灵下载到完成——job 返回后按任务状态补杀进程
- **托盘「全部继续」启停条件写反**：resumeAll 语义对象是 paused 任务而聚合速度只统计 running/queued——全部暂停后按钮反而禁用；改恒可点（无 paused 任务时为无害 no-op）
- **base32 磁力查重失效**：库中 infohash 恒为 hex，base32 形态（野外最常见）原样比对永远 miss——查重前归一化，「秒开文件树」对 base32 磁力恢复生效
- **aria2 起不来时非 aria2 排队任务永久卡死**：恢复泵绑死 aria2 onOnline，二进制缺失/损坏时 ytdlp/nm3u8 任务无 retry 出口——`recoverEngineTasks` 支持按引擎过滤，supervisor 启动失败即恢复非 aria2 任务
- **向导里关不掉剪贴板监听（隐私开关失效）**：向导经 settingsSet 写字符串落库成带引号 JSON 串，主进程裸文本比对判真——读取侧兼容两种落库形态 + 向导改写布尔值
- **托盘创建失败=僵尸进程**：Linux 无 AppIndicator 环境下 `new Tray()` throw 使 `interceptCloseToTray` 未注册——关窗后无窗口无托盘无交互入口；创建与关窗拦截解耦 + 失败留痕
- **音乐并发同歌产物归属**：网易云「目标已存在即成功」的兜底路径未标 cached——并发同歌任务取消清理会误删他人刚产出的文件、cached 命中还会被改名；产物归属标记 + cached 全路径跳过清理/改名

### 修复（P2 工具箱）
- 音频四工具（响度标准化/人声伴奏分离/淡入淡出/变速）缺 `-vn`：视频源输入时视频流被默认选择进 mp3 容器必失败（对齐 trim 口径）
- 视频压缩容器兼容漏网：webm/mkv（vorbis/opus）源音轨直拷装不进固定 mp4——输出容器跟随源文件
- 多段合并（region-concat）对无音轨视频必失败：filtergraph 硬引用 `[0:a]`——ffprobe 探流降级为纯视频合并（探测失败保持旧行为）

### 修复（P2 渲染层）
- 托盘/剪贴板唤起新建任务会整体重置已打开的解析会话（磁力 90s 解析结果/勾选全丢）——对话框已打开或向导期间忽略新 payload
- 设置页引擎管理加载失败永久伪装「加载中…」——补错误态；订阅「立即检查」成功反馈改全局 toast（flash 横幅在页面顶部，深滚动位置无感知）
- 快捷键 Delete 移入回收站固定 `reload('all')` 污染 loadedFilter（双载+骨架闪烁）——改按当前过滤器；NewTaskDialog 过滤器白名单补 `failed` 视图
- HelpOverlay 漏注册 useModalGate（Inspector 开着时 Esc 一键双关）；主题菜单 Esc 补 stopImmediatePropagation

### 修复（P3，择要）
- 主链路：resume 的 aria2 unpause 失败归一中文+出口动作；verifying/seeding 点暂停由静默改显式拒绝；trim/clip 产物名 0.01s 精度防碰撞；MusicBrainz 产物名锚定输入文件名（防同名覆盖）；GIF 工具描述与实现对齐
- 音乐：`fetchJson` 响应体超限改不可重试（不再 3 次全量重拉）；试听/预览链路补 45s 总 deadline；preview 协议与下载链路审计（Range/流关闭/镜像容错）核验通过
- 基建：`scripts:toggle` 强制布尔（字符串 "false" 使禁用失效）；`app:pickFolder` 挂 parent 窗口；bridge Web UI 补 CSP 头；订阅数量上限 64（对齐调度规则口径）；BT 外网诊断 30s 节流+单飞（防公网 IP 反复外送）；数据目录兜底 mkdir 补 0o700；DB 降级场景（user_version 高于应用）留痕告警
- 渲染层：HealthPage 补加载态+轮询 seq 守卫；统计页失败时隐藏空态引导（不再误导用户）；Inspector 切换任务先清旧文件清单；keymap-changed 改落盘成功后广播（与 resetAll 同口径）；进度批次不再逐帧触发 counts 全表聚合（仅状态跃迁刷新）；toast 容器补 role="status"、TriStateBox 半选态 aria-checked="mixed"
- 构建链：CI 改 `npm ci` + 顶层最小权限声明；fetch-sidecars 逐工具判断缺失（ffmpeg 在位不再连带跳过 ffprobe 收集）

## [0.7.2] - 2026-10-04

### 第六轮全面审查修复（五域并行：主链路 / 音乐网络 / 工具箱安全 / 渲染层 / 构建基建）

### 修复（P1）
- **磁力确认快速通道死分支**：`pendingGid` 仅存在于创建期内存对象而 `rowToTask` 不映射——确认勾选恒走「重新 addUri」分支（重新 BEP-9 取元数据最长 90s、确认后状态闪回暂停、旧 paused gid 与 `%TEMP%` 元数据目录泄漏、`.torrent` 产物误写保存目录）；改用落库的 `engineGid` 走 `changeOption+unpause` 快速通道
- **stem-demucs 任意二进制执行防线无效**：basename 白名单可被「改名 demucs.exe 的任意二进制」绕过——补 TOFU SHA256 指纹（首次使用登记，不一致即拒绝；指纹键不进渲染层写白名单）
- **fetch-sidecars 构建链两处断点**：`untar` 硬编码 `-xzf` 解不开 aria2 的 `.tar.bz2`（Linux CI 必挂，macOS bsdtar 自动探测故侥幸存活）改 `-xf` 自动探测；`place()` 跨卷 `rename` 抛 EXDEV（本机跨盘必挂）补 copy+unlink 回退

### 修复（P2 主进程）
- ytdlp/nm3u8 启动在途窗口内暂停被「running 合法转移」静默撤销——pause 返回 false 时显式报「任务正忙」而非假暂停
- `aria2.pause` 返回 `removed`（引擎条目已销毁）不再误标 paused（原 resume 永远失败且无出口），按 failed 终态给重试出口；runWhenQueued 在途暂停补偿同口径按 outcome 收口
- 解析中任务「删除→恢复」成永久僵尸——`restoreFromTrash` 补 parsing 归位 failed（给 retryTask 出口）
- aria2 引擎离线窗口删除/清空回收站整体失败（`getClient()` 同步 throw 逃出 catch）——adapter.remove 全程吞 RPC 错误并照常本地清理
- 音乐搜索排序反写：`artistMatch` 升序比较使原唱沉底被截掉，改降序
- `convert` 工具 `format` 参数无白名单可注入路径穿越（subtitle/image 同型已修唯它漏网）
- 轨道提取「全部音轨」`-c:a copy` 只作用于第一个输出文件——输出选项按输出对交错排列

### 修复（P2 渲染层）
- 排除型视图（完成/失败/回收站）+ 后台运行任务 = 每 400ms 无限重载不收敛——未知任务重载按「过滤器+taskId」记忆去重
- 新建任务对话框假取消：提交/解析在途时 Esc/遮罩/取消照关但任务照常创建——统一 `requestClose` 收口（提交期拒关、解析期明确告知）
- 工具完成/失败 toast 上收 App 层全局监听——页级监听随卸载解除，切页签后长任务终态无感知
- 主题弹层未屏蔽全局快捷键（Space 误暂停/Delete 误弹确认框）——补入屏蔽清单

### 修复（构建与资产）
- `package.json` 版本 0.1.0 → 0.7.2（与 CHANGELOG 口径同步；CI 产物命名与 electron-updater 降级判定均取此值）
- electron-builder 移除对不存在的 `resources/engines/common` 的 extraResources 引用
- CI win/linux 门禁补架构断言（linux `file` 查 x86-64；win 读 PE machine 字段），堵「错误架构静默进包」
- 删除已废弃的 `omni-service.exe`（39MB 死重随包分发）；引擎目录 README 与实际口径对齐；`ghLatest` 补 `--fail`（限流时正确报错）

### 修复（P3，择要）
- runWhenQueued 失败路径清 engineGid（旧 paused gid 不再泄漏至会话结束）；增量补下 `reverseCompletion` 记账失败不再把在跑任务打成 failed
- 重试保留用户视频选项（确认时随 params 持久化，重试恢复——音频提取/字幕嵌入/命名模板/delogo 不再丢失）
- 订阅：URL 查重改归一化键比对（`?si=` 追踪参数不再重复订阅）；createTask 成功即登记档案键（确认失败不再跨周期重复建任务）；连续失败 3 次熔断（永久失败条目不再无限 churn）；成功清零
- `getText` 补齐 Accept-Encoding 强制声明（R5 修复遗漏的调用面）；`fetchJson` 对非 JSON 正文改不可重试；移除官方域 `music.126.net` 的 TLS 校验豁免
- WebDAV 401/404 消费响应体 + 207 正文 8MB 上限；字幕下载 32MB 上限 + 解压 bomb 防护；远程封面代理 20MB 流式上限
- 工具源文件套用敏感目录读取黑名单（对称 Cookie 口径，userData 豁免）；ffmpeg/demucs 加 6h 兜底超时（离线网络盘不再无限占槽）；emit running 移至 spawn 登记后（cancel 竞态窗口）
- `settingsSet` 256KB 值上限；`resolveRepoSlug` 改构建期常量（消除违反打包约定的运行时 require）；`checkForAppUpdateNow` 死代码删除；bridge 页面 token 只走 header
- paused 任务 4Hz 空轮询帧去重；tracker 刷新统计按实际写入行数计数；safeStorage 不可用路径留痕；放弃确认的磁力元数据目录启动清扫（24h）
- 设置页初始化 17 IPC 改并行 + 计划规则加载失败禁写守卫；引擎补齐失败横幅改 danger 配色；统计页总览失败态显式标出；「说明」页版本号运行时读取；音乐搜索空输入禁用按钮

### 回归审查修复（对本批次改动的二次审查，2026-10-04 同日）
- **CI（P1）**：build.yml 的 PE 架构断言原用 `-Command '$p=$args[0]; …'` 传路径——`powershell -Command` 不绑定 `$args`（恒 null 必失败，Windows 门禁全红）——路径直接内插命令文本
- **磁力确认（P2）**：改用 engineGid 后「跨重启」与「awaiting 删除→恢复」（引擎侧 gid 已销毁）由可用变必失败——快速通道失败回落 re-add（addUri 磁力）
- **complete 补偿（P2）**：runWhenQueued/control 暂停补偿的 complete 分支对 queued/paused 态是空操作（→completed 非法转移被静默跳过，记账全丢且任务卡死无出口）——先合法归位 running 再投 completed 事件
- **渲染层（P2）**：NewTaskDialog 注册 modalGate——Inspector Esc 让位依赖 isAnyModalOpen，对话框未注册则「一键双关」修复未真正生效
- **打包（P2）**：electron-builder 平台段 extraResources 整键覆盖顶层——icon.png 并入 win/mac/linux 三段（顶层项被覆盖丢弃，打包态托盘/悬浮窗图标失效）
- preview 封面泵取消路径补 cancel 上游 reader（防 undici 连接滞留）；subtitle gzip 解压失败统一中文报错；unknownReloadSeen 改到 load 成功分支清空（持续失败的 load 不再反复放行重载）；失败横幅判定改 `includes('失败')`（漏报「已安装：A；失败：B」部分失败文案）；nm3u8 视频选项随 params 持久化（重试/重启恢复回放，含直播录制时长——原仅 ytdlp 覆盖）
- **新增**：demucs TOFU 指纹重置专用通道（`tool:demucsReset` + 工具页「重置二进制信任」按钮，二次确认）——指纹键渲染层不可写，合法升级原无任何可操作出口

## [0.7.1] - 2026-10-03

### 跨平台兼容专项（Windows / macOS / Linux 全面审查修复）

### 修复（mac/Linux 必现的功能阻断）
- **打包内 yt-dlp 文件名错位**：sidecar 收集脚本按发布资产名落盘（`yt-dlp_macos`/`yt-dlp_linux`），运行时按 `yt-dlp` 查找——mac/Linux 包内视频引擎必缺失；落盘名统一为运行时口径（win32→`yt-dlp.exe`，其余→`yt-dlp`），CI 门禁同步
- **打包态引擎目录只读**（macOS /Applications、AppImage squashfs、deb /opt）：引擎按需补齐/yt-dlp 热更全部 EROFS/EACCES 失败——引擎目录改候选链（可写打包目录 → `<userData>/engines` 写入 + 两级读取解析），热更器写目标改 `writableBinaryPath()`，`--ffmpeg-location` 传解析后的实际路径，JS 运行时 PATH 注入覆盖全部候选目录
- **macOS magnet: 唤起失效**：协议 URL 经 `open-url` 事件投递（不走 second-instance argv）——补事件处理（ready 前入队，窗口就绪后补派发，共用去重逻辑）
- **CI x64 dmg 捆绑 arm64 引擎**：mac job 分架构两段出包（--arm64 → `fetch-sidecars --target darwin-x64` 交叉收集 → --x64），门禁增加 `file` 架构断言；未规范命名的 dmg 产物显式告警
- **热更版本跳过缺陷**：tag 相同但二进制缺失不再误报「已是最新」（重新下载补齐）

### 修复（安全拦截面）
- 保存目录校验：realpath 符号链接归一（macOS `/private/etc` 旁路）+ 正斜杠 UNC（`//server/share`）拦截 + 盘符根拒绝 + `join('C:', …)` 盘符相对路径误判修复
- 敏感路径黑名单统一 `src/main/sensitive-paths.ts` 共享模块（save-dir / preview / Cookie 三面收敛；修复 `~/.ssh`、`~/Library/Keychains` 等条目在大小写敏感用户名下恒不匹配的实际失效）；writableDir 探测改写入探测口径（Windows ACL 语义）

### 新增
- **GPU 兼容模式**：`ui.disableGpu` 设置项（设置 → 外观）+ `OMNIGET_DISABLE_GPU=1`，ready 前追加 disable-gpu；GPU 进程崩溃一次性提示兼容模式出口
- Linux 托盘菜单「显示主界面」提升首项（AppIndicator 无 click 事件的降级）；mac 公证前置 `build/entitlements.mac.plist`

### 测试
- 回归单测 116 → 119（save-dir 平台分流断言 + /private、盘符根、正斜杠 UNC 回归）

## [0.7.0] - 2026-10-02

### 新增（R7 续 + R4 续批次，Backlog #4/#8/#11/#16–#22）
- HLS/DASH：**N_m3u8DL-RE 专用引擎**——`.m3u8/.m3u/.mpd` 清单链接嗅探分型（此前落 http 类型必产损坏文件）；适配器（`format=mp4` 混流、分片进度逐行解析、pause=SIGTERM 保留分片断点续下）、master 变体格式选择（清单解析纯函数 6 例单测）、engine 路由（RE 在位走 nm3u8，缺失回落 yt-dlp）；真机 E2E 68MB 通过
- HLS/DASH：**直播录制 MVP**——media 清单无 `#EXT-X-ENDLIST` 判定直播流，对话框录制时长选择（30min/1h/2h/不限），`--live-real-time-merge --live-record-limit`（选项经 v0.6.0-beta `--help` 核实）
- 订阅：**订阅追更中心**（频道/UP主/歌单自动入队）——DB 迁移 v2（subscriptions 表）、`yt-dlp -J --flat-playlist` 抓条目、档案差集防重复、10min tick 到期串行检查（单源上限 20 条）、设置页卡片 + IPC 四通道
- 去重：**下载去重双档案**——自有档案（`sha1:<hex>`，URL 明文不落盘，创建期命中拒绝）+ yt-dlp 原生 `--download-archive`（合集条目级）；`download.dedupe` 默认开
- 短视频：**自托管解析服务兜底**（快手/小红书补平台）——yt-dlp 解析失败且平台在 sidecar 覆盖面时自动改道自托管 Evil0ctal/Douyin_TikTok_Download_API 混合解析取直链（时效 URL 重启自动刷新、健康面板回写、合规边界：只消费公开 API 不内置签名）
- 视频：SponsorBlock 集成（`--sponsorblock-mark all` 标记赞助/广告段为章节）；**yt-dlp 外部下载器 aria2c 可选加速**（`--downloader aria2c -x 8 -k 1M`，自带 aria2 零包体成本）
- 视频：**yt-dlp JS 运行时探测**——2025-11 起 YouTube 下载需外部 JS 运行时（官方 issue #15012）；enginesDir（deno/node 与 yt-dlp 同目录）→ 系统 PATH 双查找面 + 30s TTL 缓存，健康页公示运行时状态；引擎清单增加 deno 按需下载位
- 体验：**迷你悬浮窗**——托盘开关，236×58 不可缩放小窗（聚合速度 + 迷你曲线 + 运行/排队计数，整窗拖拽），复用主渲染层 `?view=mini` 分支
- 预设：预设导出/导入（自描述 JSON 信封 + 同名去重合并）、命名模板纳入预设体系
- 新建任务：BT 文件树虚拟化（`useVirtualizer` 窗口化渲染，默认全展开 + 折叠箭头，嵌套勾选行为不变）

### 变更
- `sanitizeFilename` 按平台差异化——Windows 维持全量清洗，POSIX 仅中和控制字符与 `/`（`aux.txt`、末尾空格/点、`\` 等合法文件名不再改写）
- 引擎清单增加 `N_m3u8DL-RE`（发布侧直接放置解包后单文件 ~13MB）与 `deno`（kind=tool 不入 TOFU），均待 #3 release 资产

### 测试
- 回归单测 73 → 93（nm3u8-parse / video-extract / sanitize 平台差异化等）

## [0.6.0] - 2026-10-02

### 新增
- 音乐：侧栏「下载失败」视图（红色角标 + failed 过滤 + 行内一键重试）
- 音乐：搜索列表信息增强（歌曲时长 / 专辑 / 逐行音质下拉，默认展示全部三档音质）
- 音乐：试听改长条播放器（播放/暂停 + 可拖动进度条；preview 协议透传 Range 支持任意位置 seek）
- BT：UPnP / NAT-PMP 自动端口映射（TCP 数据 + UDP DHT，退出撤销、失败静默降级、设置项可关）
- BT：监听端口池 6881-6891（TCP/UDP）；Tracker 每日自动刷新 + 重启重注入
- BT：磁力元数据本地缓存——同 infohash 二次任务秒出文件树（原需 DHT 等待最长 90s）；magnet 自带 `tr=` 与订阅源并集注入
- BT：消息 arc4 加密（绕运营商 QoS，设置项）、连续 0 速 30 分钟自停、纯做种不计并发闸门
- HTTP：多源聚合下载——粘贴多个镜像 URL 合并单任务（content-length 一致性校验），`addUri` 多 URI 并行分段；`uri-selector=adaptive` + 按带宽自动扩并发
- 新建任务：单任务限速输入（2M/500K，留空不限）
- 短视频：分享文案 / 短链 302 展开直贴（抖音/快手/小红书/B站，不误伤音乐查询）
- 健康页：抖音/快手/小红书/微博/西瓜平台行（任务完成/失败按平台归因）
- Cookie 分站约定（`<platform>.txt` 优先于全局 cookie）；BT peer 指纹伪装（qBittorrent，提升 peer 接纳率）

### 修复
- 网易云搜索兼容新版 `ar` 歌手字段（旧 `artists` 已不下发，原唱校验恒败）
- 空歌手任务（只输歌名）按原版度择优——修复"所有平台均无法下载"必败场景
- 咪咕 listen-url 接口返回二进制时改走 listenSong.do 兜底直链（实测 4MB 音频可用）

### 测试
- 回归单测 65 → 73（shortlink 展开 / torrent 元数据缓存）

## [0.5.2] - 2026-10-02

### 变更
- 侧栏导航重命名与排序：全部 / 处理中 / 处理失败 / 处理完成（原 全部/下载中/已完成/下载失败），列表页标题、快捷键说明、帮助面板同步
- 文档整理：未完成项统一收口至 `docs/backlog.md`；CHANGELOG 移至根目录

## [0.5.1] - 2026-10-01 ~ 10-02

### 修复
- 四轮全面审查修复：P1×5 / P2×16 / P3×25（含竞态守卫、二次确认补全、写操作静默失败反馈、aria2c 选项实测校验等）
- UX 反馈补全批次：音乐搜索竞态守卫、pickFolder 失败反馈、ConfirmDialog danger 禁止 Enter 直通、弹层期间屏蔽全局快捷键、视频时长换算修正等 9 项

### 测试
- 回归单测 33 → 65（事件合并竞态、任务控制、状态机、统计口径回撤、音乐专项）

## [0.5.0] - 2026-10-01

### 新增（Backlog 实施 R1–R7 / T1–T6）
- 浏览器扩展（MV3：右键发送链接 + 可选自动拦截）+ 主进程本地桥接（回环 + token 鉴权）
- 任务队列与全局并发闸门（aria2/ytdlp 全部启动路径过闸）
- 批量链接抓取（新建对话框批量模式，逐行入队与结果汇总）
- 视频参数预设 MVP（保存/应用/删除）
- Web UI 最小版（回环任务面板 + 链接推送，与扩展共用桥接）
- 引擎按需下载机制（manifest SHA256 + TOFU 指纹登记）
- 下载按类型自动归档（opt-in）
- 工具箱：视频后处理族（倒放/移除音轨/变速/旋转/缩放/截图）、音频处理族（淡入淡出/变速不变调）、图片互转、视频/音频无损拼接、字幕烧录、校验和计算、种子创建与转磁力、视频批量串联
- 平台健康页（提取器健康度与失效平台公示）、i18n 骨架

## [0.4.0] - 2026-09-30

### 新增（M4 打磨发布）
- 回收站（删除默认保留文件，二次清除才删）、统计页（`daily_stats` 聚合）
- 快捷键体系（Ctrl+N/F/1..6、Space、Delete）、首次启动向导
- 本地工具箱八件套（转换/裁剪/响度标准化/人声伴奏分离 L1 等）
- 失败任务结构化诊断归因五类 + 一键出口动作、Tracker 管理器（多订阅源 + last-ok）
- 定时/分时段调度、BT 端口连通性诊断、七主题系统
- Inspector 抽屉（`layoutId` 共享元素过渡）

### 打包
- Windows NSIS 真机出包（81.3MB）；CI 三平台 build.yml；七视图三态走查通过

## [0.3.0] - 2026-09-30

### 新增（M3 视频）
- yt-dlp 适配器：`-J` 解析、进度模板、合集回放勾选、格式选择器、字幕/封面嵌入、cookie 注入、分片并发
- 短视频去水印 L1（源站直取）/ L2（候补通道）/ L3（delogo 后处理副本）三级降级
- 引擎热更器（SHA256 校验 + TOFU 指纹 + 原子替换）
- 视频转音频提取、解析结果预览（封面/时长/体积）与多维筛选

## [0.2.0] - 2026-09-29 ~ 09-30

### 新增（M2 音乐）
- 音乐工作台：网易/QQ/酷狗/咪咕/汽水五平台搜索下载、三档音质、LRC 歌词落盘
- 原唱校验 + 原版度打分、完整音频校验（≥1.5MB 原子落盘）、五平台回退链、批量文本导入

### 变更
- 架构变更：Python FastAPI sidecar → 主进程内嵌 TS 引擎（`src/main/music/`，真取消 + `omniget-preview://` 试听协议，删除全链路 sidecar）

## [0.1.0] - 2026-09-29

### 新增（T0 工程基建 + M1 骨架）
- Electron 33 + Vite + React 18 + TS 严格模式工程骨架；better-sqlite3 持久化与自动迁移；TOFU 指纹校验
- 统一任务模型 + 引擎适配器架构（aria2/yt-dlp/music/tool）
- BT/磁力/HTTP 全链路：磁力 BEP-9 元数据流程（先解析后勾选）、`.torrent` 本地 bencode 解析（base32→hex 归一化）、文件树三态勾选、多线程滑杆、断点续传、增量补下
- 系统集成：托盘、`magnet:` 协议注册、剪贴板监听（30s 去重窗口）、开机自启
- 虚拟滚动任务列表；单测 32 + e2e 通过
