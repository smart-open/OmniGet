// Backlog：平台适配状态面板（提取器健康度/失效平台公示）
// 数据：主进程 health:get（失败归因 M4-17 + 音乐降级事件喂入）+ 引擎在线状态。

import { useEffect, useState } from 'react'
import { ArrowClockwise, CheckCircle, Warning, XCircle } from '@phosphor-icons/react'
import type { PlatformHealthEntry } from '@shared/types'
import { useTasks } from '../../stores/tasks'
import { useI18n } from '../../i18n'
import { toastError } from '../../lib/feedback'

const STATUS_STYLE: Record<string, { icon: typeof CheckCircle; cls: string }> = {
  ok: { icon: CheckCircle, cls: 'text-success' },
  degraded: { icon: Warning, cls: 'text-warning' },
  down: { icon: XCircle, cls: 'text-danger' },
  unknown: { icon: XCircle, cls: 'text-text-3' }
}

function fmtTime(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export function HealthPage() {
  const t = useI18n((s) => s.t)
  const engines = useTasks((s) => s.engines)
  const [entries, setEntries] = useState<PlatformHealthEntry[]>([])
  const [loadError, setLoadError] = useState('')

  // 统一加载入口：manual=手动刷新（失败额外 toast）；轮询失败仅置内联错误横幅，
  // 不刷屏（每 10s 一次的定时探测失败不应打扰）
  const reload = (manual = false): void => {
    window.omniget
      .getPlatformHealth()
      .then((r) => {
        setEntries(r)
        setLoadError('')
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        setLoadError(msg)
        if (manual) toastError('刷新健康状态', err)
      })
  }

  useEffect(() => {
    reload()
    const timer = setInterval(() => reload(), 10_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[860px] px-6 py-6">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-medium">{t('health.title')}</h2>
          <button
            className="press inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text-1"
            onClick={() => reload(true)}
            title={t('health.autoRefresh')}
          >
            <ArrowClockwise size={12} /> {t('common.refresh')}
          </button>
        </div>
        <p className="mb-4 text-[11px] text-text-3">{t('health.subtitle')}</p>
        {loadError && (
          <div className="mb-4 flex items-center gap-2 rounded-panel border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            <XCircle size={14} weight="fill" className="shrink-0" />
            健康状态加载失败：{loadError}（将在下次轮询自动重试）
          </div>
        )}

        {/* 引擎在线状态（aria2 常驻红/绿；ytdlp·music 按需拉起为待机灰） */}
        <h3 className="mb-2 text-xs font-medium text-text-1">{t('health.engines')}</h3>
        <div className="mb-5 flex flex-wrap gap-2">
          {(['aria2', 'ytdlp', 'music', 'tool'] as const).map((name) => {
            const e = engines.find((x) => x.name === name)
            const online = e?.online ?? false
            return (
              <div
                key={name}
                className="flex items-center gap-2 rounded-panel border border-border px-3 py-2 text-xs"
                title={e?.detail ?? ''}
              >
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    online
                      ? 'bg-success'
                      : name === 'aria2'
                        ? 'bg-danger'
                        : 'bg-[var(--text-3)] opacity-60'
                  }`}
                />
                <span className="num text-text-2">{name}</span>
                <span className="text-text-3">{online ? 'online' : name === 'aria2' ? 'offline' : 'standby'}</span>
              </div>
            )
          })}
        </div>

        {/* 平台适配状态表 */}
        <h3 className="mb-2 text-xs font-medium text-text-1">{t('health.table')}</h3>
        {entries.length === 0 ? (
          <p className="rounded-panel border border-border px-3 py-6 text-center text-xs text-text-3">
            {t('health.empty')}
          </p>
        ) : (
          <div className="space-y-2">
            {entries.map((e) => {
              const st = STATUS_STYLE[e.status] ?? STATUS_STYLE['unknown']!
              const Icon = st.icon
              return (
                <div key={e.id} className="rounded-panel border border-border px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <Icon size={14} weight="fill" className={`shrink-0 ${st.cls}`} />
                    <span className="text-xs font-medium text-text-1">{e.label}</span>
                    <span className="rounded border border-border px-1 py-px text-[9px] uppercase tracking-wide text-text-3">
                      {e.engine}
                    </span>
                    <span className={`text-[11px] ${st.cls}`}>{t(`health.status.${e.status}`)}</span>
                    <span className="num ml-auto text-[10px] text-text-3">
                      {t('health.failCount')} {e.failCount}
                    </span>
                  </div>
                  <div className="num mt-1 flex gap-4 text-[10px] text-text-3">
                    <span>
                      {t('health.lastOk')} {fmtTime(e.lastOkAt)}
                    </span>
                    <span>
                      {t('health.lastFail')} {fmtTime(e.lastFailAt)}
                    </span>
                  </div>
                  {e.hint && (
                    <p className="mt-1 text-[11px] text-text-2">
                      {t('health.hint')}：{e.hint}
                    </p>
                  )}
                  {e.recentErrors.length > 0 && (
                    <div className="mt-1.5 border-t border-border pt-1.5">
                      <p className="mb-1 text-[10px] text-text-3">{t('health.recent')}</p>
                      <div className="space-y-0.5">
                        {e.recentErrors.slice(0, 3).map((err, i) => (
                          <p key={i} className="truncate text-[10px] text-text-3" title={err.message}>
                            <span className="num text-text-3">
                              [{new Date(err.at).toLocaleTimeString('zh-CN', { hour12: false })}]
                            </span>{' '}
                            <span className="text-text-2">{err.message}</span>
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </main>
  )
}
