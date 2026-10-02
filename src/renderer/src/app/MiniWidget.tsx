// 迷你悬浮窗视图（backlog #8，设计文档 §7.7 迅雷对照）
// 主进程以 ?view=mini 复用主渲染层 bundle 拉起独立置顶小窗；
// 经 wireTaskEvents 接收同一任务事件流，展示聚合速度与运行/排队计数。
// 整窗可拖拽移动（titlebar-drag），关闭按钮销毁窗口（托盘菜单可随时重开）。

import { useEffect } from 'react'
import { ArrowDown, X } from '@phosphor-icons/react'
import { useTasks, wireTaskEvents } from '../stores/tasks'
import { applyTheme, parseStoredTheme } from '../theme'
import { SpeedSparkline } from '../components/ui'
import { formatBytes } from '../features/new-task/fileTree'

export default function MiniWidget() {
  const speed = useTasks((s) => s.globalSpeedBps)
  const history = useTasks((s) => s.speedHistory)
  const counts = useTasks((s) => s.counts)

  // 与主窗同源的事件流：速度曲线 / 计数 / 引擎健康
  useEffect(() => wireTaskEvents(), [])

  // 主题跟随全局设置（悬浮窗独立加载 bundle，不会收到主窗的主题广播）
  useEffect(() => {
    void window.omniget
      .settingsGet('ui.theme')
      .then((v) => applyTheme(parseStoredTheme(v)))
      .catch(() => applyTheme('system'))
    const onThemeChanged = (e: Event): void => {
      const id = (e as CustomEvent).detail
      if (id) applyTheme(id)
    }
    window.addEventListener('app:theme-changed', onThemeChanged)
    return () => window.removeEventListener('app:theme-changed', onThemeChanged)
  }, [])

  return (
    <div className="titlebar-drag fixed inset-0 flex select-none items-center gap-2.5 overflow-hidden rounded-[10px] border border-border bg-[var(--bg)] pl-3 pr-1.5">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-accent-soft">
        <ArrowDown size={12} weight="bold" className="text-accent" />
      </span>
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="num text-[13px] font-medium text-text-1">
          {formatBytes(speed)}/s
        </span>
        <span className="num text-[10px] text-text-3">
          运行 {counts.running} · 排队 {counts.queued}
        </span>
      </div>
      {/* 迷你速度曲线（与主窗顶栏同数据源、同组件） */}
      <div className="ml-auto flex shrink-0 items-center opacity-70">
        <SpeedSparkline history={history} width={44} height={20} />
      </div>
      <button
        onClick={() => window.omniget.windowClose()}
        aria-label="关闭悬浮窗"
        title="关闭悬浮窗"
        className="titlebar-no-drag press flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text-1"
      >
        <X size={12} weight="bold" />
      </button>
    </div>
  )
}
