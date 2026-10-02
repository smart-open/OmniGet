// preload contextBridge 白名单桥（T0-3，§6.1/§9）
// 仅暴露白名单 API；渲染层拿不到任何 Node 能力。

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IPC_CHANNELS,
  type ConfirmSelectionInput,
  type ControlTaskInput,
  type CreateTaskInput,
  type EngineHealth,
  type MusicDownloadInput,
  type MusicSearchInput,
  type OmniGetBridge,
  type TaskEvent,
  type ToolCreateInput,
  type UiNotice
} from '@shared/types'

const api: OmniGetBridge = {
  createTask: (input: CreateTaskInput) => ipcRenderer.invoke(IPC_CHANNELS.taskCreate, input),
  confirmSelection: (input: ConfirmSelectionInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.taskConfirmSelection, input),
  controlTask: (input: ControlTaskInput) => ipcRenderer.invoke(IPC_CHANNELS.taskControl, input),
  retryTask: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.taskRetry, taskId),
  openFolder: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.taskOpenFolder, taskId),
  listTasks: (filter: string) => ipcRenderer.invoke(IPC_CHANNELS.taskList, filter),
  taskCounts: () => ipcRenderer.invoke(IPC_CHANNELS.taskCounts),
  musicSearch: (input: MusicSearchInput) => ipcRenderer.invoke(IPC_CHANNELS.musicSearch, input),
  musicDownload: (input: MusicDownloadInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.musicDownload, input),
  musicPreview: (platform: string, id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.musicPreview, platform, id),
  diagBtPort: () => ipcRenderer.invoke(IPC_CHANNELS.diagBtPort),
  diagBtExternal: () => ipcRenderer.invoke(IPC_CHANNELS.diagBtExternal),
  checkAppUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.appCheckUpdate),
  openReleases: () => ipcRenderer.invoke(IPC_CHANNELS.appOpenReleases),
  platform: process.platform,
  onNotices: (listener: (notices: UiNotice[]) => void) => {
    const wrapped = (_e: unknown, notices: UiNotice[]): void => listener(notices)
    ipcRenderer.on(IPC_CHANNELS.eventNotices, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.eventNotices, wrapped)
  },
  engineUpdate: (engine) => ipcRenderer.invoke(IPC_CHANNELS.engineUpdate, engine),
  toolCreate: (input: ToolCreateInput) => ipcRenderer.invoke(IPC_CHANNELS.toolCreate, input),
  revealToolOutput: (output: string) => ipcRenderer.invoke(IPC_CHANNELS.toolReveal, output),
  settingsGet: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.settingsGet, key),
  settingsSet: (key: string, value: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsSet, key, value),
  restoreTask: (taskId: string) => ipcRenderer.invoke('task:restore', taskId),
  purgeTask: (taskId: string) => ipcRenderer.invoke('task:purge', taskId),
  getStats: () => ipcRenderer.invoke('stats:get'),
  getScheduleRules: () => ipcRenderer.invoke('schedule:get'),
  setScheduleRules: (rules) => ipcRenderer.invoke('schedule:set', rules),
  listTrackers: () => ipcRenderer.invoke('trackers:list'),
  addTracker: (url: string) => ipcRenderer.invoke('trackers:add', url),
  removeTracker: (url: string) => ipcRenderer.invoke('trackers:remove', url),
  refreshTrackers: () => ipcRenderer.invoke('trackers:refresh'),
  getToolDefs: () => ipcRenderer.invoke('tool:defs'),
  // Backlog：平台健康面板 + 适配脚本注册表
  getPlatformHealth: () => ipcRenderer.invoke(IPC_CHANNELS.healthGet),
  listAdapterScripts: () => ipcRenderer.invoke(IPC_CHANNELS.scriptsList),
  reloadAdapterScripts: () => ipcRenderer.invoke(IPC_CHANNELS.scriptsReload),
  toggleAdapterScript: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.scriptsToggle, id, enabled),
  // R1+R5：本地桥接信息
  getBridgeInfo: () => ipcRenderer.invoke(IPC_CHANNELS.bridgeInfo),
  // R6：引擎按需下载
  getEngineStatus: () => ipcRenderer.invoke(IPC_CHANNELS.enginesStatus),
  fetchEngines: () => ipcRenderer.invoke(IPC_CHANNELS.enginesFetch),
  onToolEvents: (listener: (e: import('@shared/types').ToolEvent) => void) => {
    const wrapped = (_e: unknown, ev: import('@shared/types').ToolEvent): void => listener(ev)
    ipcRenderer.on('event:tools', wrapped)
    return () => ipcRenderer.removeListener('event:tools', wrapped)
  },
  syncTheme: (theme: 'dark' | 'light'): void => ipcRenderer.send('ui:theme', theme),
  filePath: (file: File): string => webUtils.getPathForFile(file),
  defaultSaveDir: (): Promise<string> => ipcRenderer.invoke('app:defaultSaveDir'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('app:pickFolder'),
  // R4 续（backlog #4）：预设导出/导入（读写盘收口在主进程）
  exportFile: (defaultName: string, content: string): Promise<string | null> =>
    ipcRenderer.invoke('app:exportFile', defaultName, content),
  importFile: (ext?: string): Promise<{ name: string; content: string } | null> =>
    ipcRenderer.invoke('app:importFile', ext),
  // R7 续（backlog #11）：短视频解析服务连接测试
  sidecarProbe: (baseUrl: string) => ipcRenderer.invoke(IPC_CHANNELS.sidecarProbe, baseUrl),
  // R7 续（backlog #18）：订阅追更
  subscribeList: () => ipcRenderer.invoke(IPC_CHANNELS.subscribeList),
  subscribeAdd: (input) => ipcRenderer.invoke(IPC_CHANNELS.subscribeAdd, input),
  subscribeRemove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.subscribeRemove, id),
  subscribeCheckNow: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.subscribeCheckNow, id),
  onTaskEvents: (listener: (events: TaskEvent[]) => void) => {
    const wrapped = (_e: unknown, events: TaskEvent[]): void => listener(events)
    ipcRenderer.on(IPC_CHANNELS.eventTasks, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.eventTasks, wrapped)
  },
  onEngineHealth: (listener: (health: EngineHealth[]) => void) => {
    const wrapped = (_e: unknown, health: EngineHealth[]): void => listener(health)
    ipcRenderer.on(IPC_CHANNELS.eventEngines, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.eventEngines, wrapped)
  },
  // 审查修复：主题跨窗口热同步此前断在 preload——主进程 app:theme-changed IPC
  // 消息无人消费，迷你悬浮窗改主题后永不换肤
  onThemeChanged: (listener: (theme: string) => void) => {
    const wrapped = (_e: unknown, theme: string): void => listener(theme)
    ipcRenderer.on('app:theme-changed', wrapped)
    return () => ipcRenderer.removeListener('app:theme-changed', wrapped)
  },
  onUiAction: (
    listener: (action: { action: 'new-task'; payload?: string }) => void
  ) => {
    const wrapped = (_e: unknown, action: { action: 'new-task'; payload?: string }): void =>
      listener(action)
    ipcRenderer.on(IPC_CHANNELS.uiAction, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.uiAction, wrapped)
  },
  getTaskDetail: (taskId: string) =>
    ipcRenderer.invoke('task:detail', taskId) as Promise<{
      task: import('@shared/types').Task
      files: import('@shared/types').TaskFile[]
    } | null>,
  purgeTaskRecord: (taskId: string) => ipcRenderer.invoke('task:purgeRecord', taskId),
  // 自绘窗口控件（frameless 圆角窗口）
  windowMinimize: () => ipcRenderer.send('win:minimize'),
  windowMaximize: () => ipcRenderer.send('win:maximize'),
  windowClose: () => ipcRenderer.send('win:close'),
  onWinState: (listener: (maximized: boolean) => void) => {
    const wrapped = (_e: unknown, maximized: boolean): void => listener(maximized)
    ipcRenderer.on('win:state', wrapped)
    return () => ipcRenderer.removeListener('win:state', wrapped)
  }
}

contextBridge.exposeInMainWorld('omniget', api)
