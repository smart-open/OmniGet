// 任务 store（M1-10，§3.1 Zustand 切片订阅：10k+ 行高频更新场景）

import { create } from 'zustand'
import type { EngineHealth, Task, TaskEvent } from '@shared/types'

const SPEED_HISTORY_MAX = 40

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
  togglePin: (id: string) => void
  loading: boolean
  /** 当前 tasks map 对应的加载过滤器（回收站视图据此校验，防止把全部任务当回收站） */
  loadedFilter: string
  load: (filter: string) => Promise<void>
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
  loadedFilter: 'all',
  loading: true,

  load: async (filter) => {
    set({ loading: get().tasks.size === 0 })
    const [list, rawPinned] = await Promise.all([
      window.omniget.listTasks(filter),
      window.omniget.settingsGet('ui.pinnedTasks') as Promise<string[] | null>
    ])
    const map = new Map<string, Task>()
    for (const t of list) map.set(t.id, t)
    set({
      tasks: map,
      loadedFilter: filter,
      pinned: Array.isArray(rawPinned) ? rawPinned.filter((id) => map.has(id)) : [],
      loading: false
    })
  },

  togglePin: (id) => {
    const cur = get().pinned
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [id, ...cur]
    set({ pinned: next })
    void window.omniget.settingsSet('ui.pinnedTasks', next)
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
