// ── 任务模型（设计文档 §4.1）─────────────────────────────────────────

export type TaskType = 'bt' | 'magnet' | 'video' | 'music' | 'http' | 'tool'

export type TaskStatus =
  | 'parsing'
  | 'awaiting'
  | 'queued'
  | 'running'
  | 'paused'
  | 'verifying'
  | 'seeding'
  | 'completed'
  | 'failed'

export interface Task {
  id: string
  type: TaskType
  source: string
  name: string
  engine: 'aria2' | 'ytdlp' | 'nm3u8' | 'music' | 'tool'
  status: TaskStatus
  saveDir: string
  totalBytes: number
  downloadedBytes: number
  speedBps: number
  threads: number
  noWatermark?: boolean
  seedRatio?: number // BT 做种比例（0=下完即停，§4.2）
  quality?: 'standard' | 'high' | 'lossless' // 音乐音质（§5 quality 列）
  engineGid?: string // aria2 gid / yt-dlp pid / music task id（§5 engine_gid）
  /** §5 params 列（JSON）：引擎扩展参数（如 video playlist 标记） */
  params?: string
  createdAt: number
  error?: string
}

export interface TaskFile {
  path: string
  size: number
  selected: boolean
  downloaded: number
}

// ── 引擎健康（§6.1 event:engines）────────────────────────────────────

export type EngineName = 'aria2' | 'ytdlp' | 'nm3u8' | 'music' | 'tool'

export interface EngineHealth {
  name: EngineName
  online: boolean
  detail?: string
}

// ── 解析结果（文件树 / 格式列表）──────────────────────────────────────

export interface ParsedFileNode {
  path: string
  size: number
  children?: ParsedFileNode[]
}

export interface VideoFormat {
  formatId: string
  resolution: string
  ext: string
  fps?: number
  vcodec?: string
  acodec?: string
  tbr?: number
  filesize?: number
  noWatermark?: boolean
}

export interface ParsedResource {
  kind: 'torrent' | 'magnet' | 'video' | 'playlist' | 'http' | 'music'
  name: string
  totalBytes: number
  files?: TaskFile[]
  formats?: VideoFormat[]
  coverUrl?: string
  duration?: number
  infohash?: string
  magnet?: string
}

// ── IPC 通道载荷（§6.1 白名单）───────────────────────────────────────

export interface CreateTaskInput {
  source: string
  threads: number
  saveDir: string
  noWatermark?: boolean
  seedRatio?: number
  /** R7 P1：单任务限速（aria2 格式：2M / 500K / 字节数；缺省不限） */
  speedLimit?: string
}

export interface ConfirmSelectionInput {
  taskId: string
  selectedPaths?: string[]
  formatId?: string
  threads: number
  /** M3-5/10/7：视频任务确认时的附加参数（M1-11 恢复后丢失，接受默认值） */
  video?: {
    formatId?: string
    embedSubs?: boolean
    embedThumbnail?: boolean
    /** M3-10 仅提取音频 */
    audioOnly?: boolean
    audioFormat?: 'mp3' | 'm4a' | 'opus'
    /** M3-7 短视频 L3 显式选择：delogo 后处理产出 _nowm 副本 */
    delogo?: boolean
    /** R4 续（backlog #4）：任务级命名模板（预设携带），留空回落全局 naming.template */
    template?: string
    /** R7 续（backlog #21）：SponsorBlock 广告段标记为章节（YouTube） */
    sponsorBlock?: boolean
    /** 一期 0.8.0（backlog #21 待办）：SponsorBlock 跳过赞助/广告段（YouTube；ffmpeg 剪辑依赖） */
    sponsorBlockRemove?: boolean
    /** R7 续（backlog #20）：直播录制时长（分钟；仅 RE 引擎的直播流任务） */
    liveRecordMinutes?: number
    /** backlog #27（2026-10-03）：内嵌元数据与章节（--embed-metadata --embed-chapters） */
    embedMetadata?: boolean
    /** 三期（backlog #23）：B站弹幕压制（完成时取公开弹幕 XML→ASS→ffmpeg 烧录） */
    danmaku?: boolean
  }
}

export interface ControlTaskInput {
  taskId: string
  action: 'pause' | 'resume' | 'remove' | 'top'
  withFiles?: boolean
}

export interface MusicSearchInput {
  q: string
}

export interface MusicDownloadInput {
  artist?: string
  song?: string
  /** 自然语言整行（'陈奕迅的孤勇者'），服务端同源解析（M2-8 批量导入用） */
  q?: string
  /** F1：网易云歌曲 ID 精确下载（降级兜底通道，走 download-by-id） */
  neteaseId?: string
  quality: 'standard' | 'high' | 'lossless'
  saveDir?: string
}

export interface MusicCandidate {
  platform: string
  platformLabel: string
  id: string
  name: string
  artist: string
  artistMatch: boolean
  originality: number
  /** R6：时长（毫秒，平台有值才带）——搜索列表展示用 */
  durationMs?: number
  /** R6：专辑名（平台有值才带） */
  album?: string
}

export interface MusicSearchResult {
  query: string
  parsed: { artist: string; song: string }
  candidates: MusicCandidate[]
  /** 搜索降级平台（UI 黄条，§4.4） */
  degraded: string[]
}

// ── 二期（0.9.x 音乐纵深）：歌单/专辑批量 + 音乐库 ────────────────────

/** 歌单/专辑曲目（网易云公开 API 解析） */
export interface MusicPlaylistTrack {
  id: string
  name: string
  artist: string
  album: string
}

export interface MusicPlaylistInfo {
  kind: 'playlist' | 'album'
  id: string
  name: string
  tracks: MusicPlaylistTrack[]
  /** 曲目总数——超过 tracks.length 说明发生截断（UI 必须显式提示） */
  total?: number
}

/** 音乐库曲目（music.done 完成即登记） */
export interface MusicLibraryTrack {
  id: string
  taskId: string | null
  path: string
  lrcPath: string | null
  title: string
  artist: string | null
  album: string | null
  quality: string | null
  source: string | null
  size: number
  /** 四期：磁盘文件缺失（被移动/删除）——条目可见但禁播放/补标签 */
  exists: boolean
  createdAt: number
}

/** MusicBrainz 一键补标签结果 */
export interface MusicRetagResult {
  title: string
  artist?: string
  album?: string
  date?: string
}

/** 音乐引擎事件（§6.3；内嵌引擎直发，形状与原 omni-service WS 一致） */
export interface ServiceEvent {
  type: 'music.progress' | 'music.done' | 'music.warning'
  taskId: string // 音乐引擎任务 id
  platform?: string
  platformLabel?: string
  message?: string
  success?: boolean
  /** music.done 取消标记（真取消：AbortSignal 中断后产物已清理） */
  cancelled?: boolean
  source?: string
  mp3Path?: string
  lrcPath?: string
  /** 二期：专辑名（平台有值才带）——音乐库登记与 {{album}} 归档模板数据源 */
  album?: string
  bytes?: number
}

/** 主进程 → 渲染层通知（降级黄条等） */
export interface UiNotice {
  level: 'warning' | 'info'
  message: string
  taskId?: string
}

export interface ToolCreateInput {
  tool: string
  sourcePath: string
  params: Record<string, unknown>
  saveDir?: string
}

/** M4-13 工具箱事件（tool 前端页消费） */
export interface ToolEvent {
  taskId: string
  tool: string
  status: 'running' | 'progress' | 'completed' | 'failed'
  message?: string
  bytes?: number
  /** progress：已处理秒数（time= 采样） */
  seconds?: number
}

/** 工具定义（渲染层表单渲染用） */
export interface ToolDefInfo {
  id: string
  label: string
  /** 分类：audio 音频 / video 视频 / common 通用 */
  category?: 'audio' | 'video' | 'common'
  desc?: string
  fields: Array<{ key: string; label: string; type: string; options?: string[]; default?: string }>
  /** T4：多文件输入（文件顺序 = 处理顺序，如拼接） */
  multi?: boolean
  /** T4：附加文件选择器（如字幕文件），路径经 params[key] 传入 build */
  extraFile?: { key: string; label: string; accept: string }
}

/** M4-4 统计页数据 */
export interface DailyStat {
  day: string
  completedCount: number
  completedBytes: number
  peakSpeedBps: number
}

/** M4-15 调度规则 */
export interface ScheduleRule {
  from: string
  to: string
  limit: string
}

/** M4-16 Tracker 条目 */
export interface TrackerEntry {
  url: string
  lastOkAt: number | null
  source: string
}

/** M4-17 诊断结果 */
export interface TaskDiagnosis {
  kind: string
  message: string
  exitAction: string
}

export interface TaskEvent {
  taskId: string
  status?: TaskStatus
  /** 审查修复：任务已删除（软删/物理删）——渲染层据此从列表移除条目并刷新计数 */
  removed?: boolean
  downloadedBytes?: number
  totalBytes?: number
  speedBps?: number
  error?: string
  /** F2：阶段文案（音乐任务无字节进度，用引擎阶段文本替代） */
  message?: string
  /** M3-6：实际去水印级别回填（direct|fallback|post，§4.3.1） */
  wmLevel?: string
  files?: { path: string; downloaded: number }[]
}

export interface ParseOutputPayload {
  name: string
  totalBytes: number
  files?: { path: string; size: number; selected?: boolean; downloaded?: number }[]
  formats?: VideoFormat[]
  infohash?: string
  magnet?: string
  /** M3-11：封面缩略图 / 时长（防下错预览） */
  coverUrl?: string
  duration?: number
  /** M3-2：ffmpeg 缺失 → 仅预合并格式 */
  ffmpegMissing?: boolean
  /** 合集标记 */
  playlist?: boolean
  /** 磁力暂停态 gid：确认勾选时 changeOption+unpause */
  pendingGid?: string
  /** R7 续（backlog #20）：HLS 直播流（media 清单无 #EXT-X-ENDLIST），对话框显示录制时长 */
  live?: boolean
}

export interface CreateTaskResultAwaiting {
  kind: 'awaiting'
  taskId: string
  parsed: ParseOutputPayload
  sniff: { type: TaskType; source: string; noWatermark?: boolean; platform?: string }
}

export interface CreateTaskResultFailed {
  kind: 'failed'
  error: string
}

/** 无解析/勾选阶段的任务（音乐查询）：创建即入队，前端直接关框 */
export interface CreateTaskResultStarted {
  kind: 'started'
  taskId: string
}

export type CreateTaskResult = CreateTaskResultAwaiting | CreateTaskResultStarted | CreateTaskResultFailed

/** R7 续（backlog #18）：订阅追更源（频道/UP主/歌单 URL 定时抓新）。
 * 三期（0.10.x）升级：RSS 源、每源保存目录/参数预设/命名模板、条目级过滤 */
export interface Subscription {
  id: string
  name: string
  url: string
  /** 抓取间隔（分钟） */
  intervalMin: number
  /** 累计自动入队条数 */
  addedTotal: number
  lastCheckedAt: number | null
  lastError: string | null
  createdAt: number
  /** 源类型：ytdlp（频道/UP主/歌单，yt-dlp flat-parse）| rss（RSS/Atom 订阅） */
  sourceKind: 'ytdlp' | 'rss'
  /** 每源保存目录（空 = 全局 download.saveDir） */
  saveDir: string | null
  /** 参数预设 ID（download.videoPresets 内，空 = 默认参数） */
  presetId: number | null
  /** 每源命名模板（空 = 预设模板 → 全局 naming.template） */
  template: string | null
  /** 条目过滤：最短时长秒（0 = 不过滤；yt-dlp 条目有 duration，RSS 无） */
  filterMinSec: number
  /** 条目过滤：标题关键词（逗号/顿号分隔，任一命中即保留；空 = 不过滤） */
  filterKeywords: string | null
}

export interface SubscriptionAddInput {
  name: string
  url: string
  intervalMin: number
  sourceKind?: 'ytdlp' | 'rss'
  saveDir?: string
  presetId?: number | null
  template?: string
  filterMinSec?: number
  filterKeywords?: string
}

/** 三期（backlog #18 边界收敛）：订阅源编辑（全字段覆盖，id 必填） */
export interface SubscriptionUpdateInput extends SubscriptionAddInput {
  id: string
}

/** 三期（0.10.x）：视频媒体库条目（视频任务完成即登记，封面墙浏览） */
export interface VideoLibraryItem {
  id: string
  taskId: string | null
  path: string
  title: string
  platform: string | null
  size: number
  /** 秒（ffprobe 探测，失败为 null） */
  durationSec: number | null
  /** 封面 jpg 绝对路径（userData/covers/；抽取失败为 null，前端占位图） */
  coverPath: string | null
  /** 四期：磁盘文件缺失（被移动/删除）——条目可见但禁预览 */
  exists: boolean
  createdAt: number
}

/** 四期（0.11.x）：NFO/海报导出结果（落视频同目录，Jellyfin/Emby 归档口径） */
export interface NfoExportResult {
  nfoPath: string
  posterPath: string | null
}

/** backlog #26（2026-10-03）：网盘/WebDAV（OpenList）目录条目 */
export interface NetdiskEntry {
  name: string
  isDir: boolean
  size: number
  /** 相对端点根的服务器路径（如 /movies/foo.mp4） */
  path: string
}

export interface NetdiskDownloadInput {
  entries: NetdiskEntry[]
  saveDir: string
  threads: number
}

/** 审查修复（P2-1）：批量提交改为部分成功语义——created 与 failed 并行返回，
 * 此前整批 reject 会掩盖已创建的任务并诱导用户重试产生重复 */
export interface NetdiskDownloadResult {
  created: number
  failed: Array<{ name: string; error: string }>
}

/** 侧栏角标计数（SQL 全表口径，跨视图一致） */
export interface TaskCounts {
  running: number
  queued: number
  completed: number
  /** R6：失败任务数（「下载失败」侧栏角标） */
  failed: number
  trashed: number
}

/** BT 外网可达性探测结果（reachable=null = 探测服务不可用/超时） */
export interface BtExternalResult {
  reachable: boolean | null
  /** 成功节点数 / 总节点数 */
  ok: number
  total: number
  /** 本机公网 IP（探测依据，仅本地展示不入库） */
  ip?: string
  error?: string
}

/** 应用更新检查结果（Linux 手动通道口径） */
export interface AppUpdateCheck {
  hasUpdate: boolean
  current: string
  latest?: string
  releaseUrl?: string
  error?: string
}

/** M3-9：引擎热更结果（yt-dlp 热更器 UpdateResult 口径） */
export interface EngineUpdateResult {
  ok: boolean
  version?: string
  error?: string
}

/** Backlog：平台适配健康（提取器健康度/失效平台公示） */
export type PlatformHealthStatus = 'ok' | 'degraded' | 'down' | 'unknown'

export interface PlatformHealthError {
  at: number
  /** M4-17 归因口径：dns/tls/http/risk/disk/unknown */
  kind: string
  message: string
}

export interface PlatformHealthEntry {
  id: string
  label: string
  /** 归属引擎（aria2/yt-dlp/music）或 music 平台 id */
  engine: string
  status: PlatformHealthStatus
  lastOkAt?: number
  lastFailAt?: number
  /** 最近 24h 失败次数 */
  failCount: number
  recentErrors: PlatformHealthError[]
  /** 降级/失效时的建议出口动作 */
  hint?: string
}

/** Backlog：平台适配脚本（内置自维护 + userData 目录热更） */
export interface AdapterScriptInfo {
  id: string
  platform: string
  version: string
  enabled: boolean
  source: 'builtin' | 'user'
  notes?: string
  /** host 重写表：官方域 → 镜像域（平台改版自救，免发版） */
  hostOverrides: Record<string, string>
}

export interface OmniGetBridge {
  // task
  createTask(input: CreateTaskInput): Promise<CreateTaskResult>
  confirmSelection(input: ConfirmSelectionInput): Promise<void>
  controlTask(input: ControlTaskInput): Promise<void>
  retryTask(taskId: string): Promise<void>
  openFolder(taskId: string): Promise<void>
  listTasks(filter: string): Promise<Task[]>
  /** 侧栏角标计数（跨视图口径：含回收站，与当前过滤无关） */
  taskCounts(): Promise<TaskCounts>
  /** M4-2 Inspector：任务详情 + 文件清单 */
  getTaskDetail(taskId: string): Promise<{ task: Task; files: TaskFile[] } | null>
  // music
  musicSearch(input: MusicSearchInput): Promise<MusicSearchResult>
  musicDownload(input: MusicDownloadInput): Promise<{ taskId: string }>
  /** F1 试听：返回主进程代理的预览流 URL（omniget-preview:// 协议，<audio> 播放） */
  musicPreview(platform: string, id: string): Promise<string>
  /** 二期：歌单/专辑 URL → 曲目列表（网易云公开 API；批量勾选入队用） */
  musicPlaylist(url: string): Promise<MusicPlaylistInfo>
  /** 二期：音乐库（已完成曲目） */
  musicLibrary(): Promise<MusicLibraryTrack[]>
  /** 二期：从音乐库移除条目（不删文件） */
  musicLibraryRemove(trackId: string): Promise<void>
  /** 二期：MusicBrainz 一键补标签（原地回写 + 库行同步） */
  musicLibraryRetag(trackId: string): Promise<MusicRetagResult>
  /** 三期：视频媒体库（视频任务完成即登记） */
  videoLibrary(): Promise<VideoLibraryItem[]>
  /** 三期：从视频库移除条目（不删文件） */
  videoLibraryRemove(id: string): Promise<void>
  /** 四期：NFO/海报手动导出（落视频同目录，Jellyfin/Emby 归档口径） */
  videoExportNfo(id: string): Promise<NfoExportResult>
  /** 四期：OpenSubtitles API Key（safeStorage 凭据通道；保存即生效，不回显） */
  opensubtitlesSaveKey(apiKey: string): Promise<void>
  /** 四期：OpenSubtitles Key 配置与存储形态（设置页状态展示，不回显 Key 本体） */
  opensubtitlesStatus(): Promise<{ hasKey: boolean; encrypted: boolean }>
  /** BT 端口自检：检测 aria2 listen-port 本地是否在监听（外网可达性需用户自行放行防火墙） */
  diagBtPort(): Promise<{
    listening: boolean
    port: number
    /** UPnP/NAT-PMP 映射状态（attempted=false 表示尚未尝试） */
    nat: { attempted: boolean; ok: boolean; error: string | null }
  }>
  /** BT 外网可达性探测（opt-in：经第三方 check-host.net 发起 TCP 探测，会暴露公网 IP） */
  diagBtExternal(): Promise<BtExternalResult>
  /** 应用更新检查（Linux 手动通道 / 通用版本比对）：GitHub latest release 元数据 */
  checkAppUpdate(): Promise<AppUpdateCheck>
  /** 打开 Releases 下载页（仅允许发布仓库 https 地址） */
  openReleases(): Promise<void>
  /** 渲染层平台标识（托盘/更新 UI 分支用） */
  readonly platform: NodeJS.Platform
  /** 降级黄条等通知（§4.4 降级告警） */
  onNotices(listener: (notices: UiNotice[]) => void): () => void
  /** 审查修复：主题跨窗口热同步（含迷你悬浮窗跟随主窗换肤） */
  onThemeChanged(listener: (theme: string) => void): () => void
  // engine
  engineUpdate(engine: 'ytdlp'): Promise<EngineUpdateResult>
  // tool
  toolCreate(input: ToolCreateInput): Promise<{ taskId: string }>
  /** 工具产物定位：在系统文件管理器中高亮该文件（失败经全局通知反馈） */
  revealToolOutput(output: string): Promise<void>
  /** 回归审查：demucs 二进制合法升级后重置 TOFU 指纹（渲染层无法直写该设置键） */
  resetDemucsFingerprint(): Promise<void>
  // settings
  settingsGet(key: string): Promise<unknown>
  settingsSet(key: string, value: unknown): Promise<void>
  // ── M4 ──────────────────────────────────────────────────────────────
  restoreTask(taskId: string): Promise<void>
  /** 彻底删除：任务记录 + 已下载文件 */
  purgeTask(taskId: string): Promise<void>
  /** 仅删除任务记录（保留已下载文件） */
  purgeTaskRecord(taskId: string): Promise<void>
  getStats(): Promise<DailyStat[]>
  getScheduleRules(): Promise<ScheduleRule[]>
  setScheduleRules(rules: ScheduleRule[]): Promise<void>
  listTrackers(): Promise<TrackerEntry[]>
  addTracker(url: string): Promise<void>
  removeTracker(url: string): Promise<void>
  refreshTrackers(): Promise<number>
  getToolDefs(): Promise<ToolDefInfo[]>
  /** Backlog：平台适配健康面板（提取器健康度/失效平台公示） */
  getPlatformHealth(): Promise<PlatformHealthEntry[]>
  /** Backlog：平台适配脚本注册表（内置自维护 + userData 热更目录） */
  listAdapterScripts(): Promise<AdapterScriptInfo[]>
  reloadAdapterScripts(): Promise<AdapterScriptInfo[]>
  toggleAdapterScript(id: string, enabled: boolean): Promise<void>
  /** R1+R5：本地桥接信息（端口/token，浏览器扩展与 Web UI 配置用） */
  getBridgeInfo(): Promise<{ port: number; token: string; running: boolean }>
  /** R6：引擎按需下载（状态查询 + 手动补齐缺失引擎） */
  getEngineStatus(): Promise<Array<{ name: string; file: string; installed: boolean; size?: number }>>
  fetchEngines(): Promise<{
    installed: string[]
    skipped: string[]
    failed: Array<{ name: string; error: string }>
  }>
  /** M4-13 工具箱事件流 */
  onToolEvents(listener: (e: ToolEvent) => void): () => void
  /** 标题栏 overlay 随主题变色 */
  syncTheme(theme: 'dark' | 'light'): void
  /** Electron 32+ 移除 File.path 后获取拖拽/选择的文件绝对路径（preload webUtils） */
  filePath(file: File): string
  /** 用户默认下载目录（设置 download.saveDir 优先，回退系统 Downloads） */
  defaultSaveDir(): Promise<string>
  /** 应用版本号（package.json version，主进程 app.getVersion）——「说明」页展示用 */
  appVersion(): Promise<string>
  /** 系统文件夹选择对话框（取消返回 null） */
  pickFolder(): Promise<string | null>
  /** R4 续（backlog #4）：预设导出——保存对话框 + 主进程写盘（渲染层无 Node 能力）；取消返回 null */
  exportFile(defaultName: string, content: string): Promise<string | null>
  /** R4 续（backlog #4）：预设导入——打开对话框 + 主进程读盘；取消返回 null */
  importFile(ext?: string): Promise<{ name: string; content: string } | null>
  /** R7 续（backlog #11）：短视频解析服务连接测试（主进程代发探测，渲染层无 Node 能力） */
  sidecarProbe(baseUrl: string): Promise<{ ok: boolean; detail: string }>
  // R7 续（backlog #18）：订阅追更（三期：编辑/每源参数/过滤）
  subscribeList(): Promise<Subscription[]>
  subscribeAdd(input: SubscriptionAddInput): Promise<Subscription>
  subscribeUpdate(input: SubscriptionUpdateInput): Promise<Subscription>
  subscribeRemove(id: string): Promise<void>
  subscribeCheckNow(id: string): Promise<{ added: number }>
  // backlog #26（2026-10-03）：网盘聚合（OpenList / WebDAV）
  netdiskProbe(): Promise<{ ok: boolean; detail: string }>
  netdiskSaveCreds(input: { username: string; password: string }): Promise<{ ok: boolean; detail: string }>
  netdiskList(path: string): Promise<NetdiskEntry[]>
  netdiskDownload(input: NetdiskDownloadInput): Promise<NetdiskDownloadResult>
  // events
  onTaskEvents(listener: (events: TaskEvent[]) => void): () => void
  onEngineHealth(listener: (health: EngineHealth[]) => void): () => void
  /** 托盘/剪贴板/协议唤起 → 打开新建任务并预填来源 */
  onUiAction(listener: (action: { action: 'new-task'; payload?: string }) => void): () => void
  /** 自绘窗口控件（frameless 圆角窗口） */
  windowMinimize(): void
  windowMaximize(): void
  windowClose(): void
  onWinState(listener: (maximized: boolean) => void): () => void
}

// IPC 通道白名单（主进程 ipc.ts 据此注册 handler，preload 据此暴露）
export const IPC_CHANNELS = {
  taskCreate: 'task:create',
  taskConfirmSelection: 'task:confirmSelection',
  taskControl: 'task:control',
  taskRetry: 'task:retry',
  taskOpenFolder: 'task:openFolder',
  taskList: 'task:list',
  taskCounts: 'task:counts',
  musicSearch: 'music:search',
  musicDownload: 'music:download',
  musicPreview: 'music:preview',
  /** 二期：歌单/专辑 URL 解析（网易云公开 API） */
  musicPlaylist: 'music:playlist',
  /** 二期：音乐库（已完成曲目登记视图） */
  musicLibrary: 'music:library',
  musicLibraryRemove: 'music:library:remove',
  musicLibraryRetag: 'music:library:retag',
  /** 三期：视频媒体库（视频任务完成即登记，封面墙浏览） */
  videoLibrary: 'video:library',
  videoLibraryRemove: 'video:library:remove',
  /** 四期（0.11.x）：NFO/海报手动导出 */
  videoExportNfo: 'video:nfo',
  /** 四期（0.11.x）：OpenSubtitles API Key（safeStorage 凭据通道，同 #26 口径） */
  opensubtitlesSaveKey: 'opensubtitles:saveKey',
  opensubtitlesStatus: 'opensubtitles:status',
  diagBtPort: 'diag:btPort',
  diagBtExternal: 'diag:btExternal',
  appCheckUpdate: 'app:checkUpdate',
  appOpenReleases: 'app:openReleases',
  engineUpdate: 'engine:update',
  toolCreate: 'tool:create',
  /** 工具产物定位：系统文件管理器高亮产物（「打开结果所在目录」） */
  toolReveal: 'tool:reveal',
  /** 回归审查：demucs 二进制合法升级后重置 TOFU 指纹 */
  toolDemucsReset: 'tool:demucsReset',
  /** Backlog：平台适配健康面板 */
  healthGet: 'health:get',
  /** Backlog：平台适配脚本注册表 */
  scriptsList: 'scripts:list',
  scriptsReload: 'scripts:reload',
  scriptsToggle: 'scripts:toggle',
  /** R1+R5：本地桥接信息 */
  bridgeInfo: 'bridge:info',
  /** R6：引擎按需下载 */
  enginesStatus: 'engines:status',
  enginesFetch: 'engines:fetch',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  /** R7 续（backlog #11）：短视频解析服务连接测试 */
  sidecarProbe: 'sidecar:probe',
  /** R7 续（backlog #18）：订阅追更 */
  subscribeList: 'subscribe:list',
  subscribeAdd: 'subscribe:add',
  subscribeUpdate: 'subscribe:update',
  subscribeRemove: 'subscribe:remove',
  subscribeCheckNow: 'subscribe:checkNow',
  /** backlog #26（2026-10-03）：网盘聚合（OpenList / WebDAV） */
  netdiskProbe: 'netdisk:probe',
  netdiskSaveCreds: 'netdisk:saveCreds',
  netdiskList: 'netdisk:list',
  netdiskDownload: 'netdisk:download',
  eventTasks: 'event:tasks',
  eventEngines: 'event:engines',
  /** M→R：UI 动作（托盘/剪贴板/协议唤起 → 打开新建任务并预填） */
  uiAction: 'ui:action',
  /** M→R：通知（音乐降级黄条等） */
  eventNotices: 'event:notices'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

/** 试听/本地媒体预览协议（<audio>/<video> 播放；CSP media-src 已放行） */
export const PREVIEW_SCHEME = 'omniget-preview'
