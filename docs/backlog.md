# OmniGet Backlog

> 2026-10-02 由《遗留问题清单》《OmniGet-产品技术设计文档》《OmniGet-竞品分析与路线图》（原「产品规划-竞品分析与路线图」）《下载引擎优化方案-BT磁力-短视频-P2SP》合并而来，仅收录**未完成**项；已完成内容见各原文档 / git 历史。
> **约定**：任务完成后在条目前追加 `✅`（含完成日期）。
> 状态标记：`🔴 发布阻塞 / 🟠 待办 / 🟡 低优先（条件触发）/ ⏸ 观察项（暂缓/不做）`

---

## 〇、第五轮全功能审查（2026-10-03，三域并行：任务主链路 / 安全攻击面 / 渲染层 UX）

> 修复 21 项（P1×2 / P2×7 / P3×9 + 安全×3），详见 git 历史。**接受不修项**（记录备查）：
> - **bridge:info 明文 token**：设置页卡片的产品用途即向用户展示 token 供扩展配置，渲染层自身已具备 createTask 等同权 IPC，token 的增量风险仅为「可被外带持久化」——与展示用途冲突，维持现状；
> - **sidecar:probe 任意 URL**（状态码级 oracle）：「测试连接」需在保存前探测用户输入值，限制为已配置值会破坏交互；仅状态码回显、无响应体，风险可接受；
> - **Windows 签名 / macOS 公证**：见 §一 #1/#2（外部资源）；
> - **netdisk 数据面边界**：netdisk IPC 对「渲染层已读过的服务器路径」不做会话级校验——凭据黑名单保护的是凭据本身，网盘文件读取面属自托管信任边界（同 #11/#26 口径）。

---

## 〇-B、第七轮全面审查 + 遗留清账（2026-10-04，五域并行 + 三路回归审查）

> 第七轮审查修 P1×2 / P2×12 / P3×20+；同日「全部修复」清账全部遗留项（增量补下双重记账、engine-fetch 断点续传+空闲超时、流停滞检测、ffprobe/demucs PATH 入 TOFU、CI 自动更新通道恢复、fetch-sidecars 下载侧 SHA256 预校验、设置页反馈迁移、mini/主题名 i18n、scripts 纳入 typecheck、渲染层测试破零）；三路回归审查再修本批自身引入的 P2×4 / P3×10。完整清单见 CHANGELOG 0.7.3 与 git 历史。**接受不修项**（记录备查）：
> - **exe 签名**：见 §一 #1/#2（外部证书资源，代码侧无解）；
> - **deno 不入 TOFU**：主进程从不执行 deno（yt-dlp 自行调用，无强制点），入 TOFU 无 enforcement 意义——engine-fetch 注释已显式备案；
> - **demucs TOFU 指纹单键**：用户填路径与 PATH 解析共用 `toolbox.demucs.fingerprint`，交替使用两个 demucs 版本需手动重置（有「重置二进制信任」出口，摩擦可接受）；
> - **themeMenu Esc stopImmediatePropagation**：对「主题菜单与其他弹层互斥」存在隐式依赖，未来新增非模态浮层需留意；
> - **回收站内选中任务按 Delete**：重复 softDelete（幂等无害）+ 确认文案与实际操作不符——主进程 isTrashed 守卫在，留待 UX 打磨。

---

## 〇-C、二期音乐纵深批次（2026-10-04，roadmap 二期五项，0.9.0）

> 五项全部落地：无损档 / 歌单批量 / 双语歌词 / 音乐库 / 归档模板，明细见 CHANGELOG 0.9.0 与 git 历史。**接受不修项**（记录备查）：
> - **歌单批量暂仅网易云**：QQ/酷狗/咪咕/汽水无稳定公开歌单 API（合规红线不自研签名+第三方镜像不承诺歌单端点），后续核验到可靠公开接口再扩展；
> - **音乐库不做存量扫描**：仅 `music.done` 完成即登记（music_tracks 表 v3）——升级前已下载的历史曲目不入库，避免全盘扫描的路径/元数据猜测噪音；
> - **双语歌词仅网易云源**：其余平台歌词接口无可靠翻译轨；`music.lyrics` 默认原文，不改既有行为。
> - 遗留人工项：歌单解析/无损产物/音乐库试听/补标签四链路待真机走查（镜像 API 时效性，归 §三 #10 同批回归）。

---

## 〇-D、四期统一内容管理批次（2026-10-04，roadmap 四期四项，0.11.0）

> 四项全部落地：统一媒体库 / OpenSubtitles 入库钩子 / 音频处理族 / NFO 导出，明细见 CHANGELOG 0.11.0 与 git 历史。**接受不修项**（记录备查）：
> - **入库钩子默认关**：OpenSubtitles 匹配依赖用户自备 API Key（免费配额），NFO/海报会在用户目录落盘——两者均 opt-in（`video.subtitleHook` / `video.nfoExport`），不改变既有默认行为；
> - **钩子失败仅留痕**：字幕匹配/NFO 导出 fire-and-forget，失败 log.warn 不广播通知——配额耗尽（HTTP 406）是常态，逐次弹条会形成骚扰；成功路径经通知条公示；
> - **合集产物不入库**（三期口径延续）：统一库/钩子仅覆盖单视频/直播录制产物；
> - **DB 无新迁移**：统一视图只读两张既有表（music_tracks/videos），exists 为列表期 fs 标注不落库；
> - **章节容器白名单**：仅 mp3/m4a/m4b 可写章节（ID3v2 CHAP/MP4 chapter），flac/wav 等报错给出「先格式转换」出口动作；
> - 遗留人工项：OpenSubtitles 真机回归（API Key/配额/哈希命中率）、NFO 在 Jellyfin/Emby 的实际扫描效果、批量转码大文件队列实测。

> **同日回归审查（独立子代理复核 + 修复）**：修 10 项——
> - **P1×1** 入库钩子耦合：字幕步骤抛错（「未匹配到字幕」是最常见正常结果）会连带跳过 NFO 导出 → 字幕步骤独立 try/catch；
> - **P2×4** ①批量转码 ffmpeg 双语义错：多输出时选项只作用于紧随的下一个输出（须逐输出重复）+ 默认流选择是「跨全部输入挑最优」而非「第 i 输入 → 第 i 输出」（须显式 `-map i:a`，缺流加 `?` 容忍）；②音频章节 `-map_metadata 1` 会用无标签 ffmetadata 覆盖原音频 title/artist → 改 `-map_metadata 0 -map_chapters 1`；③`prewrite` 写盘失败（磁盘满/EACCES）逃逸 finally → 工具并发信号量泄漏、两次即队列永久卡死 → 写盘入 try；④loudnorm async build 逃逸并发信号量（N 任务 = N 路并发全量解码）→ `acquireSlot` 前移到 build 之前（附带：构建期取消登记 building 集合，spawn 前复核放弃）；
> - **P3×5** ①`existsSync` 同步跑主线程，断连网络盘冻结全应用 → 改异步 stat + Promise.all；②自动 NFO 与封面抽帧并发竞态（poster 几乎必然跳过）→ 钩子链 await generateCover（顺带去重原独立抽帧调用）；③库行注销/任务删除与钩子链的孤儿字幕窗口 → 链首 isTrashed 复核；④safeStorage 降级明文时 UI 谎称「加密存储」→ status 回传存储形态 + 保存后刷新；⑤字幕语言保存无校验（`Chinese` 落库但静默回退 zh）→ 保存前同口径正则校验。
> - **接受不修项**：loudnorm 第一遍测量进程不登记进程表（cancel 只拦第二遍转码；测量有 15min 兜底超时自然终止，def.build 签名无 taskId 通道，改造性价比低）；MP4 档 `-map i:v:0` 对无视频流输入整批报错（缺流文件本就不该进转码批，错误信息可定位）。

---

## 〇-E、第九轮全面审查（2026-10-05，五域并行，0.11.1）

> P1×1 / P2×13 / P3×25 修复 + 同日「全部修复」指令清账观察项，明细见 CHANGELOG 0.11.1 与 git 历史。清账结果：
> - ✅ **删除含文件补清 ytdlp `.part`/`.ytdlp` 残片**：remove 前捕获适配器产物追踪，按产物名前缀清理（saveDir 顶层；RE 临时分片无公开命名契约，注释备案不猜删）；
> - ✅ **fetch-sidecars 供应链加固（重大）**：q3aql/aria2-static-build 仓库已消失（404，CI 已断）——主源切 dmesg00/aria2-static-builds + abcfy2 兜底；BtbN checksums.sha256 + GitHub API assets[].digest 全量接入下载侧校验；顺带修 ghLatest 双重路径 bug（ffmpeg 步骤此前必失败）；darwin 静态构建上游已绝迹，缺失时报错给手动放置出口；
> - ✅ **settingsGet 黑名单模式化**：精确键 + 命名模式双层，未来凭据键默认拒绝（已核对现有键无误伤）；
> - ✅ **便携模式统一 Chromium profile**：adoptPortableUserData + setPath（锁后/ready 前），legacyDataDir 用重定向前快照；enginesDir/preview 白名单/图标链核实不受影响；
> - ✅ **顶栏搜索注释口径修正**；
> - **MSI 目标不支持 magnet: 协议注册**（WiX 限制，代码侧无解）：运行时 `setAsDefaultProtocolClient` 部分兜底，发布说明标注即可；
> - 遗留人工项：aria2 重启端口顺延/changeGlobalOption 重放多实例真机回归；`openStream` 手动重定向对镜像 CDN 多跳链路实测；dmesg00/abcfy2 源的三平台 fetch-sidecars 真跑（本机仅验证 win 7z 解包 + digest 一致 + API 资产清单）。

---

## 〇-F、五期生态补齐批次（2026-10-05，roadmap 五期代码侧三项，0.12.0）

> 三项全部落地：调度合并编排 + 订阅队列分组 / Web UI 远程强化 / i18n 扩展语种，明细见 CHANGELOG 0.12.0 与 git 历史。**口径与接受不修项**（记录备查）：
> - **停运窗口不覆盖音乐/工具引擎**：两者有独立信号量与专属暂停语义（音乐=取消、工具=无暂停），纳入停运编排需逐引擎特判且收益低——停运窗口语义限定为「运行中的下载引擎任务」（aria2/ytdlp/nm3u8），设置页文案已明示；
> - **停运窗口不暂停 queued 任务**（自审查 P1-1 修正）：queued 由启动闸门持队不派发即达成停运效果；若转 paused，窗口结束的批量恢复会绕过并发闸门直接重 spawn（ytdlp/nm3u8 resume 不经 gateStart）瞬间突破 maxConcurrent——审查后改为仅暂停 running，窗口结束恢复数 ≤ 窗口开始时运行数，无超发；
> - **启动在途任务限时重试**（自审查 P3-8 修正）：「任务正忙」不再永久放弃——10s × 10 次重试覆盖磁力 metadata 最长 90s 窗口；耗尽仍失败广播 warning 公示（不再静默打破「停运」承诺）；
> - **跨零点窗口星期按开始日判定**（自审查 P2-3 修正）：周五 22:00–06:00 的周六凌晨仍属周五窗口（此前逐分钟按当天 getDay() 重判会在零点提前掐断并恢复任务）；scheduler.test.ts 回归锁；
> - **窗口结束仅恢复调度暂停的任务**：`schedulePaused` 集合记账——用户在停运窗口内手动恢复/暂停的任务不越权代管；手动恢复的任务在窗口内继续跑属用户意图优先；
> - **旧调度规则零迁移**：days/mode 为可选字段，旧 `schedule.rules` 数据按「每天 + 分时限速」兼容解析（sanitize 缺省归一），DB 无新列；
> - **LAN 模式 Host 白名单放行**：局域网设备以 IP:port 访问，Host 白名单会误杀；token 全端点强制（query token 仅页面 bootstrap 一处）+ DNS rebinding 拿不到 token 兜底，风险面与回环模式一致；
> - **桥接生命周期串行化**（自审查 P1-2 修正）：startBridge/restartBridge/stopBridge 全量入队串行 + listen Promise 化 + 重启前等待端口释放——消除 listen 在途二次触发的双 server 泄漏与端口静默顺延；绑定失败回滚设置并上抛（UI 不再假报成功）；
> - **`/api/task/:id/:action` remove = 软删入回收站**：远程面板不提供「彻底删除（含文件）」——误触破坏面控制在可恢复范围，物理删除回桌面端经 confirmAction 二次确认执行；
> - **i18n 键位齐平靠单测锁定**（自审查 P2-4 修正为全键集逐键对比 + 空文案拦截）：后续新增键漏译/漏改会被测试拦截；zh-TW 混入简体「适」×3 已修正；主进程侧（托盘通知等）仍为硬编码中文，维持既有接受口径；
> - **观察项（接受现状）**：①`/api/tasks` 关键词/分页仍在 JS 内存过滤（状态过滤已 SQL 下推），任务量数万级时轮询开销上升——量级触达再下沉 store 层；②LAN 模式对 `/?token=` 无速率限制（32 位 hex 熵足够，暴力枚举不现实；如需强加固可加失败退避）；③调度器测试依赖 `OMNIGET_TEST_DATA_DIR` 每文件注入（node:test 默认进程隔离成立，若未来改单进程隔离需改 db 单例注入方式）；
> - 遗留人工项：停运窗口（跨窗口暂停/恢复/窗口内新建）/ LAN 面板多设备真机回归、任务列表 10k 60fps 实测、macOS/Linux 走查（#9/#10）、签名/公证（#1 外部资源）。

## 〇-G、四期遗留「移动端提交」批次（2026-10-09，roadmap 四期最后一条代码侧待办，0.13.0）

> 前置五期 5.2（Web UI 远程强化）已于 0.12.0 落地，条件解除后补齐。两项落地：Web 面板移动优先重写 / 设置页 LAN 扫码配对，明细见 CHANGELOG 0.13.0 与 git 历史。**口径与接受不修项**（记录备查）：
> - **页面渲染抽至 `bridge-page.ts`**：零 electron 依赖（bridge.ts 直测会拖入 app 单例），8 例离线单测锁定视口 meta/卡片布局/分页/粘贴降级/轮询门控/安全口径/端点注入/脚本区无模板插值残留；
> - **粘贴按钮安全上下文降级**：`isSecureContext && navigator.clipboard.readText` 特性检测——LAN 明文 HTTP（非 localhost）下浏览器拒绝 readText，按钮隐藏降级手输；不为此引入 HTTPS 证书链（LAN 面板维持 token 兜底口径）；
> - **「加载更多」复用既有 offset/limit**：默认每页 50 条，poll 从 0 重取 `offset+PAGE` 条整体替换（offset 仅由加载更多推进）；过滤输入变更即重置 offset；不做无限滚动（触控行为不可预期，显式按钮可控）；
> - **后台暂停轮询**：`visibilityState === 'hidden'` 时 poll 直接返回 + visibilitychange 回前台补拉——手机省电省流；桌面端常驻可见行为不变（5s 轮询）；
> - **扫码配对用 devDependency `qrcode`**：纯 JS 无原生绑定，渲染层 vite 打包进 bundle（不增 sidecar/主进程体积，包体预算约束不触）；多网卡点选切换 = 换二维码 + 复制链接（toast 反馈，UX 硬性标准）；
> - **安全口径零变动**：token 剥离/confirm/CSP/鉴权边界与 M-3 口径一致；客户端脚本禁用模板插值（单测锁 `无 ${`）；
> - 遗留人工项：手机真机扫码配对与面板触控走查（随 §三 #10 平台回归）。

---

- **现状**：`electron-builder.yml` mac 段已有 `identity` / `notarize` / `hardenedRuntime` / `entitlements` 注释化占位；代码侧已就绪。
- **待办**：
  - [ ] Apple Developer 账号 + 证书接入 CI（`CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`）
  - [ ] 取消 yml 注释 + 提供 `build/entitlements.mac.plist`
- **备注**：无证书期间分发口径（2026-10-01 确认暂无 Apple 开发者账号）：未签名 dmg，用户首开需右键 →「打开」或 `xattr -cr /Applications/OmniGet.app`；应用已实现 TOFU 引擎指纹校验，未签名不影响运行时安全闸门。

### 2. ✅（2026-10-04）Windows CI 代码签名
- **已完成（一期 0.8.0）**：
  - [x] ✅ CI 上开启 `signAndEditExecutable`：`build.yml` win 打包 CLI 覆盖 `-c.win.signAndEditExecutable=true`（CI 具备 winCodeSign 特权条件，恢复 exe 图标/版本信息印刻）；本地 `electron-builder.yml` 维持 `false`
  - [x] ✅ 可选 EV 证书通道：secrets 配置 `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` 即自动启用 signtool 签名（显著降低杀软误报）；未配置（空值）仅资源印刻，构建不受影响

### 3. ✅（2026-10-04）GitHub Releases 发布侧资产（引擎按需下载生效前提）
- **已完成（一期 0.8.0）**：
  - [x] ✅ 发布资产生成链：`fetch-sidecars.mjs` 新增 deno / N_m3u8DL-RE 收集（软失败不阻断出包）→ `scripts/gen-engine-manifest.mjs` 产出 `<platform>-<arch>/manifest.json`（SHA256）+ 引擎文件本体 → `build.yml` release job tag 推送自动创建 Release（三平台安装包 + latest.yml/blockmap + 引擎资产）
  - [x] ✅ GitHub Release 资产是平铺命名空间（不支持子目录）——资产按 `<platform>-<arch>-<文件名>` 扁平化上传；`engine-fetch.ts` 目录式 404 回退扁平口径（自建镜像/raw 分支维持目录式）
- **待办（发布动作）**：
  - [ ] 打 v0.8.0 tag 推送即自动产出首个 release（electron-updater 需 latest 元数据；确认发布仓库与 `DEFAULT_MIRROR`（smart-open/OmniGet）对齐）

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
  - [x] ✅（2026-10-04）零包体方案落地（一期 0.8.0）：`jsruntime.ts` 第三级回退——enginesDir/PATH 均无运行时时，把自身二进制以 node 名注册进引擎目录（`ELECTRON_RUN_AS_NODE=1` 下 Electron 主二进制即 Node.js 运行时；落盘三级：硬链接零拷贝 → 符号链接 → 复制；`node --version` 实测验证 + 应用更新后按体积对齐重建），spawn yt-dlp 注入环境变量（子进程继承，链路无 Electron 进程无副作用）；健康页公示「Electron 复用（零包体）」；不入 TOFU（主进程从不执行，同 deno 备案）——VidBee 式捆绑 Node（+50MB）路线不再需要
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
  - [ ] 直播录制：RE `--live-real-time-merge --live-record-limit` 选项已核实存在，待 UI（录制时长选择）+ 嗅探 live 清单分型（已由 #20 落地，本行仅存档）
  - [x] ✅（2026-10-09，0.13.1）字幕轨道选择与命名模板对接 + audioOnly 生效：`nm3u8-parse.ts` 解析 `#EXT-X-MEDIA TYPE=SUBTITLES`（GROUP-ID/NAME/LANGUAGE；MEDIA 行插在 STREAM-INF 与 URI 行之间不清 pending，防误丢变体）→ `ParseOutput.subtitles` 透传对话框「字幕轨道」下拉 → `video.subtitleId` 随 params 持久化重放；RE 参数经本机 v0.6.0-beta（20260628 构建）`--help`/`--morehelp`/实跑参数解析实测：`-ss id=<GroupId正则>` 选轨，`--audio-only` 专用选项不存在、audioOnly 改 `-dv all`（去全部视频轨）+ `-sa for=best` 表达；命名模板 `video.template` 渲染为 `--save-name`（`resolveSaveName` 供 buildArgs 与产物预期路径共用，`/` `\` 中和为 `_`）；单测 +3（nm3u8-parse.test.ts 共 10 例）

### 18. ✅（2026-10-02）订阅中心（频道 / UP主 / 歌单自动追更）——MVP 落地
- **依据**：Pinchflat / Tube Archivist（自托管订阅自动下载库，容器化）、spotDL `sync`（歌单与本地目录双向同步、删歌联动）——「订阅自动化」是下载器向「内容管理」演进的高价值方向，OmniGet 已有定时调度器与批量抓取基建，边际成本低。
- **已完成**：
  - [x] ✅ DB 迁移 v2（subscriptions 表）+ 模块 `subscribe.ts`：CRUD、`yt-dlp -J --flat-playlist` 抓条目（过滤嵌套播放器）、档案差集、createTask+confirmSelection 直通自动入队
  - [x] ✅ 设置页「订阅追更」卡片：添加（名称/URL/间隔 1h~1d）/立即检查/删除，展示累计入队与上次检查/错误；IPC 四通道 + bridge
  - [x] ✅ 定时器：10min tick，到期源串行检查；单源单次上限 20 条；入队即登记档案防重复；新增经通知条公示
- **边界**：保存目录取全局下载目录；默认参数（无预设/模板）；检查依赖 yt-dlp 引擎。
- **三期升级（2026-10-04，0.10.0，roadmap「订阅中心升级」）**：DB v4 扩列；新增 RSS/Atom 源类型（`subscribe-rss.ts` 零依赖解析：enclosure > media:content > yt:videoId > link）；每源保存目录（validateSaveDir 同口径）/参数预设（`download.videoPresets` id → 确认参数映射）/命名模板；条目级过滤——最短时长秒（yt-dlp 条目 duration，RSS 无时长视为通过）+ 标题关键词（逗号/顿号分隔任一命中）；设置页卡片编辑模式（回填/更新，新通道 `subscribe:update`）。遗留：RSS 条目不支持时长过滤（源无该信息）

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
- **待办**：[x] ✅（2026-10-04）「跳过赞助/广告段」开关落地（一期 0.8.0）：`ConfirmSelectionInput.video.sponsorBlockRemove` → `--sponsorblock-remove all`（ffmpeg 在位才注入，随任务参数持久化、retry/resume 重放）；两个 SponsorBlock 选项收敛为仅 YouTube 任务显示（嗅探平台门控）。

### 22. ✅（2026-10-02）已下载去重（--download-archive）
- **依据**：spotDL sync / Pinchflat 均以 archive 文件为去重底座；OmniGet 重复粘贴同一合集 URL 会重复下载。
- **已完成**：双档案设计（`task/archive.ts`）——自有 `download.archive`（`sha1:<hex>` 键，URL 明文不落盘）：创建期命中拒绝（文案给关闭路径）、完成/订阅入队即登记；yt-dlp 原生 `ytdlp.archive`（`--download-archive`，合集条目级去重）。设置 `download.dedupe` 默认开，关闭后两档案均不启用。合集/订阅源 URL 不入自有档案（防订阅源被封死），条目级由 yt-dlp 档案负责。

### 23. ✅（2026-10-04，三期 0.10.0）弹幕下载与压制（B站 xml→ass，BBDown 范式）
- **依据**：BBDown 专属能力，yt-dlp 不产弹幕；需独立 B 站 API 适配 + xml→ass 转换工具。
- **已完成**：
  - [x] ✅ `danmaku/convert.ts` 纯函数：B站弹幕 XML → ASS（滚动 `\move` 轨迹 + 底部/顶部定轨车道分配、颜色/字号/透明度、`{}` 特效注入防御、3000 条上限）；4 例单测
  - [x] ✅ 工具箱「弹幕转换」工具（runtime=node，画布宽/字号/不透明度参数）
  - [x] ✅ B站视频任务可选压制：确认面板开关（仅 bilibili 非直播任务显示）→ 完成时公开 API 取 cid（`web-interface/view`）→ 拉弹幕 XML（`dm/listsoa`）→ ffmpeg subtitles 烧录 `_弹幕` 副本（原片保留；失败仅附注不判任务失败）
- **边界**：多 P 视频暂不支持（取主 cid）；压制为重编码（libx264 veryfast），长视频耗时较长；直播弹幕不做

### 24. ⏸ 主页级批量抓取（f2 / TikTokDownload 范式）
- **依据**：f2（2.4K★）支持用户主页/合集/点赞/收藏列表批量解析下载；TikTokDownload（8.4K★，已由 f2 接棒）。OmniGet 合集树已覆盖 playlist 场景，「主页全量 + 筛选下载」为增量。
- **⚠ 合规印证**：f2 内置 msToken/ABogus 等签名算法并遭平台风控对抗——再次印证 backlog #11「不自研签名」决策正确；主页批量仅基于公开 flat-parse 接口。
- **暂缓原因**：与 #18 订阅中心重叠度高（订阅=主页批量的自动化形态），先做 #18。

### 25. ✅（2026-10-04，三期 0.10.0）直播间 URL 直录入口
- **依据**：streamlink（~11K★，活跃）以**平台插件**把直播间地址（B站/斗鱼/虎牙/抖音/Twitch/YouTube 等）解析为流清单/直链，LiveRecorder 等无人值守录制脚本生态均以其为底座。OmniGet #20 直播录制已走 N_m3u8DL-RE 路线，但入口仅限 `.m3u8/.mpd` 清单链接——用户手里通常是**直播间地址**（形如 `live.bilibili.com/xxx`），当前嗅探无分型，落 http 类型必然失败。
- **已完成**：
  - [x] ✅ 嗅探器直播间分型（`live/rooms.ts` 纯函数规则表：live.bilibili.com / douyu.com / huya.com / live.douyin.com，房间号段校验 + 伪房间段排除；先于普通视频域命中）
  - [x] ✅ 解析链（`live/resolve.ts`）：yt-dlp `-J` 解析直播间页取最佳 HLS 清单直链（零新依赖）→ `manifestUrl` 改写 task.source 喂 RE（B站公开 API `room_playing` 兜底，合规红线：不自研签名）；B站/抖音按参数注入 `--header`（CDN 校验 Referer）；RE 缺席回落 yt-dlp 原生录制
  - [x] ✅ 直播 URL 不入去重档案（重复录制常态）；录制时长选择复用既有直播流 UI
  - [x] ⏸ streamlink 二进制兜底：间接取流路线对四平台均可用，维持不议
- **遗留**：各平台直播间真机回归（斗鱼/虎牙 extractor 健康度随 yt-dlp 上游浮动）
- **触发条件**：#20 已有录制时长 MVP，等直播录制使用反馈后排期。

### 26. ✅（2026-10-03）网盘/WebDAV 下载源（OpenList，AList 分叉）
- **依据**：AList（~48K★）2025-06 易主争议后社区分叉 **OpenList**（40+ 网盘聚合——百度/阿里/夸克/OneDrive 等，WebDAV 与直链双出口，开源免费，社区已完成闭源 API 清查）。国内用户「网盘文件转直链/本地下载」需求真实，OmniGet 下载源目前完全无网盘能力；**不自研任何网盘协议**，只消费用户自托管 OpenList 的标准出口。
- **已完成**：
  - [x] ✅ 模块 `netdisk/webdav.ts` + `netdisk/credentials.ts`：PROPFIND Depth:1 列目录（命名空间前缀容忍解析，`propfind.test.ts`）、逐段百分号编码 URL 构造、401/404/非 207 全部给出口动作文案
  - [x] ✅ 凭据安全存储：Electron safeStorage（Windows DPAPI/Keychain）加密落 settings 表（`netdisk.auth.enc`，读取黑名单 + 不进渲染层写白名单）；safeStorage 不可用降级明文并留痕。凭据仅注入请求头，不入日志/任务库
  - [x] ✅ 设置 → 下载「网盘聚合（OpenList / WebDAV，可选）」卡片：端点配置（http 放行，同 sidecar 信任边界）+ 测试连接（区分可达/认证失败/路径不存在）+ 凭据保存（保存即自动测试）+ 目录浏览（目录导航/文件勾选）+ 提交下载（单次上限 50 文件）
  - [x] ✅ 下载管线：`manager.createNetdiskTask`（http 类型直启、无 awaiting/勾选阶段，过并发闸门）→ aria2 addUri 每任务 `header` 注入 `Authorization: Basic`（`params.netdisk` 标记触发，重启恢复/重试重走注入）；`Aria2TaskOptions.header` 扩展
- **⚠ 安全口径**：沿用 #11 信任边界——用户显式配置的自托管地址放行 http、不做内网校验（PROPFIND 已在浏览阶段核验可达与认证）；凭据仅注入请求头，响应摘要不回显。
- **边界**：Basic 认证（OpenList WebDAV 即 Basic）；Digest 认证头注入不支持（aria2 原生 `http-user/passwd` 可作后续增强）。

### 27. ✅（2026-10-03）yt-dlp 元数据内嵌（--embed-metadata）
- **依据**：yt-dlp 原生 `--embed-metadata`（含 `--embed-chapters` 合并进同参数），零外部依赖；`adapters/ytdlp.ts` 已有 `--embed-thumbnail`（M3-5），元数据/章节内嵌未接——下载的影视/合集缺章节与标签信息。
- **已完成**：对话框视频选项「内嵌元数据与章节」开关（SponsorBlock 同款范式：`ConfirmSelectionInput.video.embedMetadata` → `VideoSelection` → ffmpeg 在位时注入 `--embed-metadata --embed-chapters`；会话内 pause/resume 凭 argsByTask 重放，重启恢复接受默认值——与既有 video 选项 M1-11 口径一致）。

### 28. ✅（2026-10-03）工具箱轨道族补充（MKVToolNix 范式）
- **依据**：MKVToolNix（V102，2026-09 仍活跃）差异化 = 轨道提取/轨道属性/章节/附件封装。盘点确认 OmniGet 工具箱 **LosslessCut 核心范式已覆盖**（无损剪切×2、拼接、多区域合并、去音轨，均 `-c copy`），剩余增量收敛为两项。
- **已完成**：
  - [x] ✅ 「轨道提取」工具（`track-extract`）：ffprobe 探流（`toolbox/ffprobe.ts`）→ 纯函数规划（`toolbox/track-plan.ts`，6 例单测）→ ffmpeg 多输出 `-map` 交错。音轨全部/指定序号 → `.mka` 流拷贝（任意编码可装）；字幕轨 → 统一转 `.srt`（mov_text/ass 均可转；PGS/DVB 图形字幕跳过并在描述明示，全图形轨明确报错）。序号越界/无轨在参数期即报错（不浪费执行额度）
  - [x] ✅ 「外挂字幕封装」工具（`subtitle-mux`）：视频 + srt/ass/ssa/vtt → mkv（`-c copy` 直拷）/mp4（`-c:s mov_text` 自动转码），可选 ISO 639 语言代码（白名单校验）写 `-metadata:s:s:0 language`
  - [x] ✅ 基建：`ToolDef.build` 支持 async（轨道提取探流 / MusicBrainz 联网匹配后组参），`toolbox.submit` 改 await（构建期异常仍走 failed 事件广播）
- **⏸ 不引入 mkvmerge 独立二进制**（~30MB 增量，ffmpeg 覆盖主场景；仅轨道属性批量编辑需求出现再议）。

### 29. ✅（2026-10-03）beets / MusicBrainz 音乐刮削（过渡路线落地）
- **依据**：beets（MusicBrainz 自动匹配 + 元数据归整）。OmniGet 音乐五平台引擎自带标题/歌手/封面元数据，MusicBrainz 增益在 yt-dlp 音频下载场景；beets 为 Python 生态不内嵌。
- **已完成（原「过渡路线」升级为正式实现）**：工具箱「MusicBrainz 补标签」工具（`musicbrainz-tag`）——按「歌手 - 曲名」（可从文件名自动解析，下划线中和为空格）查询 MusicBrainz WS 2 公开 API（显式 User-Agent、10s 超时、503 限流明确提示），取 score 首条写入 title/artist/album/date 标签（`-metadata` + `-c copy` 流拷贝不改音频数据，产物名用匹配到的真实歌手/曲名）；纯函数（文件名解析/标签映射）4 例单测（`musicbrainz.test.ts`）。beets 本体维持不内嵌（Python 生态）。

### 30. ✅（2026-10-03）字幕库自动匹配（OpenSubtitles 单工具落地）
- **依据**：Bazarr（30+ 字幕提供商哈希匹配，NAS 生态标配，活跃）。下载器场景 yt-dlp 已抓站内字幕（M3-5）；BT 影视外挂字幕匹配有价值，但需独立服务/Python 运行时。
- **已完成（原触发条件兑现：OpenSubtitles API 单工具入工具箱，不引入 Bazarr 全家桶）**：工具箱「OpenSubtitles 字幕匹配」工具（`subtitle-fetch`，node 运行时）——官方文件哈希算法（size + 首/尾 64KB LE 求和，BigInt 64 位回绕，2 例手工向量单测）→ `api.opensubtitles.com` 哈希精确匹配（用户自备免费 API Key；401/406 配额/无命中全给出路）→ 下载授权 → zip（EOCD+central directory 最小解析，store/deflate，优先字幕扩展名）与 gzip 自动解包 → 落盘视频同目录（重名追加序号不覆盖；ass 内容按 `[Script Info]` 识别扩展名）。纯函数 6 例单测（`subtitle-hash.test.ts`）。**⚠ 安全口径**：API Key 经表单参数随任务 params 明文落本地任务库（免费个人 Key、库不出本机，与 cookieFile 路径同敏感级；如后续需升级可改走 safeStorage 凭据通道，同 #26）。
**✅（2026-10-04，四期 0.11.0）升级为入库钩子**：API Key 迁移 safeStorage 凭据通道（`opensubtitles/credentials.ts`，键 `opensubtitles.key.enc`，读取黑名单 + 专用 IPC 写入，同 #26 口径）；工具参数留空自动回退凭据通道；设置 `video.subtitleHook` 开启后视频完成自动匹配（fire-and-forget，成功通知/失败留痕）。

### 31. ⏸ yt-dlp 外部插件目录（观察，不做内置入口——2026-10-03 复核维持）
- **依据**：yt-dlp 原生插件机制（`yt_dlp_plugins` 包 / `--use-plugins`，社区 extractor 长尾，EJS 本身即插件形态）。允许用户向引擎目录自放插件包可解锁长尾站点且免热更主引擎，但等同「用户自带任意代码执行」，与适配脚本声明式热更的合规形态边界冲突（同 §四「开放社区脚本不做」判定）。
- **处置**：不做内置入口/管理 UI；高级用户自行放置插件目录属引擎目录既有查找面，无需产品支持。（2026-10-03 复核：全仓无 `--use-plugins`/`yt_dlp_plugins` 引用，处置一致，无遗留代码。）

### 32. ⏸ rclone / slskd（不做）
- **rclone**（70+ 云存储后端）：下载器场景 aria2 直链 + #26 WebDAV 已覆盖主诉求；二进制 ~50MB 违背包体预算（§3.3），不引入。
- **slskd**（Soulseek P2P 音乐网络）：版权合规风险高，明确不做（同 §四 生成式 AI 的定位排除口径）。
