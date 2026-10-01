// 统计页（M4-4，§5）：读 daily_stats，完成量/体积/峰值速度视图 + 库实时总览
import { useEffect, useState } from 'react'
import type { DailyStat } from '@shared/types'
import { formatBytes } from '../new-task/fileTree'
import { Skeleton, Button } from '../../components/ui'
import { useTasks } from '../../stores/tasks'

export function StatsPage({ onNewTask }: { onNewTask?: () => void }) {
  const [stats, setStats] = useState<DailyStat[] | null>(null)
  const [statsError, setStatsError] = useState('')
  const tasks = useTasks((s) => s.tasks)
  const loadedFilter = useTasks((s) => s.loadedFilter)
  const reload = useTasks((s) => s.load)

  useEffect(() => {
    // P2 加固：getStats 失败不产生 unhandledrejection（保留骨架→空态路径）
    window.omniget
      .getStats()
      .then((r) => {
        setStats(r)
        setStatsError('')
      })
      .catch((err) => {
        // UX 硬性标准：失败不得伪装成空数据——区分「暂无记录」与「加载失败」
        setStats([])
        setStatsError(err instanceof Error ? err.message : String(err))
      })
    // 事件接线由 App 全局负责；此前此处重复接线导致监听器线性叠加
    void reload('all')
  }, [reload])

  // 库实时总览（不依赖 daily_stats 有无完成记录）。
  // R4-P3：loadedFilter 守卫——从回收站切到统计页的过渡窗口，tasks map 仍是
  // 回收站内容，此前会短暂显示错误口径（全表 → reload('all') 返回后才纠正）
  const libReady = loadedFilter === 'all'
  const lib = { total: 0, running: 0, bytes: 0 }
  if (libReady) {
    for (const t of tasks.values()) {
      lib.total++
      if (t.status === 'running' || t.status === 'queued') lib.running++
      lib.bytes += t.downloadedBytes ?? 0
    }
  }

  const totals = (stats ?? []).reduce(
    (acc, s) => ({
      count: acc.count + s.completedCount,
      bytes: acc.bytes + s.completedBytes,
      peak: Math.max(acc.peak, s.peakSpeedBps)
    }),
    { count: 0, bytes: 0, peak: 0 }
  )

  // 迷你柱状图（自绘 SVG，无外部图表库 §3.1）
  // R4-P3：口径统一——此前标题「近 30 天」、图表只画 14 天、汇总用全部数据三处不一
  const maxCount = Math.max(1, ...(stats ?? []).map((s) => s.completedCount))
  const chart = (stats ?? []).slice(0, 30).reverse()

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[720px] px-6 py-6">
        <h2 className="mb-4 text-sm font-medium">统计</h2>

        {statsError && (
          <p className="mb-4 rounded-panel border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            统计数据加载失败：{statsError}
          </p>
        )}

        {/* 库实时总览（始终有数：来自任务库） */}
        <div className="grid grid-cols-3 divide-x divide-border border-y border-border">
          {[
            { label: '任务总数', value: libReady ? String(lib.total) : '…' },
            { label: '进行中', value: libReady ? String(lib.running) : '…' },
            { label: '累计已下载', value: libReady ? formatBytes(lib.bytes) : '…' }
          ].map((m) => (
            <div key={m.label} className="px-4 py-4">
              <p className="num text-xl">{m.value}</p>
              <p className="mt-0.5 text-[10px] uppercase tracking-wider text-text-3">{m.label}</p>
            </div>
          ))}
        </div>

        <h3 className="mb-2 mt-6 text-xs text-text-2">近 30 天完成</h3>

        {/* 汇总指标：无卡片盒子，网格 + 线分隔（§7.2） */}
        <div className="grid grid-cols-3 divide-x divide-border border-y border-border">
          {[
            { label: '完成任务', value: String(totals.count) },
            { label: '完成体积', value: formatBytes(totals.bytes) },
            { label: '峰值速度', value: `${formatBytes(totals.peak)}/s` }
          ].map((m) => (
            <div key={m.label} className="px-4 py-4">
              <p className="num text-xl">{m.value}</p>
              <p className="mt-0.5 text-[10px] uppercase tracking-wider text-text-3">{m.label}</p>
            </div>
          ))}
        </div>

        {/* 空数据引导 */}
        {stats !== null && stats.length === 0 && (
          <div className="mt-3 flex items-center justify-between rounded-panel border border-border px-4 py-3">
            <p className="text-xs text-text-3">还没有完成记录——完成第一个下载任务后这里会出现曲线</p>
            {onNewTask && (
              <Button size="xs" variant="outline" onClick={onNewTask}>
                新建任务
              </Button>
            )}
          </div>
        )}

        {/* 每日完成量柱状图 */}
        <h3 className="mb-2 mt-6 text-xs text-text-2">每日完成量</h3>
        {stats === null ? (
          <Skeleton className="h-28 w-full" />
        ) : chart.length === 0 ? (
          <p className="py-6 text-center text-xs text-text-3">暂无数据</p>
        ) : (
          <div className="rounded-panel border border-border px-4 pb-2 pt-3">
            <div className="flex h-28 items-end gap-1.5">
              {chart.map((s) => {
                const h = Math.max(4, Math.round((s.completedCount / maxCount) * 88))
                return (
                  <div
                    key={s.day}
                    className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-1"
                  >
                    <span className="num text-[10px] text-text-3">{s.completedCount}</span>
                    <div
                      className="will-transform w-full max-w-8 rounded-t-md bg-accent/85 transition-colors group-hover:bg-accent"
                      style={{ height: `${h}px` }}
                      title={`${s.day}：完成 ${s.completedCount} 个 · ${formatBytes(s.completedBytes)}`}
                    />
                  </div>
                )
              })}
            </div>
            <div className="mt-1.5 flex gap-1.5 border-t border-border pt-1.5">
              {chart.map((s) => (
                <span
                  key={s.day}
                  className="num min-w-0 flex-1 truncate text-center text-[9px] text-text-3"
                >
                  {s.day.slice(5)}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 明细表 */}
        <h3 className="mb-2 mt-6 text-xs text-text-2">明细</h3>
        <div className="rounded-panel border border-border">
          {(stats ?? []).map((s) => (
            <div key={s.day} className="row-line flex items-center px-3 py-2 text-xs">
              <span className="num flex-1">{s.day}</span>
              <span className="num w-20 text-right">{s.completedCount} 个</span>
              <span className="num w-24 text-right">{formatBytes(s.completedBytes)}</span>
              <span className="num w-28 text-right text-text-3">
                峰值 {formatBytes(s.peakSpeedBps)}/s
              </span>
            </div>
          ))}
          {(stats ?? []).length === 0 && (
            <p className="px-3 py-4 text-center text-xs text-text-3">暂无完成记录</p>
          )}
        </div>
      </div>
    </main>
  )
}
