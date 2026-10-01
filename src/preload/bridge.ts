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
  parseFile: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.taskParseFile, path),
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
  onToolEvents: (listener: (e: import('@shared/types').ToolEvent) => void) => {
    const wrapped = (_e: unknown, ev: import('@shared/types').ToolEvent): void => listener(ev)
    ipcRenderer.on('event:tools', wrapped)
    return () => ipcRenderer.removeListener('event:tools', wrapped)
  },
  syncTheme: (theme: 'dark' | 'light'): void => ipcRenderer.send('ui:theme', theme),
  filePath: (file: File): string => webUtils.getPathForFile(file),
  defaultSaveDir: (): Promise<string> => ipcRenderer.invoke('app:defaultSaveDir'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('app:pickFolder'),
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
