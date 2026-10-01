# AGENT.md — OmniGet 项目记忆

> 最后更新：2026-09-29 ｜ 维护约定：每完成一个里程碑/批次后更新「进度」与「关键决策」

## 1. 项目是什么

**OmniGet**：跨平台桌面下载器（Windows/macOS/Linux），一站式覆盖 BT/磁力（aria2c）、视频（yt-dlp）、音乐（omni-service）、HTTP 直链 + 本地 ffmpeg 工具箱。定位「本地优先、无广告、界面现代」。

**权威文档**（本目录 docs/，改动须同步）：
- `OmniGet-产品技术设计文档.md`（§1–§11 + 附录，所有实现的唯一依据）
- `OmniGet-开发任务计划.md`（T0/M1–M4 任务表，含 ✅ 标记与完成记录）

## 2. 技术栈与版本基线

| 层 | 技术 | 基线 |
|---|---|---|
| 桌面壳 | Electron | 33.4.x |
| 构建 | electron-vite 2 + Vite 5 | main/preload CJS 产物；renderer ESM |
| UI | React 18 + TS 5.7 严格模式 + Tailwind 3 + zustand 5（**v5 必须用 `create<T>()(fn)` 柯里化**）+ framer-motion 11（M4 用）+ @tanstack/react-virtual + @phosphor-icons/react |
| 持久化 | better-sqlite3 11（Electron ABI 预编译） | journal_mode=WAL, foreign_keys=ON, user_version 迁移框架 |
| 引擎 | aria2c 1.37.0 / yt-dlp 2026.08.19 / ffmpeg 9.0.2（sidecar 二进制，`resources/engines/win32-x64/`）；音乐引擎已**内嵌主进程**（`src/main/music/`，原 Python omni-service sidecar 已于 2026-09-30 迁除） |
| 测试 | node:test + tsx（`npm test` 经 `scripts/run-tests.js` Electron-as-Node）；e2e：`scripts/e2e-aria2.ts` / `scripts/e2e_ytdlp.ts` / `scripts/e2e_updater.ts` |

## 3. 目录结构（实际落位）

```
src/main/          主进程：index.ts(单实例锁+编排) ipc.ts(§6.1白名单注册表) logger.ts
  orchestrator/    ports.ts(aria2 RPC 端口分配) binaries.ts(TOFU SHA256+ensureVerified) aria2.ts(监督器+WS RPC客户端) proc.ts(跨平台进程树终止)
  task/            state-machine.ts(§4.1守卫) manager.ts(编排) store.ts(SQLite读写) events.ts(250ms合并) id.ts(uuidv7)
  adapters/        aria2.ts(parse/start/poll) types.ts(EngineAdapter接口)
  aria2/options.ts 参数作用域（全局 vs 每任务，§4.2边界表）
  torrent/parse.ts bencode→infohash→文件树→磁力；base32→hex
  integrations/tray.ts 托盘/通知/剪贴板/magnet协议/关窗最小化
  sniffer.ts       五类输入分型 + DedupeWindow(30s)
src/preload/bridge.ts   contextBridge 白名单（onUiAction 等）
src/renderer/src/  app/App.tsx stores/tasks.ts features/{new-task,tasks} components/ui styles/{tokens,global}.css
src/shared/        types.ts(Task模型/IPC通道/载荷) errors.ts(错误码表，文案必须带出口动作) select-syntax.ts
src/types/         bencode.d.ts
scripts/           e2e-aria2.ts（纯 Node 端到端）
resources/engines/ sidecar 按 <platform> 目录；构建经 extraResources
```

**注意**：renderer 实际 root 是 `src/renderer/`（index.html 在此），入口 `src/renderer/src/main.tsx`；styles 在 `src/renderer/styles/`（main.tsx 用 `../styles/` 引用）。electron-vite renderer root = `src/renderer`。

## 4. 当前进度

- ✅ T0 全部 8 任务（脚手架/构建/IPC桥/DB/Token/TOFU校验/日志/端口）
- ✅ M1 全部 12 任务 + 全面审查修复 20 项
- ✅ M2 音乐 8/8（含 M2-2 打包验证）：omni-service onefile 38.7MB 真机产物（health/401/search 全通）+ Defender 无检出；**遗留**：国内其他杀软实测需多环境、sidecar 全家桶 ~262MB 超预算需瘦身
- ✅ M3 视频 11/11：yt-dlp 监督器/适配器（进度模板/退出码分类/pause=SIGTERM/resume 重spawn）+ ffmpeg sidecar + 格式选择器（分辨率筛选/预览卡片/仅音频）+ 合集 playlist-items 回放 + 字幕/封面/cookie + 短视频 L1/L2/L3（wm_level 回填）+ 热更器（SHA256 TOFU + 回滚）
- ✅ M4 打磨 13/17 + 🔶3 + ⏭1（可选悬浮窗）：回收站/统计页/快捷键+帮助/设置页（模板·调度·Tracker）/工具箱八件套/向导/诊断/完整性探测；🔶 Inspector layoutId、electron-updater 真机通道、三平台出包
- ⬜ 收口演示（全部人工项）：磁力 `dc9e7581…` GUI、10k 60fps、mac/Linux 清单、五平台各一次成功、B 站 1080P+cookie / YouTube 4K / 抖音快手短链、light 走查、三态走查、NSIS 出包

## 5. 关键决策与约定（不可随意更改）

1. **Electron 主进程是唯一编排者**；渲染层零引擎访问，全走 preload 白名单。
2. **参数作用域边界**（§4.2）：`listen-port/dht/lpd/max-concurrent-downloads/file-allocation` = 全局（启动参数/changeGlobalOption）；`select-file/dir/seed-ratio/max-connection-per-server/check-integrity` = 每任务（changeOption 热更）。aria2 CLI 选项名注意：是 `bt-enable-lpd` 不是 `enable-lpd`（实测踩坑）。
3. **磁力必须 `pause:true`** addUri，否则元数据到达即全量下载（§4.2）。
4. **进度事件 250ms 窗口合并**后才广播渲染层；列表虚拟滚动。
5. **状态机守卫强制**：所有状态变更走 `assertTransition`，非法转移抛 `IllegalTransitionError`。
6. **失败文案必须带出口动作**（`src/shared/errors.ts` 错误码表）。
7. **UI 反模式卡点**（§7.2）：禁 Inter/Roboto/emoji、禁纯黑 #000（用 #0B0C0E）、只动 transform/opacity、`100dvh` 禁 `h-screen`、`active:scale-[0.98]`、数字一律 mono（`.num` 类）。
8. **信任模型 TOFU**：sidecar 首启记录 SHA256 指纹（userData/fingerprints.json），之后不符即拒绝。
9. **合规红线**（§9）：不做资源站聚合；去水印仅取平台已有原始资源；音乐降级必须告警。
10. **安全基线**：contextIsolation+sandbox+nodeIntegration:false；aria2 RPC 仅绑 127.0.0.1；CSP 在 `src/renderer/index.html`。

## 6. 环境（Windows 11，PowerShell；本机无 MSVC）

- better-sqlite3 原生模块：**不要 npm 重编译**，用 prebuild：
  `cd node_modules/better-sqlite3; npx prebuild-install -r electron -t <electron版本>`
- Electron 二进制：GitHub 直连不稳，用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 或直接下载 zip 解压到 `node_modules/electron/dist/` + 写 `path.txt`（内容 `electron.exe`）
- bencode 锁定 **v2（CJS）**——v4 是 ESM-only，与主进程 CJS 产物不兼容
- electron-builder postinstall 若卡原生编译：`npm install --ignore-scripts` 后按上面两步手工补
- dev 冒烟方法：`Start-Process cmd '/c npm run dev > log 2>&1'` + 轮询日志 + `taskkill /T /F`（勿用 `Stop-Process -Name electron`，会误杀 IDE）

## 7. 验证命令

```bash
npm test                  # 39 个单测（状态机/torrent/嗅探/事件合并/搜索语法）
npm run typecheck         # tsconfig.node + tsconfig.web 双严格检查
npm run build             # 三端构建
npx tsx --tsconfig tsconfig.node.json scripts/e2e-aria2.ts   # aria2 真实端到端
npm run dev               # GUI 冒烟（看日志：aria2 online / tray created）
```

## 8. 窗口/图标/交互统一记录（2026-09-30，用户反馈驱动，三轮）

- **图标定稿（AI 生成）**：agnes-image-2.5-flash 文生图（`scripts/process-ai-icon.cjs` 后处理：裁 15% 边距 → SDF 圆角透明化 → 三份产物）。图形：多条蓝色数据流汇聚成单一箭头落入托盘（聚合下载语义），黑底圆角瓦片。原始图存 `build/icon-raw.png`
- **图标主题化（四轮）**：①界内 Logo 改为主题变量 SVG（瓦片=var(--surface-2)、描边=var(--border)、聚合箭头=var(--accent)，切主题即换色，`assets/logo.png` 不再被引用）；②托盘图标改程序化「聚合下载」单色字形（SDF 512 渲染→16/32 平滑缩放，透明底圆角字形），监听 `nativeTheme.updated` 随系统深浅色重绘（Windows 不反色模板图：深任务栏白色字形/浅任务栏近黑）；③任务栏/安装包 exe 图标为静态 AI 黑瓦片（OS 级无法动态）；④`resources/icon.png` 保留作打包 fallback
- **透明窗白屏根因**：`transparent:true` 在 Windows 上（叠加 backdrop-filter）导致白屏/透底 → 改回不透明 `backgroundColor` + Win11 DWM 圆角；主题切换经 `ui:theme` 同步 `setBackgroundColor`
- **七主题体系**（theme.ts + tokens.css）：随系统（matchMedia）/ 石墨灰（浅）/ 曜石黑（深）/ 暗夜紫 / 青墨绿 / 琥珀橙 / 科技蓝（三字命名）；旧 oled 值兼容映射到 dark；侧栏「主题」按钮弹层选择（色板预览）+ 设置页「外观」分区卡片选择
- **⚠ 关键坑（主题全黑根因）**：`main.tsx` 用 `'../styles/...'` 相对导入解析到了重构前的遗留目录 `src/renderer/styles/`（旧 tokens 只有 dark/light）——新增主题规则从未被加载，暗色系全透明变黑屏。已改 `'./styles/...'` 并删除旧目录。诊断方法：`scripts/cdp-probe.cjs`（CDP 查编译后 CSS 规则/变量解析）+ `scripts/cdp-shot.cjs`（CDP 截图），dev 需带 `--remote-debugging-port=9222`

- **图标二轮**：科技黑色调重画——近黑渐变底（#21242B→#0A0B0D）+ 电蓝图形，同一 gen-icon.cjs 产出三份；三轮定稿为「聚合下载」语义：三条来源支流（左/右斜线 + 中路竖线，线段 SDF）汇入单一主箭头 → 三角头部 → 托盘底线
- **顶栏拖拽修复**：glass-panel 的 backdrop-filter 会破坏 -webkit-app-region 拖拽 → 玻璃效果移到 pointer-events-none 装饰底层，顶栏整条可拖（速度显示区也纳入），仅搜索框/按钮 no-drag
- **三主题**：dark 科技黑 / oled 纯黑（新增，tokens.css `data-theme='oled'`）/ light 浅色，侧栏按钮循环切换
- **统计页**：修复 ipc snake_case→camelCase 未映射（NaN/空根因）；新增「库实时总览」（任务总数/进行中/累计已下载，不依赖完成记录）+ 空数据引导；柱状图改 CSS 列布局（h-28 限高、数量常显、悬浮详情）
- **提示文案全面中文化（2026-09-30）**：用户可见错误/通知一律「中文 + 关键代码标识」——清扫主进程全部 throw 点（ipc『task manager not ready』×6、『only ytdlp updates supported』、manager『task not found』、aria2 RPC 六处、omni-service 三处、yt-dlp 超时、ports、torrent『invalid torrent』、toolbox『unknown tool/ffmpeg exit』、music HTTP 错误、updater 四处）；状态机 IllegalTransitionError 文案中文化；内部日志（log.error）保留技术格式；引擎原生英文 stderr 由 diagnosis.ts 五类归因转中文。⚠ 打包注意：主进程禁用运行时 `require('./xxx')`（Rollup 不重写 → MODULE_NOT_FOUND，defaultSaveDir 曾踩坑），一律顶层静态 import
- **打包矩阵扩展（用户口径）**：win = nsis + zip(portable) + msi（x64）；mac = dmg ×（x64/arm64/universal）；linux = AppImage + deb。CI 打包后重命名（版本号取自 package.json）：`OmniGet_{v}_x64-setup.exe / {v}_x64_portable.zip / {v}_x64_zh-CN.msi / {v}_x64.dmg / {v}_aarch64.dmg / {v}_universal.dmg / {v}_x64.AppImage / {v}_x64.deb`；win 的 .exe.blockmap 在 CI 丢弃（electron-updater 差量下载自动回退整包）。⚠ electron-builder 25 schema：`signAndEditExecutable` 只在 win 级（nsis 级会校验失败）；zip 无选项块；msi 本地受 winCodeSign 软链特权限制、CI 管理员环境可构建；mac/linux 包缺对应平台 sidecar 时 CI 有告警（引擎降级提示）
- **底栏引擎灯**：aria2 红/绿；ytdlp·music 按需拉起，离线=待机灰（不再常红）
- **工具箱分类**：ToolDef.category（audio/video/common），分组标题+卡片（名称/概述/处理按钮），ipc 透传 category+desc
- 新建任务按钮浅底（accent-soft）；空态 CTA 美化（主色胶囊+Plus 图标）
- **按钮响应审查（2026-09-30）**：全 UI 按钮逐个核对接线——修复三处死点：①顶栏搜索框（原来纯摆设）→ query state 贯通 TaskList 过滤（name/source 含匹配）+ 清除按钮 + 「无匹配」态；②任务行「置顶」（manager 里是 no-op 桩）→ 改 renderer togglePin（settings `ui.pinnedTasks` 持久化，列表置顶优先排序，行内常显图钉标记，RowAction 加 stopPropagation 防误选行）；③操作失败静默 → ipc task:control/retry 失败经 broadcastNotices + App 全局 toast（右下角 3.5s，warning 黄/info 白）
- **视图滚动修复**：所有 feature 根 `<main>` 缺 `h-full`（App 工作区 overflow-hidden 裁掉内容且无滚动条）→ 六视图统一补 `h-full`；工具箱标题 font-semibold
- **下载加速（2026-09-30，用户反馈"下载很慢"）**：①Tracker 订阅源 1→4（ngosang best/all + XIU2 best/all，allSettled 部分失败容错，每源上限 120 去重合并），实测 4/4 源 283 条（原 20 条）；②注入覆盖运行中任务（changeGlobalOption 后对 running/queued 逐个 changeOption bt-tracker，manager.injectTrackersToRunning + adapter.changeOption 公开）；③BT：`bt-request-peer-speed-limit: 10M`（速度不足时 aria2 主动提高 peer 换手）；DHT 路由表持久化（`dht-file-path(6)` → userData/dht.dat，冷启动免重新引导）；④HTTP：`min-split-size` 全局 1M（默认 20M 分片太少并行不足）；**修正 max-connection-per-server 钳制 1–16**（aria2 硬限制，原传 64 会被拒）
- **音乐任务取消（端到端）**：omni-service 新增 `POST /api/music/task/{id}/cancel`（标记 cancelling；引擎线程为阻塞库调用无法强杀，完成后由服务端删除 mp3/lrc 产物，广播 done.cancelled=true）；MusicAdapter.cancel；manager remove music → cancel(gid)；applyMusicEvent 处理 cancelled → failed「任务已取消」。**sidecar 已重打并更新**（39.2MB）；端点单测 `scripts/test-cancel-endpoint.py`（404/标记/幂等/401）
- **⚠ TOFU 指纹复活坑**：替换 sidecar 后删 data/fingerprints.json 会被 env 迁移逻辑从旧 %APPDATA% 目录复活（带回旧哈希 → 永远 TAMPERED）。已修：迁移跳过 fingerprints.json（TOFU 信任锚定安装身份）；手动刷新指纹 = 改 data/fingerprints.json 对应条目为新文件 SHA256
- **主题色板三轮**：对角双拼被反馈为「残缺半圆」→ 定稿为「空心环/选中实心」双色球（边框恒为主题色，选中才填充）；设置默认打开外观 tab；向导外观步骤同步全套七主题（色球同规则，点击即时预览，完成后持久化）
- **⚠ 测试隔离坑**：node:test 单进程跑全部测试文件，env.userDataDir 若缓存路径会无视后加载文件的 `OMNIGET_TEST_DATA_DIR` → 测试打真实库（UNIQUE 冲突/信号量计数污染）。修复：env 变量最高优先且不缓存
- **诊断工具沉淀**（scripts/，dev 需 --remote-debugging-port=9222）：cdp-eval（页面内求值）/ cdp-shot（截图）/ cdp-nav-shot（点导航截图）/ cdp-wizard+cdp-onboard（向导步进）/ cdp-onboard-verify（向导原子断言）。注意向导标记 settingsSet 须传布尔（字符串会被双重序列化成真值）
- **⚠ 虚拟滚动 + CSS 动画坑**：`.stagger-in` 的 transform 动画（fill forwards）会覆盖行容器内联 `translateY(vi.start)` → 所有行叠顶。stagger 必须放内层包裹 div，外层只做定位
- **⚠ 回收站数据源坑（严重）**：store.tasks 是「最后一次 load(filter)」的内容；在回收站视图里被其他组件 `load('all')` 覆盖后，`FILTERS.trash=()=>true` 会把全部任务当回收站渲染 → 一键清空误删正在下载的任务。修复三层：①store 记录 `loadedFilter`，TaskList 校验 `loadedFilter==='trash'` 否则骨架+自动重载；②批量/清空操作前置守卫；③主进程 `task:purge`/`task:purgeRecord` 校验 `isTrashed`（非回收站任务拒绝 purge）
- **快捷键可自定义（shortcuts.ts）**：默认表 + 用户覆盖（settings `ui.keymap`，只存差异项）；设置新增「快捷键」tab（位于下载前）：点击键位胶囊录制新组合（eventToKey 归一化，Esc 取消，冲突拒绝），恢复默认；App keydown 按 effectiveKeys 匹配，`keymap-changed` 事件刷新；侧栏「快捷键」入口移除（帮助浮层 Ctrl+/ 与设置内入口保留）
- **目录浏览**：`app:pickFolder` IPC（dialog.showOpenDialog openDirectory）→ 设置·下载 + 向导第一步的「浏览」按钮
- **顶栏按钮"看不见"双因修复**：①header flex 无收缩约束——搜索 wrapper `flex-1` 无 min-w-0 会把「新建任务」胶囊推出圆角裁切区（宽窗口 1280 时 x=1071 贴边、窄窗口直接裁没）→ 全链 min-w-0/shrink-0；②暗色下 accent-soft 胶囊对比度过低 → 改主色实底白字。**⚠ pill 的 shrink-0 在会话中途曾丢失（文件漂移）导致用户侧仍不可见——修复后必须整屏 OS 截图（CopyFromScreen）实证，CDP hit-test 只能证明"可命中"不能证明"可见"**
- **⚠ 剪贴板监听自动弹对话框会盖住整个 UI**（bg-black/50 遮罩）——CDP 截图"整屏变暗/按钮点不到"先排查是否有挂着的 NewTaskDialog（elementFromPoint 取证）
- **dev 窗口/任务栏图标**：BrowserWindow `icon: runtimeBase()/resources/icon.png`（打包态 exe 内嵌接管）
- 侧栏「种子磁力」图标换 Magnet（与「下载中」DownloadSimple 区分）
- **回收站批量操作**：视图内行首复选框 + 全选 + 批量恢复/彻底删除（按选中数）+ 一键清空；批量=循环现有 restore/purge IPC（数据量小无需新通道）
- **文件分类（shared/file-category.ts）**：按扩展名分 视频/音乐/图片/文档/其他；Inspector 文件清单与新建任务对话框顶部各有一排分类 chips（含计数、零分类隐藏）；对话框内 chips 过滤文件树（重建聚合大小），全选/反选只作用于当前过滤集 → 「按分类筛选 → 全选」即按类批量勾选
- **回收站行操作语义重排**：恢复（回主列表）/ 彻底删除·含文件（purge + 精确删文件）/ **删除·保留文件**（新通道 `task:purgeRecord` 仅删记录）/ 打开目录；移除回收站内误显示的「移入回收站」；普通视图操作不变
- **任务生命周期审查修复（2026-09-30）**：①control remove 按引擎分派（music 此前误走 aria2.remove 报错删不掉 → 仅解除 gid；tool → toolbox.cancel 杀 ffmpeg，ToolboxRunner 进程表 + taskId 贯通事件流）；②restoreFromTrash 幽灵态（恢复后 status=running 但引擎任务已移除）→ 归位 queued + 立即 recoverEngineTasks/pumpMusic；③retryTask 音乐失败重试卡 queued → pumpMusic；④createTask 入参校验（saveDir 空、threads 1-64 钳制）；⑤task:restore/purge/purgeRecord 失败广播通知（此前静默）。遗留（记录不修）：music 服务无取消端点（删除后服务侧自然结束）；tool cancel 后产物半成品不清理
- **便携数据目录（2026-09-30）**：配置/历史数据统一放 `<运行目录>/data/`（db/日志/TOFU 指纹/DHT 缓存/元数据）——env.ts `userDataDir()` 重写：打包态基目录=exe 所在目录、dev=项目根；写入探测失败（如 Program Files 只读）回退系统 userData 并告警；首启一次性迁移旧 %APPDATA% 数据（omniget.db/fingerprints/dht.dat，目标缺失才拷贝）；`data/` 已加 .gitignore。**下载目录**：设置页可配（download.saveDir），`defaultSaveDir` IPC 现在优先读该配置、留空回退系统 Downloads（此前配置被无视的 bug 已修）

- **统一应用图标**：`scripts/gen-icon.cjs`（完整 Electron 无窗运行，ELECTRON_RUN_AS_NODE 下无 nativeImage）程序化绘制 2048² 超采样 → 圆角矩形（半径 23%）+ 电蓝渐变 + 白色下载箭头，输出 build/icon.png(512, 打包自动转 ico/icns) / resources/icon.png(128, 托盘+extraResources) / src/renderer/src/assets/logo.png(界面左上角)。托盘优先加载统一图标，缺席回退单色模板绘制图
- **圆角无边框窗口**：frame:false + transparent:true + 渲染层 `fixed inset-0 rounded-[10px] border` 外壳（同时根治底部空白——不再依赖 dvh 高度链）；body 背景透明
- **自绘窗口控件**：最小化/最大化切换/关闭（win:minimize/maximize/close IPC + win:state 回推），关闭走托盘拦截
- **拖拽**：顶栏 + Logo 行 `-webkit-app-region: drag`（frameless 后全顶栏可拖），交互元素 no-drag
- **图标按钮规范**：IconButton/Tooltip 组件（ui/IconButton.tsx，纯 CSS hover 提示，`--tooltip-bg` 双主题）；顶栏新建任务等改为图标-only；去除 Ctrl F / Ctrl N 内联快捷键提示（帮助浮层仍可查）
- vite/client reference 供 png 导入类型

### 8.1 托盘强化（同日，先于 8 顶部条目）

- 图标空白根因：原为 1x1 透明 PNG 占位 → 现优先加载统一图标（见上），回退为程序化 BGRA 单色模板绘制图
- 左键切换主窗显隐；右键菜单：速度表头、显示主界面、新建任务…、全部暂停/继续（forcePauseAll/unpauseAll，setBulkControlHandlers 注入）、剪贴板监听 checkbox（`ui.clipboardWatch` 持久化 `'true'/'false'`，默认开）、开机自启 checkbox、退出（app.quit()）
- 菜单每次右键现场构建；tooltip 2s 刷新
- 修 Tracker 注入竞态：刷新与注入分离，注入统一在 aria2 onOnline 后兜底

### 8.2 UI 二轮（部分已被本节顶部取代）

- **去原生菜单栏**：`Menu.setApplicationMenu(null)`
- ~~标题栏主题化：Windows `titleBarOverlay`~~ → 已被 frameless 圆角窗口 + 自绘控件取代
- 顶栏拖拽区：`titlebar-drag/no-drag` 工具类（global.css）
- 侧边栏 200px：nav 区 `flex-1 overflow-y-auto` + 底部组 `shrink-0 border-t`
- ~~底部空白：`100dvh` 三层~~ → 已被 `fixed inset-0` 外壳根治
- 设置页分区 / 工具箱说明：见对应 feature

## 9. 已知待办 / 坑
- Sidecar 全家桶 ~262MB（ffmpeg 100+100 未精简、yt-dlp 17、omni-service 39、aria2 5.4）——发布前需瘦身/压缩评估
- Windows 冒烟清理命令（Stop-Process/taskkill）需审批，脚本化时注意
- 音乐进度为阶段文案（引擎无字节回调）；试听依赖第三方镜像可用性（断流有黄条兜底）
- 收口演示项：磁力 `dc9e7581…` GUI 全链路、10k 60fps、mac/Linux 清单、五平台各一次成功
- Windows 冒烟清理命令（Stop-Process/taskkill）需审批，脚本化时注意

## 9. 审查与修复记录

**音乐链路 + 日志专项（2026-10-01 下午，用户反馈"牡丹亭 fetch failed"）**：typecheck 双端 + 39/39 单测。修复——
1. **P1 下载/试听全链必败根因**：`downloadNeteaseAudio` 镜像 fetcher 无 try/catch——第一个镜像（cenguigui）不可达即 `fetch failed` 整任务失败，后 3 个镜像永不尝试；试听只走 haitangw 单镜像。修复：下载/试听均改四镜像（cenguigui→haitangw→rrvenn→toubiec）逐个容错回退 + 逐镜像日志
2. **P1 GIF/图片预览被 CSP 拦截**：img-src 无 `omniget-preview:`（文本预览 fetch 同被 connect-src 拦）→ CSP 补齐。⚠ 剪辑编辑器波形解码 fetch 此前也一直被 connect-src 静默拦截（降级纯时间轴），一并修复
3. **P1 「打开目录」无反应**：preload 未重启时新桥方法缺失 → 同步 TypeError 被 void 吞掉；渲染层防御（桥缺失提示重启 + catch toastError）
4. **P2 错误中文化（http.ts humanizeNetworkError）**：undici 顶层 'fetch failed' 按 cause 链 errno 归因（ENOTFOUND/ECONNRESET/ETIMEDOUT/TLS 证书等 18 种）→ 中文 + 出口动作；fetchJson/getText/openStream 全部接入，HTTP ${status} → 「接口异常（HTTP xxx）」；toolbox fs 错误（ENOENT/EACCES/ENOSPC/EBUSY）中文化
5. **日志专项（子代理全量排查 11 处静默 catch）**：P1×4——TOFU 指纹库损坏当空库=静默重置信任基线（区分 ENOENT/损坏）、yt-dlp 更新备份/回滚失败静默、旧数据迁移失败静默（env.ts 用 console.error，logger 未初始化）；P2×3——QQ/酷狗/咪咕/汽水平台直链失败逐个 cb.log、引擎自动补齐链外层兜底、purge 删用户文件失败；P3×4——tracker 注入、歌词接口、应用更新检查、适配脚本热更加载。music-engine 的 console.log 换 createLogger('music-engine')，下载成功/失败、搜索平台降级均留痕
6. **处理动态按工具隔离（用户反馈：一个工具处理完切别的工具记录还在）**：ToolboxPage 处理动态改按 activeTool 过滤（剪辑页附带隐藏工具 region-concat 的合并任务）；后台事件流继续记录，切回仍可见；加「清空记录」按钮（仅清当前工具）

**工具箱专项审查（2026-10-01）**：逐工具过 24 个 ToolDef + Runner，typecheck 双端通过 + 39/39 单测。修复——
1. **P1 node 任务取消误删历史产物**：nodeTasks 登记 output 初值为 outDir → cancel `rm(recursive)` 会删整个 `工具箱输出/<工具名>/`；改 output='' 只删真实产物，compute 后取消则删刚产出物再报「任务已取消」
2. **P1 build 抛错无 failed 事件**：region-concat 空区域等 build 阶段异常此前不广播 ToolEvent（工具箱页处理动态无记录）；包 try/catch 补发
3. **P2 gif 参数注入**：from/duration/width 原样拼 args/vf 链 → 数值钳制白名单（width 64–1920）
4. **P2 demucs 任意二进制执行**：demucsPath 来自渲染层 → basename 白名单 `demucs(.exe)`
5. **P2 容器兼容**：video-mute 直拷 webm/mkv 源装 mp4 必败 → 容器跟随；rotate/scale/subtitles-burn 非 mp4 系源音轨 `-c:a copy` 改 AAC
6. P3：cancel 事件 tool 字段误填 taskId（改记真实工具名，进度行能显示工具 label）；ffmpeg 非零退出带 stderr 尾行、kill 后报「任务已取消」；trim/clip/frame 产物名 Math.round 碰撞改 0.1s 精度；convert 对 flac/wav 不再传 -b:a、bitrate 白名单
7. **工具产物预览 + 打开目录**（新功能）：①`tool:reveal` IPC（showItemInFolder + 存在性校验 + 失败广播通知）；②preview://local 白名单扩展图片/文本类型；③工具箱「处理动态」完成行加 预览（Eye）/打开目录（FolderOpen）按钮 + 预览弹层（图片/视频/音频流播、文本读 64KB、Esc/遮罩关闭、媒体不支持时引导开目录）；④manager 完成时 saveDir 归位产物目录（任务列表「打开目录」直达），store.updateTaskFields 补 saveDir 字段

**三轮全面审查（2026-10-01）**：typecheck 双端通过 + 39/39 单测。P1×7 / P2×12 / P3×14 全修——

主进程：
1. **P1 覆盖风险**：`--allow-overwrite` 从全局启动参数收窄为每任务选项（默认 false），仅增量补下（re-add）显式放行；"File already exists" 归一为中文带出口动作提示
2. **P1 增量补下**：confirmSelection re-add 改经 `selectionFor()`（此前只传 paths，.torrent 任务 select-file 永不注入 → 全量重下）
3. **P1 删除承诺**：yt-dlp 单视频完成时产物落 task_files（persistYtdlpProduct）；音乐 mp3/lrc 落 task_files——回收站「删除（含文件）」对 video/music 不再落空
4. **P2 settingsSet 白名单**：渲染层可写键白名单 + `engines.mirror` 强制 https（堵供应链投毒通道）；bridge.token/schedule.rules 主进程独占
5. **P2 并发闸门**：`launching` Set 计入在途启动（DB 状态滞后不再穿透 maxConcurrent）；同任务并发 re-add 拦截；跨 await 后统一重读复核（recover/retry/runWhenQueued/pause-music）
6. **P2 幽灵事件**：applyEngineEvents 跳过回收站/已删任务；pushEvent 终态不再写入速度快照表（Map 泄漏）
7. **P2 before-quit**：preventDefault + await supervisor.shutdown（RPC 限时 2s）→ taskkill 兜底必达；app:update 通道改走 electron-updater（此前误调 yt-dlp 引擎热更）
8. **P2 TOFU**：ensureVerified 缓存加首尾 64KB 内容短指纹；yt-dlp parse（-J）路径强制过闸门
9. **P2 parseFile**：USERPROFILE 整目录黑名单改为系统目录+高敏子目录（Downloads 主用例恢复可用）
10. **P2 音乐暂停竞态**：POST 返回后补偿检查任务状态，已取消则立即 cancel 引擎任务
11. **P2 工具箱**：node 任务额度移交修正 + nodeTasks 登记支持取消
12. P3：磁力元数据临时目录清理、RPC secret 改 --rpc-secret-file、WS 重建前摘除旧监听、send 竞态兜底、上传速度接 getGlobalStat、setTaskFileSelection 原子化、saveTaskFiles downloaded 落库、scheduler apply 加 catch、tracker 订阅源过滤逗号/空白、torrent 解析路径过 sanitize、bridge readBody 超限必 settle、preview://local 挡敏感目录、剪贴板/协议唤起去重键改完整文本

渲染层：
1. **P1 批量操作**：回收站恢复/彻底删除/清空统一 runBatch（try/finally + 逐项容错 + 失败 toast）——busy 不再永久卡死
2. **P1 假成功**：音乐下载成功提示移入 try 内；失败 toastError
3. **P1 静默失败**：TaskList 全部行操作/Inspector/App 快捷键统一 guarded/toastError 包装
4. **UX 标准 2 补齐**：deletePreset、resetAll（恢复默认键位）加 confirmAction 二次确认
5. P2：回收站行禁止打开 Inspector；批量/ID 入队防重入；试听 seq 竞态守卫 + 离开页面停止 Audio；设置页主题与侧栏经 `app:theme-changed` 事件同步；队列/归档分区独立保存按钮；初始化 IIFE 加 catch；全不选提交拦截（渲染层禁用 + 主进程兜底）；音乐页黄条与全局 toast 去重（页内订阅移除）
6. P3：TaskRow memo（10k jank）、快捷键监听经 ref 中转防每批重挂、回收站行内操作重载 'trash' 防双载闪烁、checked 残留清理、footer 假上传速度移除、toast success 视觉区分、i18n 补 settings.tab.remote、HelpOverlay 读实际键位、命名模板预览支持 {{date}}/{{index:N}}、拖拽文件 .torrent 类型校验、批量汇总含失败时改警示配色、状态栏非任务视图不发 listTasks

遗留（记录不修）：task:purge 与 restore 的 TOCTOU 窗口极小未做原子化；音乐引擎 abort 后 rename 的极低概率半成品文件；剪贴板自动弹窗未区分链接类型（需产品决策是否加设置项）。

**M1 一轮（2026-09-29）**：P1×3/P2×8/P3×9 全修（详见任务计划文档）。

**M2 二轮（2026-09-30）**：P2×4/P3×7 全修——
1. 服务重启恢复：`onMusicEngineOffline` 清信号量；`onMusicEngineOnline` 清 queued 任务失效 gid 后重泵（B1）
2. 试听：`GET /api/music/preview` 服务端流式代理镜像音频（`<audio>` 经 16801 播放，符合 CSP media-src），镜像断流静默容错 + 客户端黄条
3. 用 ID 精确下载：工作台入口 → `MusicDownloadInput.neteaseId` → `/download-by-id`（§4.4 兜底闭环）
4. TLS 策略化：`session.verify=True` 默认，仅 `VERIFY_DISABLED_HOSTS`（第三方镜像域）豁免，官方域不豁免
5. search 移临时目录（不再污染 cwd）；WS 改首帧鉴权（token 不进 URL）；FastAPI lifespan；回环限流 30 req/5s；音乐阶段文案 + 完成后文件名回填；缺省 saveDir = 系统 Downloads
6. **新测试抓出 P1**：`store.rowToTask` 漏映射 `engine_gid` → WS 事件永不命中任务（生产级 bug）；已修复并加信号量并发回归（6 任务峰值 4 并发、done 补位）

- **图标体系**：全局 Phosphor（`@phosphor-icons/react`，size 13–20，active 态用 `weight="fill"`），彻底移除 ✕/▾/‖ 等文本字形；注意 Phosphor 无 `Film`，视频用 `MonitorPlay`
- **侧边导航**：LogoMark SVG（下载箭头托盘隐喻）+ 图标/文字双层导航 + 2px accent 指示条（`.nav-rail`）+ 下载中计数徽标 + 底部主题切换（Sun/Moon，持久化 `ui.theme`）
- **玻璃顶栏**：搜索（含 kbd 提示，Ctrl+F 聚焦）+ SVG 迷你速度曲线（`SpeedSparkline`，store 滚动窗口 40 帧，§7.8 三处永续动效之三）+ 主按钮带 kbd
- **任务列表**：sticky 分组头（标题+计数）、行三段式（状态图标/引擎徽标/3px scaleX 进度条）、hover 浮出 4 个图标操作、首载 stagger `--i*40ms` 仅前 10 行
- **三态齐备**：骨架屏 shimmer（`skeleton-line`，同形 3 段）、构成式空态插画（`EmptyState` SVG 托盘隐喻 + float ±4px）、错误行内红字
- **对话框**：framer-motion `AnimatePresence` + spring(100,20) scale 0.96→1；雷达动画（`radar-ring`，三处之二）；range 滑杆 accent 化（`--fill` 变量）；分区化布局
- **Token 扩展**：`--accent-soft`（激活底色）、`--shadow-float/--shadow-pop`（随主题的色调化阴影，禁纯黑投影）

## 9. 审查与修复记录（2026-09-29 全量修复完成）

首轮全面审查发现 P1×3 / P2×8 / P3×9 问题，已全部修复：

- **P1**：metadata `.torrent` 混入文件树（过滤条件恒真）；磁力任务恢复裸 addUri 直下全量；parsing 中断任务被恢复成直下
- **P2**：托盘退出改 app.quit()（原 app.exit() 跳过 before-quit 致 aria2c 孤儿）；WS 断开自愈（onClose→scheduleRestart，重启前先杀残留进程释放端口）；删除任务只删 task_files 记录文件（原 rm 整个 saveDir）；infohash 查重过滤回收站；文件树改相对路径（§5）；磁力元数据落临时目录；dev CSP 放行 ws://；文件名 sanitize（`shared/sanitize.ts`，parseHttp/parseTorrent/statusToFiles 统一接入）；HEAD 探测 10s 超时；标题栏按平台区分
- **P3**：resume 先引擎后状态；catch 内转移守卫；completed 任务勾选 = §4.5 增量补下（re-add + 秒校验）；对话框「选择 .torrent」+ 拖拽（webUtils 桥，Electron 32+ 无 File.path）；BT 滑杆显示 peers 上限语义；下完即停勾选 + seedRatio 落库；单任务重试 retryTask；默认目录读系统 Downloads

**测试基建**：`npm test` 现经 `scripts/run-tests.js` 用 **Electron-as-Node** 跑（better-sqlite3 是 Electron ABI，纯 Node 无法加载）；Electron 内置 Node 20 的 --test 不展开 glob，运行器自行递归收集 `src/main/**/*.test.ts`。32/32 通过（新增 sanitize 7 例 + store/DB 层 5 例）。
