// 任务 store（M1-10，§3.1 Zustand 切片订阅：10k+ 行高频更新场景）

import { create } from 'zustand'
import type { EngineHealth, Task, TaskCounts, TaskEvent } from '@shared/types'

const SPEED_HISTORY_MAX = 40

/** load 乱序防护：仅应用最新一次请求的结果（快速切换分组时旧响应不得覆盖新状态） */
let loadSeq = 0

interface TasksState {
  tasks: Map<string, Task>
  engines: EngineHealth[]
  globalSpeedBps: number
  /** 顶栏迷你速度曲线的数据源（滚动窗口） */
  speedHistory: number[]
  /** F2：音乐任务阶段文案（无字节进度的任务展示用） */
  stageById: Record<string, string>
  /** M4-5：当前选中任务（快捷键 Space/Delete 作用对象） */
  selectedTaskId: string | null
  /** 置顶任务（settings ui.pinnedTasks 持久化，列表排序置顶优先） */
  pinned: string[]
  /** 侧栏角标计数（主进程 SQL 全表口径，跨视图一致） */
  counts: TaskCounts
  togglePin: (id: string) => void
  loading: boolean
  /** 当前 tasks map 对应的加载过滤器（回收站视图据此校验，防止把全部任务当回收站） */
  loadedFilter: string
  load: (filter: string) => Promise<void>
  refreshCounts: () => Promise<void>
  select: (id: string | null) => void
  applyEvents: (events: TaskEvent[]) => void
  setEngines: (engines: EngineHealth[]) => void
}

export const useTasks = create<TasksState>()((set, get) => ({
  tasks: new Map(),
  engines: [],
  globalSpeedBps: 0,
  speedHistory: [],
  stageById: {},
  selectedTaskId: null,
  pinned: [],
  counts: { running: 0, queued: 0, completed: 0, trashed: 0 },
  loadedFilter: 'all',
  loading: true,

  load: async (filter) => {
    const seq = ++loadSeq
    set({ loading: get().tasks.size === 0 })
    try {
      const [list, rawPinned] = await Promise.all([
        window.omniget.listTasks(filter),
        window.omniget.settingsGet('ui.pinnedTasks') as Promise<string[] | null>
      ])
      if (seq !== loadSeq) return // 过期响应：已被更新的 load 取代
      const map = new Map<string, Task>()
      for (const t of list) map.set(t.id, t)
      set({
        tasks: map,
        loadedFilter: filter,
        pinned: Array.isArray(rawPinned) ? rawPinned.filter((id) => map.has(id)) : [],
        loading: false
      })
    } catch {
      // DB/引擎异常：不抛出（调用方多为 void），保留上次列表并退出加载态
      if (seq === loadSeq) set({ loading: false })
    }
    void get().refreshCounts()
  },

  refreshCounts: async () => {
    try {
      const counts = await window.omniget.taskCounts()
      useTasks.setState({ counts })
    } catch {
      // 引擎未就绪等场景：保留上次计数
    }
  },

  togglePin: (id) => {
    const cur = get().pinned
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [id, ...cur]
    set({ pinned: next })
    // P2 加固：settingsSet 可能因 DB 异常 reject，void 直调会产生 unhandledrejection
    window.omniget.settingsSet('ui.pinnedTasks', next).catch(() => {})
  },

  applyEvents: (events) => {
    const tasks = new Map(get().tasks)
    const stageById = { ...get().stageById }
    let speed = 0
    for (const e of events) {
      const prev = tasks.get(e.taskId)
      if (!prev) continue
      tasks.set(e.taskId, {
        ...prev,
        status: e.status ?? prev.status,
        downloadedBytes: e.downloadedBytes ?? prev.downloadedBytes,
        totalBytes: e.totalBytes || prev.totalBytes,
        speedBps: e.speedBps ?? prev.speedBps,
        error: e.error ?? prev.error
      })
      if (e.message !== undefined) stageById[e.taskId] = e.message
      // P2 加固：终态任务的阶段文案已无消费方，删除防 stageById 无界增长
      if ((e.status === 'completed' || e.status === 'failed') && e.message === undefined) {
        delete stageById[e.taskId]
      }
    }
    for (const t of tasks.values()) {
      if (t.status === 'running') speed += t.speedBps
    }
    const history = [...get().speedHistory, speed].slice(-SPEED_HISTORY_MAX)
    set({ tasks, globalSpeedBps: speed, speedHistory: history, stageById })
  },

  select: (id) => set({ selectedTaskId: id }),

  setEngines: (engines) => set({ engines })
}))

// 全局订阅：一次性接线（App 挂载时调用）
export function wireTaskEvents(): () => void {
  const offTasks = window.omniget.onTaskEvents((events) => {
    useTasks.getState().applyEvents(events)
    // 状态变化影响跨视图计数（完成/失败等）→ 随事件流刷新角标
    if (events.some((e) => e.status !== undefined)) void useTasks.getState().refreshCounts()
  })
  const offEngines = window.omniget.onEngineHealth((health) => {
    useTasks.getState().setEngines(health)
  })
  void useTasks.getState().load('all')
  return () => {
    offTasks()
    offEngines()
  }
}
