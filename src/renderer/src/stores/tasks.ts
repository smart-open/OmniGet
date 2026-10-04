// 任务 store（M1-10，§3.1 Zustand 切片订阅：10k+ 行高频更新场景）

import { create } from 'zustand'
import type { EngineHealth, Task, TaskCounts, TaskEvent } from '@shared/types'
import { toastError } from '../lib/feedback'

const SPEED_HISTORY_MAX = 40

/** load 乱序防护：仅应用最新一次请求的结果（快速切换分组时旧响应不得覆盖新状态） */
let loadSeq = 0

/** M10：未知任务事件触发的防抖重载句柄 */
let unknownReloadTimer: ReturnType<typeof setTimeout> | null = null

/** 第六轮审查：已重载过仍未知的 taskId（按过滤器记忆）——排除型视图上运行中任务
 * 永不匹配过滤器，无记忆会造成 400ms 无限重载；换视图 load() 时清空 */
const unknownReloadSeen = new Set<string>()

/** 第七轮：上一次 load 的过滤器——区分「用户换视图」与「未知任务自动重载」，
 * 记忆集合只在换视图时清空（自动重载清空会让无限重载修复失效） */
let lastLoadFilter: string | null = null

/** 回归审查 P2：真实状态跃迁标记（含 paused/queued→running）——running 进度
 * 批次不再逐帧触发 counts 全表聚合，但跃迁仍需刷新角标 */
let countsDirty = false

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
  /** 最近一次 load 失败（列表错误态：展示过期数据须同时明示加载失败） */
  loadError: string | null
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
  counts: { running: 0, queued: 0, completed: 0, failed: 0, trashed: 0 },
  loadError: null,
  loadedFilter: 'all',
  loading: true,

  load: async (filter) => {
    const seq = ++loadSeq
    // 第七轮修复：unknownReloadSeen 只在「换视图」时清空——此前在每次 load 成功后
    // 清空，而排除型视图上运行中任务永不匹配过滤器 → 自动重载自身清掉记忆后，
    // 该任务的下一批进度事件再次触发重载，400ms 节奏的无限重载并未真正闭环
    set({ loading: get().tasks.size === 0, loadError: null })
    try {
      const [list, rawPinned] = await Promise.all([
        window.omniget.listTasks(filter),
        window.omniget.settingsGet('ui.pinnedTasks') as Promise<string[] | null>
      ])
      if (seq !== loadSeq) return // 过期响应：已被更新的 load 取代
      // 回归审查：viewChanged 与 lastLoadFilter 更新必须在「成功且非过期」分支——
      // 放在 await 前会让失败的 load 污染 lastLoadFilter（自动重载误指向旧视图、
      // 记忆被异常路径误清）；「加载成功」分支同时覆盖持续失败不反复放行重载
      const viewChanged = lastLoadFilter !== filter
      lastLoadFilter = filter
      if (viewChanged) unknownReloadSeen.clear()
      const map = new Map<string, Task>()
      for (const t of list) map.set(t.id, t)
      set({
        tasks: map,
        loadedFilter: filter,
        pinned: Array.isArray(rawPinned) ? rawPinned.filter((id) => map.has(id)) : [],
        loading: false
      })
    } catch (err) {
      // DB/引擎异常：不抛出（调用方多为 void），保留上次列表并退出加载态，
      // 但必须置错误态（§7.1 三态要求——静默展示过期数据会让用户误以为实时）
      if (seq === loadSeq) {
        set({
          loading: false,
          loadError: err instanceof Error ? err.message : '任务列表加载失败'
        })
      }
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
    const wasPinned = cur.includes(id)
    const next = wasPinned ? cur.filter((x) => x !== id) : [id, ...cur]
    set({ pinned: next })
    // UX 硬性标准：持久化失败必须可见反馈且回滚（乐观更新失败不回滚 = UI 说谎）。
    // L7 修复：回滚按"本次操作方向"取反——闭包快照回滚会把用户随后的第二次操作一并退回
    window.omniget.settingsSet('ui.pinnedTasks', next).catch((err) => {
      const latest = get().pinned
      set({ pinned: wasPinned ? [id, ...latest.filter((x) => x !== id)] : latest.filter((x) => x !== id) })
      toastError('保存置顶状态', err)
    })
  },

  applyEvents: (events) => {
    const tasks = new Map(get().tasks)
    const stageById = { ...get().stageById }
    let speed = 0
    let removed = false
    // M10 修复：本地未知的任务事件（新建任务的首批事件 / 跨过滤器列表）不做
    // 无中生有的灰记录（缺字段会渲染出残行），标记后按 400ms 防抖重载当前视图
    // 补全——此前直接 continue 且不重载，音乐下载后列表不刷新
    let unknownTask = false
    for (const e of events) {
      // 审查修复：删除事件从列表移除条目——否则悬浮窗等只靠事件流刷新的视图
      // 在主窗口删除任务后计数虚高（无自愈路径）
      if (e.removed) {
        tasks.delete(e.taskId)
        delete stageById[e.taskId]
        removed = true
        continue
      }
      const prev = tasks.get(e.taskId)
      if (!prev) {
        unknownTask = true
        continue
      }
      // 回归审查 P2：running 事件也可能是跃迁（paused/queued→running，恢复任务）——
      // 同样改变跨视图计数，标脏后由 wireTaskEvents 统一刷新
      if (e.status !== undefined && e.status !== prev.status) countsDirty = true
      tasks.set(e.taskId, {
        ...prev,
        status: e.status ?? prev.status,
        downloadedBytes: e.downloadedBytes ?? prev.downloadedBytes,
        totalBytes: e.totalBytes || prev.totalBytes,
        speedBps: e.speedBps ?? prev.speedBps,
        // P3 修复：任务重试/恢复成功（进入非 failed 状态）时清除旧错误文案，
        // 否则红色错误一直残留到下次全量 load
        error:
          e.error ??
          (e.status !== undefined && e.status !== 'failed' ? undefined : prev.error)
      })
      if (e.message !== undefined) stageById[e.taskId] = e.message
      // P2 加固：终态任务的阶段文案已无消费方，删除防 stageById 无界增长
      if ((e.status === 'completed' || e.status === 'failed') && e.message === undefined) {
        delete stageById[e.taskId]
      }
    }
    // 未知任务：防抖重载当前视图（把新任务/被删任务同步进列表）。
    // 第六轮审查：全局事件流含所有任务，停在「处理完成/失败/回收站」等排除型视图
    // 时，后台运行中任务永远不匹配过滤器 → 每 400ms 无限重载（IPC+全表查询+全量
    // 重渲染）。对已重载过仍未知（本视图合法不显示）的 taskId 记忆，不再重发；
    // load() 换视图时清空记忆
    if (unknownTask) {
      let needReload = false
      for (const e of events) {
        if (e.removed || get().tasks.has(e.taskId)) continue
        const seenKey = `${useTasks.getState().loadedFilter ?? ''}:${e.taskId}`
        if (unknownReloadSeen.has(seenKey)) continue
        unknownReloadSeen.add(seenKey)
        needReload = true
      }
      if (needReload) {
        if (unknownReloadTimer) clearTimeout(unknownReloadTimer)
        unknownReloadTimer = setTimeout(() => {
          unknownReloadTimer = null
          void useTasks.getState().load(useTasks.getState().loadedFilter)
        }, 400)
      }
    }
    for (const t of tasks.values()) {
      if (t.status === 'running') speed += t.speedBps
    }
    const history = [...get().speedHistory, speed].slice(-SPEED_HISTORY_MAX)
    set({ tasks, globalSpeedBps: speed, speedHistory: history, stageById })
    if (removed) void get().refreshCounts()
  },

  select: (id) => set({ selectedTaskId: id }),

  setEngines: (engines) => set({ engines })
}))

// 全局订阅：一次性接线（App 挂载时调用）
export function wireTaskEvents(): () => void {
  const offTasks = window.omniget.onTaskEvents((events) => {
    useTasks.getState().applyEvents(events)
    // 状态变化影响跨视图计数（完成/失败等）→ 随事件流刷新角标。
    // 第七轮审查 P3：running 进度批次恒带 status:'running'，逐批全表聚合 IPC
    // 是纯浪费——只对真实跃迁（非 running 事件，或 applyEvents 标记的跃迁）刷新
    if (events.some((e) => e.status !== undefined && e.status !== 'running') || countsDirty) {
      countsDirty = false
      void useTasks.getState().refreshCounts()
    }
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
