// 设置页（M4-11/15/16 + 基础设置）：内部菜单分区
// 模板 / 下载 / Tracker / 更新 / 说明
import { useEffect, useState } from 'react'
import { ArrowClockwise, CheckCircle, FolderOpen, Trash } from '@phosphor-icons/react'
import type { AppUpdateCheck, AdapterScriptInfo, ScheduleRule, TrackerEntry } from '@shared/types'
import { Button } from '../../components/ui'
import { confirmAction, toast, toastError } from '../../lib/feedback'
import { LOCALES, useI18n } from '../../i18n'
import { THEMES, applyTheme, parseStoredTheme, watchSystemTheme, type ThemeId } from '../../theme'
import {
  DEFAULT_KEYS,
  SHORTCUT_LABELS,
  effectiveKeys,
  eventToKey,
  formatKey,
  parseKeymap,
  type Keymap,
  type ShortcutAction
} from '../../shortcuts'

/** 快捷键：默认表 + 点击录制改键（Esc 取消），冲突拦截，持久化 ui.keymap */
function KeysSection({ onOpenHelp }: { onOpenHelp?: () => void }) {
  const [overrides, setOverrides] = useState<Keymap>({})
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [tip, setTip] = useState('')
  const flashToast = (msg: string): void => {
    setTip(msg)
    setTimeout(() => setTip(''), 2500)
  }

  useEffect(() => {
    void window.omniget.settingsGet('ui.keymap').then((v) => setOverrides(parseKeymap(v)))
  }, [])

  const keys = effectiveKeys(overrides)

  // 录制：捕获下一个按键组合
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const k = eventToKey(e)
      if (!k) return // 修饰键单独按下，继续等待
      if (k === 'esc') {
        setRecording(null)
        return
      }
      // 冲突检测：与其他动作键位相同则拒绝
      const conflict = (Object.keys(keys) as ShortcutAction[]).find(
        (a) => a !== recording && keys[a] === k
      )
      if (conflict) {
        flashToast(`与「${SHORTCUT_LABELS[conflict]}」冲突（${formatKey(k)}），请换一个组合`)
        return
      }
      const next = { ...overrides, [recording]: k }
      setOverrides(next)
      setRecording(null)
      void window.omniget.settingsSet('ui.keymap', next)
      window.dispatchEvent(new Event('keymap-changed'))
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, overrides])

  const resetAll = (): void => {
    setOverrides({})
    window.omniget
      .settingsSet('ui.keymap', {})
      .then(() => flashToast('快捷键已恢复默认'))
      .catch((err) => toastError('恢复默认键位', err))
    window.dispatchEvent(new Event('keymap-changed'))
  }

  const actions = Object.keys(DEFAULT_KEYS) as ShortcutAction[]
  return (
    <Section title="键盘快捷键">
      <div className="max-w-xl rounded-panel border border-border">
        {actions.map((a) => {
          const isRecording = recording === a
          const conflicted =
            !isRecording &&
            recording !== null &&
            keys[recording] === keys[a] &&
            recording !== a
          return (
            <div key={a} className="row-line flex items-center justify-between px-4 py-2.5">
              <span className="text-xs text-text-2">{SHORTCUT_LABELS[a]}</span>
              <button
                onClick={() => setRecording(isRecording ? null : a)}
                className={`num press inline-flex h-7 min-w-28 items-center justify-center gap-1 rounded-ctl border px-2.5 text-[11px] transition-colors ${
                  isRecording
                    ? 'border-accent bg-accent-soft text-accent'
                    : conflicted
                      ? 'border-danger/50 text-danger'
                      : 'border-border text-text-2 hover:border-text-3 hover:text-text-1'
                }`}
                title="点击后按下新组合（Esc 取消）"
              >
                {isRecording ? (
                  <span className="animate-pulse">按下新组合…</span>
                ) : (
                  formatKey(keys[a])
                )}
              </button>
            </div>
          )
        })}
      </div>
      {tip && <p className="mt-2 text-[11px] text-danger">{tip}</p>}
      <div className="mt-3 flex items-center gap-2">
        <Button size="xs" variant="outline" icon={<ArrowClockwise size={12} />} onClick={resetAll}>
          恢复默认
        </Button>
        {onOpenHelp && (
          <Button size="xs" variant="ghost" onClick={onOpenHelp}>
            查看速查面板
          </Button>
        )}
      </div>
      <p className="mt-2 text-[10px] text-text-3">
        点击键位胶囊后按下新组合即可修改（支持 Ctrl/Alt/Shift 组合与 Space/Delete）；Esc 取消录制
      </p>
    </Section>
  )
}

/** 外观：主题选择（色板卡 + 跟随系统） */
function AppearanceSection() {
  const [theme, setTheme] = useState<ThemeId>('system')
  const locale = useI18n((s) => s.locale)
  const setLocale = useI18n((s) => s.setLocale)

  useEffect(() => {
    void window.omniget.settingsGet('ui.theme').then((v) => {
      const id = parseStoredTheme(v)
      setTheme(id)
      applyTheme(id)
    })
  }, [])
  useEffect(() => watchSystemTheme(theme, () => {}), [theme])

  const change = (id: ThemeId): void => {
    setTheme(id)
    applyTheme(id)
    void window.omniget.settingsSet('ui.theme', id)
  }

  return (
    <Section title="主题">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {THEMES.map((t) => (
          <button
            key={t.id}
            onClick={() => change(t.id)}
            className={`flex items-center gap-2.5 rounded-panel border px-3 py-2.5 text-left text-xs transition-colors ${
              theme === t.id
                ? 'border-accent bg-accent-soft font-medium text-accent'
                : 'border-border text-text-2 hover:border-text-3 hover:text-text-1'
            }`}
          >
            <span
              className="inline-block h-6 w-6 shrink-0 rounded-full border-2 transition-colors"
              style={
                theme === t.id
                  ? { background: t.accent, borderColor: t.accent }
                  : { background: 'transparent', borderColor: t.accent }
              }
            />
            <span className="flex-1 truncate">{t.label}</span>
            {theme === t.id && <CheckCircle size={14} weight="fill" className="text-accent" />}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-text-3">
        「随系统」随 Windows 深浅色自动切换曜石黑 / 石墨灰
      </p>

      {/* Backlog：多语言 i18n（外壳与健康页已覆盖，存量页面按迁移节奏收敛） */}
      <div className="mt-4 border-t border-border pt-4">
        <p className="mb-2 text-xs text-text-2">语言 / Language</p>
        <div className="flex gap-2">
          {LOCALES.map((l) => (
            <button
              key={l.id}
              onClick={() => setLocale(l.id)}
              className={`flex h-8 items-center gap-2 rounded-panel border px-3 text-xs transition-colors ${
                locale === l.id
                  ? 'border-accent bg-accent-soft font-medium text-accent'
                  : 'border-border text-text-2 hover:border-text-3 hover:text-text-1'
              }`}
            >
              {l.label}
              {locale === l.id && <CheckCircle size={13} weight="fill" className="text-accent" />}
            </button>
          ))}
        </div>
      </div>
    </Section>
  )
}

type Tab = 'appearance' | 'keys' | 'template' | 'download' | 'tracker' | 'scripts' | 'update' | 'about'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'appearance', label: '外观' },
  { id: 'keys', label: '快捷键' },
  { id: 'template', label: '命名模板' },
  { id: 'download', label: '下载' },
  { id: 'tracker', label: 'Tracker' },
  { id: 'scripts', label: '适配脚本' },
  { id: 'update', label: '更新' },
  { id: 'about', label: '说明' }
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-3 text-xs font-medium text-text-1">{title}</h3>
      {children}
    </section>
  )
}

function TextRow({
  label,
  value,
  onChange,
  hint,
  mono
}: {
  label: string
  value: string
  onChange: (v: string) => void
  hint?: string
  mono?: boolean
}) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-xs text-text-2">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`h-8 w-full max-w-lg rounded-ctl border border-border bg-surface-2 px-3 text-xs outline-none focus:border-accent ${
          mono ? 'num' : ''
        }`}
      />
      {hint && <p className="mt-1 text-[10px] leading-relaxed text-text-3">{hint}</p>}
    </div>
  )
}

export function SettingsPage({ onOpenHelp }: { onOpenHelp?: () => void }) {
  const [tab, setTab] = useState<Tab>('appearance') // 默认打开外观
  const [template, setTemplate] = useState('')
  const [cookieFile, setCookieFile] = useState('')
  const [saveDir, setSaveDir] = useState('')
  const [rules, setRules] = useState<ScheduleRule[]>([])
  const [trackers, setTrackers] = useState<TrackerEntry[]>([])
  const [newTracker, setNewTracker] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [saved, setSaved] = useState('')
  const [engineUpdating, setEngineUpdating] = useState(false)
  const [btDiag, setBtDiag] = useState<
    'checking' | 'listening' | 'not-listening' | 'error' | null
  >(null)
  const [btExt, setBtExt] = useState<
    | { state: 'checking' }
    | { state: 'ok' | 'blocked'; ok: number; total: number; ip?: string }
    | { state: 'unknown' | 'error'; message: string }
    | null
  >(null)
  const [appUpdateChecking, setAppUpdateChecking] = useState(false)
  const [appUpdate, setAppUpdate] = useState<AppUpdateCheck | null>(null)
  // Backlog：适配脚本注册表（内置自维护 + userData 热更目录）
  const [scripts, setScripts] = useState<AdapterScriptInfo[]>([])
  const t = useI18n((s) => s.t)

  useEffect(() => {
    void (async () => {
      setTemplate(String((await window.omniget.settingsGet('naming.template')) ?? '{{title}}'))
      setCookieFile(String((await window.omniget.settingsGet('ytdlp.cookieFile')) ?? ''))
      setSaveDir(String((await window.omniget.settingsGet('download.saveDir')) ?? ''))
      setRules((await window.omniget.getScheduleRules()) ?? [])
      setTrackers(await window.omniget.listTrackers())
      setScripts(await window.omniget.listAdapterScripts())
    })()
  }, [])

  function flash(msg: string): void {
    setSaved(msg)
    setTimeout(() => setSaved(''), 2500)
  }

  const reloadScripts = (): Promise<void> =>
    window.omniget
      .reloadAdapterScripts()
      .then(setScripts)
      .catch((err) => toastError('重新加载适配脚本', err))

  const reloadTrackers = (): Promise<void> =>
    window.omniget.listTrackers().then(setTrackers)

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-8 py-6">
        <h2 className="mb-4 text-sm font-medium">设置</h2>

        {/* 内部菜单（分区导航） */}
        <div className="mb-5 flex gap-1 border-b border-border">
          {TABS.map((tb) => (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              className={`-mb-px border-b-2 px-3.5 pb-2.5 pt-1 text-[13px] transition-colors ${
                tab === tb.id
                  ? 'border-accent font-medium text-accent'
                  : 'border-transparent text-text-2 hover:text-text-1'
              }`}
            >
              {t(`settings.tab.${tb.id}`)}
            </button>
          ))}
        </div>

        {saved && (
          <div
            className={
              saved.startsWith('更新失败')
                ? 'mb-4 rounded-ctl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger'
                : 'mb-4 rounded-ctl border border-success/40 bg-success/10 px-3 py-2 text-xs text-success'
            }
          >
            {saved}
          </div>
        )}

        {/* ── 命名模板 ─────────────────────────────────────────────── */}
        {tab === 'appearance' && <AppearanceSection />}
        {tab === 'keys' && <KeysSection onOpenHelp={onOpenHelp} />}
        {tab === 'template' && (
          <Section title="全局命名模板">
            <TextRow
              label="下载文件命名规则（视频/音乐引擎统一）"
              value={template}
              onChange={setTemplate}
              hint="变量：{{title}} 标题 · {{uploader}} 作者 · {{date}} 当日日期 · {{index:3}} 序号补零 3 位。非法字符自动按系统规则清洗。"
            />
            <div className="num mb-3 rounded-ctl bg-surface-2 px-3 py-2 text-[11px] text-text-2">
              预览：{template ? template.replace(/\{\{\s*title\s*\}\}/g, '示例标题').replace(/\{\{\s*uploader\s*\}\}/g, '示例作者') : '（空）'}
            </div>
            <Button
              size="sm"
              onClick={() => {
                window.omniget
                  .settingsSet('naming.template', template)
                  .then(() => flash('命名模板已保存'))
                  .catch((err) => toastError('保存命名模板', err))
              }}
            >
              保存
            </Button>
          </Section>
        )}

        {/* ── 下载 ─────────────────────────────────────────────────── */}
        {tab === 'download' && (
          <>
            <Section title="目录与凭据">
              <div className="mb-3">
                <label className="mb-1 block text-xs text-text-2">默认下载目录</label>
                <div className="flex max-w-lg gap-2">
                  <input
                    value={saveDir}
                    onChange={(e) => setSaveDir(e.target.value)}
                    className="num h-8 min-w-0 flex-1 rounded-ctl border border-border bg-surface-2 px-3 text-xs outline-none focus:border-accent"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<FolderOpen size={13} />}
                    onClick={() =>
                      void window.omniget.pickFolder().then((dir) => {
                        if (dir) setSaveDir(dir)
                      })
                    }
                  >
                    浏览
                  </Button>
                </div>
                <p className="mt-1 text-[10px] leading-relaxed text-text-3">
                  留空 = 使用系统下载目录；新建任务对话框会预填此值
                </p>
              </div>
              <TextRow
                label="yt-dlp Cookie 文件路径（可选）"
                value={cookieFile}
                onChange={setCookieFile}
                mono
                hint="Netscape 格式 cookies.txt；B 站 1080P / YouTube 登录内容需要"
              />
              <Button
                size="sm"
                onClick={() => {
                  Promise.all([
                    window.omniget.settingsSet('download.saveDir', saveDir),
                    window.omniget.settingsSet('ytdlp.cookieFile', cookieFile)
                  ])
                    .then(() => flash('下载设置已保存'))
                    .catch((err) => toastError('保存下载设置', err))
                }}
              >
                保存
              </Button>
            </Section>

            <Section title="定时限速计划">
              {rules.map((r, i) => (
                <div key={i} className="mb-2 flex items-center gap-2">
                  <input
                    value={r.from}
                    onChange={(e) =>
                      setRules(rules.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))
                    }
                    className="num h-7 w-20 rounded-ctl border border-border bg-surface-2 px-2 text-xs"
                  />
                  <span className="text-text-3">–</span>
                  <input
                    value={r.to}
                    onChange={(e) =>
                      setRules(rules.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))
                    }
                    className="num h-7 w-20 rounded-ctl border border-border bg-surface-2 px-2 text-xs"
                  />
                  <input
                    value={r.limit}
                    onChange={(e) =>
                      setRules(rules.map((x, j) => (j === i ? { ...x, limit: e.target.value } : x)))
                    }
                    className="num h-7 w-24 rounded-ctl border border-border bg-surface-2 px-2 text-xs"
                  />
                  <Button
                    size="xs"
                    variant="danger"
                    icon={<Trash size={11} />}
                    onClick={() => setRules(rules.filter((_, j) => j !== i))}
                  >
                    删除
                  </Button>
                </div>
              ))}
              <div className="flex gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setRules([...rules, { from: '09:00', to: '18:00', limit: '2M' }])}
                >
                  + 添加时段
                </Button>
                <Button
                  size="xs"
                  onClick={() => {
                    window.omniget
                      .setScheduleRules(rules)
                      .then(() => flash('调度计划已保存（切换即时生效）'))
                      .catch((err) => toastError('保存调度计划', err))
                  }}
                >
                  保存计划
                </Button>
              </div>
              <p className="mt-1.5 text-[10px] text-text-3">
                限速格式同 aria2（2M、500K、0=不限）；支持跨天时段（22:00–06:00），每分钟自动切换
              </p>
            </Section>
          </>
        )}

        {/* ── Tracker ──────────────────────────────────────────────── */}
        {tab === 'tracker' && (
          <Section title="Tracker 管理器（BT/磁力加速）">
            <div className="mb-2 max-h-64 overflow-y-auto rounded-panel border border-border">
              {trackers.map((t) => (
                <div key={t.url} className="row-line flex items-center gap-2 px-3 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate text-text-2">{t.url}</span>
                  <span className="num shrink-0 text-[10px] text-text-3">
                    {t.source}
                    {t.lastOkAt ? ` · ${new Date(t.lastOkAt).toLocaleDateString()}` : ''}
                  </span>
                  <button
                    className="press text-text-3 hover:text-danger"
                    onClick={() => {
                      void confirmAction({
                        title: '删除 Tracker',
                        message: `将从本地 Tracker 列表中移除：${t.url}`,
                        confirmLabel: '删除',
                        danger: true
                      }).then((ok) => {
                        if (!ok) return
                        window.omniget
                          .removeTracker(t.url)
                          .then(reloadTrackers)
                          .then(() => toast('Tracker 已删除', 'success'))
                          .catch((err) => toastError('删除 Tracker', err))
                      })
                    }}
                  >
                    <Trash size={12} />
                  </button>
                </div>
              ))}
              {trackers.length === 0 && (
                <p className="px-3 py-3 text-[11px] text-text-3">
                  暂无 Tracker，点击下方刷新拉取 ngosang 每日最佳列表
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={newTracker}
                onChange={(e) => setNewTracker(e.target.value)}
                placeholder="手动添加 tracker URL（udp://…）"
                className="h-7 flex-1 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
              />
              <Button
                size="xs"
                onClick={() => {
                  if (!newTracker.trim()) return
                  window.omniget
                    .addTracker(newTracker.trim())
                    .then(reloadTrackers)
                    .then(() => {
                      setNewTracker('')
                      toast('Tracker 已添加', 'success')
                    })
                    .catch((err) => toastError('添加 Tracker', err))
                }}
              >
                添加
              </Button>
              <Button
                size="xs"
                variant="outline"
                icon={<ArrowClockwise size={11} className={refreshing ? 'animate-spin' : ''} />}
                disabled={refreshing}
                onClick={() => {
                  setRefreshing(true)
                  window.omniget
                    .refreshTrackers()
                    .then(reloadTrackers)
                    .then(() => toast('Tracker 订阅已刷新', 'success'))
                    .catch((err) => toastError('刷新 Tracker 订阅', err))
                    .finally(() => setRefreshing(false))
                }}
              >
                刷新订阅
              </Button>
            </div>
            <p className="mt-2 text-[10px] text-text-3">
              订阅源：ngosang/trackerslist 每日最佳；刷新失败自动降级使用本地缓存；手动条目随任务注入
            </p>

            {/* BT 端口连通性自检（#5） */}
            <div className="mt-4 border-t border-border pt-3">
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setBtDiag('checking')
                    void window.omniget
                      .diagBtPort()
                      .then((r) => setBtDiag(r.listening ? 'listening' : 'not-listening'))
                      .catch(() => setBtDiag('error'))
                  }}
                >
                  BT 端口自检
                </Button>
                <span className="text-[10px] text-text-3">
                  {btDiag === 'listening' && '✓ 6881 端口监听正常'}
                  {btDiag === 'not-listening' &&
                    '✗ 6881 端口未监听——aria2 可能未就绪，请稍后重试'}
                  {btDiag === 'error' && '自检失败'}
                  {btDiag === 'checking' && '检测中…'}
                  {btDiag === null && '检测 aria2 BT 端口监听状态'}
                </span>
              </div>
              <p className="mt-1 text-[10px] text-text-3">
                提示：本地监听正常 ≠ 外网可达。BT 提速请在路由器/防火墙放行 <span className="num">6881</span> 端口（TCP+UDP）。
              </p>

              {/* 外网可达性探测（#5 增强，opt-in：经第三方 check-host.net，会暴露公网 IP） */}
              <div className="mt-3 flex items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={btExt?.state === 'checking'}
                  onClick={() => {
                    setBtExt({ state: 'checking' })
                    void window.omniget
                      .diagBtExternal()
                      .then((r) => {
                        if (r.reachable === true) setBtExt({ state: 'ok', ok: r.ok, total: r.total, ip: r.ip })
                        else if (r.reachable === false) setBtExt({ state: 'blocked', ok: r.ok, total: r.total, ip: r.ip })
                        else setBtExt({ state: 'unknown', message: r.error ?? '探测服务不可用' })
                      })
                      .catch(() => setBtExt({ state: 'error', message: '探测请求失败' }))
                  }}
                >
                  {btExt?.state === 'checking' ? '探测中…' : '外网可达性检测'}
                </Button>
                <span className="text-[10px] text-text-3">
                  {btExt?.state === 'ok' &&
                    `✓ 外网可连入（${btExt.ok}/${btExt.total} 节点成功）——BT 可被其他 peer 主动连接`}
                  {btExt?.state === 'blocked' &&
                    `✗ 外网无法连入（${btExt.ok}/${btExt.total} 节点成功）——请检查路由器端口映射 / 防火墙入站规则（6881 TCP+UDP）`}
                  {btExt?.state === 'unknown' && `探测未完成：${btExt.message}`}
                  {btExt?.state === 'error' && btExt.message}
                  {btExt === null && '从公网多节点验证 6881 能否被主动连入（仅本地监听无法证明）'}
                </span>
              </div>
              {btExt && btExt.state !== 'checking' && (
                <p className="mt-1 text-[10px] text-text-3">
                  探测经第三方服务 check-host.net 发起{btExt.state === 'ok' || btExt.state === 'blocked' ? `（本机公网 IP ${'ip' in btExt ? btExt.ip : ''}，仅用于本次探测，不入库不上报）` : ''}。
                </p>
              )}
            </div>
          </Section>
        )}

        {/* ── 适配脚本（Backlog：平台适配脚本热更生态）─────────────── */}
        {tab === 'scripts' && (
          <Section title="平台适配脚本（内置自维护 + 热更）">
            <p className="mb-3 text-[11px] leading-relaxed text-text-3">
              平台 API 改版时无需更新应用：编辑 <span className="num">userData/adapter-scripts/</span>{' '}
              下的 JSON 清单（<span className="num">hostOverrides</span> 把官方域重定向到镜像域），保存即自动热更；停用的脚本不参与请求改写。
            </p>
            {scripts.length === 0 ? (
              <p className="rounded-panel border border-border px-3 py-4 text-xs text-text-3">
                暂无脚本清单
              </p>
            ) : (
              <div className="mb-3 max-h-72 overflow-y-auto rounded-panel border border-border">
                {scripts.map((s) => (
                  <div key={s.id} className="row-line flex items-center gap-2 px-3 py-2 text-xs">
                    <span className="num shrink-0 text-text-3">{s.platform}</span>
                    <span className="min-w-0 flex-1">
                      <span className="num text-text-2">{s.id}</span>
                      <span className="ml-2 text-[10px] text-text-3">v{s.version}</span>
                      {Object.keys(s.hostOverrides ?? {}).length > 0 && (
                        <span className="ml-2 rounded border border-accent/40 px-1 py-px text-[9px] text-accent">
                          host 重写 ×{Object.keys(s.hostOverrides ?? {}).length}
                        </span>
                      )}
                    </span>
                    <button
                      className={`press shrink-0 rounded-ctl border px-2 py-0.5 text-[10px] transition-colors ${
                        s.enabled
                          ? 'border-accent/40 bg-accent-soft text-accent'
                          : 'border-border text-text-3 hover:text-text-2'
                      }`}
                      onClick={() => {
                        window.omniget
                          .toggleAdapterScript(s.id, !s.enabled)
                          .then(reloadScripts)
                          .then(() => toast(s.enabled ? '脚本已停用' : '脚本已启用', 'success'))
                          .catch((err) => toastError('切换脚本状态', err))
                      }}
                    >
                      {s.enabled ? '已启用' : '已停用'}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button size="xs" variant="outline" icon={<ArrowClockwise size={11} />} onClick={() => void reloadScripts()}>
                重新加载
              </Button>
            </div>
          </Section>
        )}

        {/* ── 更新 ─────────────────────────────────────────────────── */}
        {tab === 'update' && (
          <Section title="更新">
            {window.omniget.platform === 'linux' ? (
              <>
                {/* Linux 手动更新通道（遗留清单 #4：deb 无在线更新上游支持） */}
                <p className="mb-2 text-xs leading-relaxed text-text-2">
                  应用更新（Linux）：deb/AppImage 包不支持自动在线更新，请手动检查新版本并前往
                  发布页下载安装包覆盖安装。
                </p>
                <div className="mb-3 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<ArrowClockwise size={11} className={appUpdateChecking ? 'animate-spin' : ''} />}
                    disabled={appUpdateChecking}
                    onClick={() => {
                      setAppUpdateChecking(true)
                      void window.omniget
                        .checkAppUpdate()
                        .then((r) => {
                          setAppUpdate(r)
                          if (r.error) flash(r.error)
                        })
                        .catch(() => flash('检查失败：网络不可达'))
                        .finally(() => setAppUpdateChecking(false))
                    }}
                  >
                    {appUpdateChecking ? '检查中…' : '检查新版本'}
                  </Button>
                  {appUpdate && !appUpdate.error && (
                    <span className="text-xs text-text-2">
                      {appUpdate.hasUpdate
                        ? `发现新版本 v${appUpdate.latest}（当前 v${appUpdate.current}）`
                        : `已是最新版本（v${appUpdate.current}）`}
                    </span>
                  )}
                  {appUpdate?.error && <span className="text-xs text-text-3">{appUpdate.error}</span>}
                </div>
                {appUpdate?.hasUpdate && (
                  <div className="mb-3">
                    <Button
                      size="sm"
                      onClick={() => void window.omniget.openReleases()}
                      icon={<FolderOpen size={12} />}
                    >
                      前往下载 v{appUpdate.latest}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <p className="mb-2 text-xs leading-relaxed text-text-2">
                应用更新：打包版本随 GitHub 发布通道自动检查（每 4 小时），下载完成后退出时自动安装。
              </p>
            )}
            <p className="mb-3 text-xs leading-relaxed text-text-2">
              引擎更新：yt-dlp 属高频失效资产，提取器失效时失败任务会提示「更新引擎」，校验
              SHA256 后原子替换（TOFU 指纹口径，指纹不符拒绝安装）。
            </p>
            <Button
              size="sm"
              variant="outline"
              icon={
                <ArrowClockwise
                  size={11}
                  className={engineUpdating ? 'animate-spin' : ''}
                />
              }
              disabled={engineUpdating}
              onClick={() => {
                setEngineUpdating(true)
                flash('正在检查 yt-dlp 更新…')
                void window.omniget
                  .engineUpdate('ytdlp')
                  .then((r) =>
                    flash(
                      r?.ok
                        ? `yt-dlp 已更新至 ${r.version ?? '最新版'}`
                        : `更新失败：${r?.error ?? '未知错误'}`
                    )
                  )
                  .catch(() => flash('更新失败：无法连接更新服务，请检查网络'))
                  .finally(() => setEngineUpdating(false))
              }}
            >
              {engineUpdating ? '正在更新…' : '立即检查引擎更新（yt-dlp）'}
            </Button>
          </Section>
        )}

        {/* ── 说明 ─────────────────────────────────────────────────── */}
        {tab === 'about' && (
          <Section title="关于 OmniGet">
            <div className="space-y-3 text-xs leading-relaxed text-text-2">
              <p>
                <span className="font-medium text-text-1">定位</span>
                ：本地优先、无广告的跨平台桌面下载器。一站式覆盖 BT
                种子/磁力、主流视频平台、音乐平台与通用 HTTP 下载，附带本地 ffmpeg
                后处理工具箱（纯 DSP，零 AI / 零 GPU）。
              </p>
              <p>
                <span className="font-medium text-text-1">内容合规</span>
                ：本工具不内置、不导航、不聚合任何资源站；所下载内容版权责任由使用者承担，请遵守当地法律法规；短视频无水印功能仅选择平台本已对外提供的原始资源，仅供个人离线留存，不得二次分发。
              </p>
              <p>
                <span className="font-medium text-text-1">隐私</span>
                ：全部数据（任务库、设置、cookie）仅存储于本地用户目录；遥测默认关闭，无任何云端上报。
              </p>
              <p>
                <span className="font-medium text-text-1">本地服务</span>
                ：aria2 RPC 仅绑定 127.0.0.1 回环地址；引擎二进制经 TOFU 指纹校验，篡改即拒绝启动。
              </p>
              <p className="text-text-3">
                <span className="num">v0.1.0</span> · Electron 33 · React 18 · aria2c 1.37 · yt-dlp
                2026.08.19 · ffmpeg 9.0
              </p>
            </div>
          </Section>
        )}
      </div>
    </main>
  )
}
