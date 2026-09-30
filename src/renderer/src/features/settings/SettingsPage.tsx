// 设置页（M4-11/15/16 + 基础设置）：内部菜单分区
// 模板 / 下载 / Tracker / 更新 / 说明
import { useEffect, useState } from 'react'
import { ArrowClockwise, CheckCircle, FolderOpen, Trash } from '@phosphor-icons/react'
import type { ScheduleRule, TrackerEntry } from '@shared/types'
import { Button } from '../../components/ui'
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
    void window.omniget.settingsSet('ui.keymap', {})
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
    </Section>
  )
}

type Tab = 'appearance' | 'keys' | 'template' | 'download' | 'tracker' | 'update' | 'about'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'appearance', label: '外观' },
  { id: 'keys', label: '快捷键' },
  { id: 'template', label: '命名模板' },
  { id: 'download', label: '下载' },
  { id: 'tracker', label: 'Tracker' },
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

  useEffect(() => {
    void (async () => {
      setTemplate(String((await window.omniget.settingsGet('naming.template')) ?? '{{title}}'))
      setCookieFile(String((await window.omniget.settingsGet('ytdlp.cookieFile')) ?? ''))
      setSaveDir(String((await window.omniget.settingsGet('download.saveDir')) ?? ''))
      setRules((await window.omniget.getScheduleRules()) ?? [])
      setTrackers(await window.omniget.listTrackers())
    })()
  }, [])

  function flash(msg: string): void {
    setSaved(msg)
    setTimeout(() => setSaved(''), 2500)
  }

  const reloadTrackers = (): Promise<void> =>
    window.omniget.listTrackers().then(setTrackers)

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-8 py-6">
        <h2 className="mb-4 text-sm font-medium">设置</h2>

        {/* 内部菜单（分区导航） */}
        <div className="mb-5 flex gap-1 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-3.5 pb-2.5 pt-1 text-[13px] transition-colors ${
                tab === t.id
                  ? 'border-accent font-medium text-accent'
                  : 'border-transparent text-text-2 hover:text-text-1'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {saved && (
          <div className="mb-4 rounded-ctl border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
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
                void window.omniget.settingsSet('naming.template', template)
                flash('命名模板已保存')
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
                  void window.omniget.settingsSet('download.saveDir', saveDir)
                  void window.omniget.settingsSet('ytdlp.cookieFile', cookieFile)
                  flash('下载设置已保存')
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
                    void window.omniget.setScheduleRules(rules)
                    flash('调度计划已保存（切换即时生效）')
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
                    onClick={() =>
                      void window.omniget.removeTracker(t.url).then(reloadTrackers)
                    }
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
                  void window.omniget
                    .addTracker(newTracker.trim())
                    .then(reloadTrackers)
                    .then(() => setNewTracker(''))
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
                  void window.omniget
                    .refreshTrackers()
                    .then(reloadTrackers)
                    .finally(() => setRefreshing(false))
                }}
              >
                刷新订阅
              </Button>
            </div>
            <p className="mt-2 text-[10px] text-text-3">
              订阅源：ngosang/trackerslist 每日最佳；刷新失败自动降级使用本地缓存；手动条目随任务注入
            </p>
          </Section>
        )}

        {/* ── 更新 ─────────────────────────────────────────────────── */}
        {tab === 'update' && (
          <Section title="更新">
            <p className="mb-2 text-xs leading-relaxed text-text-2">
              应用更新：打包版本随 GitHub 发布通道自动检查（每 4 小时），下载完成后退出时自动安装。
            </p>
            <p className="mb-3 text-xs leading-relaxed text-text-2">
              引擎更新：yt-dlp 属高频失效资产，提取器失效时失败任务会提示「更新引擎」，校验
              SHA256 后原子替换（TOFU 指纹口径，指纹不符拒绝安装）。
            </p>
            <Button
              size="sm"
              variant="outline"
              icon={<ArrowClockwise size={11} />}
              onClick={() => {
                void window.omniget.checkAppUpdate().then((r) =>
                  flash(r?.ok ? `引擎已更新至 ${r.version}` : '引擎已是最新或更新失败，详情见日志')
                )
              }}
            >
              立即检查引擎更新（yt-dlp）
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
                ：aria2 RPC 与音乐服务仅绑定 127.0.0.1 回环地址，调用方凭据经环境变量注入，不出现在进程参数中。
              </p>
              <p className="text-text-3">
                <span className="num">v0.1.0</span> · Electron 33 · React 18 · aria2c 1.37 · yt-dlp
                2026.08.19 · ffmpeg 9.0 · FastAPI
              </p>
            </div>
          </Section>
        )}
      </div>
    </main>
  )
}
