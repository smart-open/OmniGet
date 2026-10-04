# Changelog

> OmniGet 产品变更记录。版本号遵循 `0.x.y` 约定：**x（中间版本号）随功能里程碑递增**，y 为里程碑内的小修/加固版本。初始版本 0.1.0。
> 格式参考 Keep a Changelog；日期为里程碑完成时间。里程碑与验收口径溯源至《OmniGet-产品技术设计文档》§10。

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
