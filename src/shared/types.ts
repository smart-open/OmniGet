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
  engine: 'aria2' | 'ytdlp' | 'music' | 'tool'
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

export type EngineName = 'aria2' | 'ytdlp' | 'music' | 'tool'

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
}

export interface MusicSearchResult {
  query: string
  parsed: { artist: string; song: string }
  candidates: MusicCandidate[]
  /** 搜索降级平台（UI 黄条，§4.4） */
  degraded: string[]
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

/** 侧栏角标计数（SQL 全表口径，跨视图一致） */
export interface TaskCounts {
  running: number
  queued: number
  completed: number
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
  parseFile(path: string): Promise<ParsedResource>
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
  /** BT 端口自检：检测 aria2 listen-port 本地是否在监听（外网可达性需用户自行放行防火墙） */
  diagBtPort(): Promise<{ listening: boolean; port: number }>
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
  // engine
  engineUpdate(engine: 'ytdlp'): Promise<EngineUpdateResult>
  // tool
  toolCreate(input: ToolCreateInput): Promise<{ taskId: string }>
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
  /** M4-13 工具箱事件流 */
  onToolEvents(listener: (e: ToolEvent) => void): () => void
  /** M4-7：触发应用自检更新 */
  checkAppUpdate(): Promise<{ ok: boolean; version?: string; error?: string } | null>
  /** 标题栏 overlay 随主题变色 */
  syncTheme(theme: 'dark' | 'light'): void
  /** Electron 32+ 移除 File.path 后获取拖拽/选择的文件绝对路径（preload webUtils） */
  filePath(file: File): string
  /** 用户默认下载目录（设置 download.saveDir 优先，回退系统 Downloads） */
  defaultSaveDir(): Promise<string>
  /** 系统文件夹选择对话框（取消返回 null） */
  pickFolder(): Promise<string | null>
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
  taskParseFile: 'task:parseFile',
  taskConfirmSelection: 'task:confirmSelection',
  taskControl: 'task:control',
  taskRetry: 'task:retry',
  taskOpenFolder: 'task:openFolder',
  taskList: 'task:list',
  taskCounts: 'task:counts',
  musicSearch: 'music:search',
  musicDownload: 'music:download',
  musicPreview: 'music:preview',
  diagBtPort: 'diag:btPort',
  diagBtExternal: 'diag:btExternal',
  appCheckUpdate: 'app:checkUpdate',
  appOpenReleases: 'app:openReleases',
  engineUpdate: 'engine:update',
  toolCreate: 'tool:create',
  /** Backlog：平台适配健康面板 */
  healthGet: 'health:get',
  /** Backlog：平台适配脚本注册表 */
  scriptsList: 'scripts:list',
  scriptsReload: 'scripts:reload',
  scriptsToggle: 'scripts:toggle',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
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
