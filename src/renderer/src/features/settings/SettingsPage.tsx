// 设置页（M4-11/15/16 + 基础设置）：内部菜单分区
// 模板 / 下载 / Tracker / 更新 / 说明
import { useEffect, useRef, useState } from 'react'
import { ArrowClockwise, CheckCircle, FolderOpen, Trash } from '@phosphor-icons/react'
import type {
  AppUpdateCheck,
  AdapterScriptInfo,
  NetdiskEntry,
  ScheduleRule,
  Subscription,
  TrackerEntry
} from '@shared/types'
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
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashToast = (msg: string): void => {
    setTip(msg)
    if (tipTimer.current) clearTimeout(tipTimer.current)
    tipTimer.current = setTimeout(() => setTip(''), 2500)
  }
  useEffect(
    () => () => {
      if (tipTimer.current) clearTimeout(tipTimer.current)
    },
    []
  )

  useEffect(() => {
    void window.omniget
      .settingsGet('ui.keymap')
      .then((v) => setOverrides(parseKeymap(v)))
      .catch(() => {}) // 读取失败保持默认键位（防 unhandledrejection）
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
      // UX 硬性标准：持久化失败必须可见反馈（此前静默，重启后新键位丢失）。
      // 第七轮审查 P3：事件必须在落盘成功后广播——否则 App 立即回读可能拿到旧值
      //（与 resetAll 的 P2 修复同口径，单键录制路径此前漏改）
      window.omniget
        .settingsSet('ui.keymap', next)
        .then(() => window.dispatchEvent(new Event('keymap-changed')))
        .catch((err) => toastError('保存快捷键', err))
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, overrides])

  const resetAll = async (): Promise<void> => {
    // UX 硬性标准：重置全部自定义键位属破坏性操作——二次确认
    const ok = await confirmAction({
      title: '恢复默认快捷键',
      message: '将清除全部自定义键位并恢复默认设置，此操作不可恢复。',
      confirmLabel: '恢复默认'
    })
    if (!ok) return
    setOverrides({})
    try {
      await window.omniget.settingsSet('ui.keymap', {})
      // P2 修复：先落盘成功再广播事件——此前先 dispatch 后 await，
      // App 立即回读可能拿到旧值，且回显 stale 键位
      window.dispatchEvent(new Event('keymap-changed'))
      flashToast('快捷键已恢复默认')
    } catch (err) {
      toastError('恢复默认键位', err)
    }
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
        <Button
          size="xs"
          variant="outline"
          icon={<ArrowClockwise size={12} />}
          onClick={() => void resetAll()}
        >
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
/** 第六轮审查：「说明」页版本号此前硬编码 v0.1.0（实际已到 0.7.x）——改为运行时
 * 读 app.getVersion（app:version 通道），随发版自动更新 */
function AppVersionLabel() {
  const [v, setV] = useState('')
  useEffect(() => {
    window.omniget
      .appVersion()
      .then(setV)
      .catch(() => {})
  }, [])
  return <>{v || '…'}</>
}

function AppearanceSection() {
  const [theme, setTheme] = useState<ThemeId>('system')
  const locale = useI18n((s) => s.locale)
  const setLocale = useI18n((s) => s.setLocale)
  const t = useI18n((s) => s.t)
  // 兼容模式（跨平台加固）：禁用 GPU 硬件加速
  const [disableGpu, setDisableGpu] = useState(false)
  // M11 同款防抖：存量值加载完成前禁用控件——初始 false 基准上的误翻转会把
  // "未加载"当"未开启"落盘（加载失败按默认关闭继续，控件仍可用）
  const [gpuLoaded, setGpuLoaded] = useState(false)

  useEffect(() => {
    void window.omniget
      .settingsGet('ui.disableGpu')
      .then((v) => {
        setDisableGpu(v === true)
        setGpuLoaded(true)
      })
      .catch(() => setGpuLoaded(true))
  }, [])

  useEffect(() => {
    void window.omniget
      .settingsGet('ui.theme')
      .then((v) => {
        const id = parseStoredTheme(v)
        setTheme(id)
        applyTheme(id)
      })
      .catch(() => applyTheme('system')) // 读取失败按默认主题继续（防 unhandledrejection）
  }, [])
  useEffect(() => watchSystemTheme(theme, () => {}), [theme])

  const change = (id: ThemeId): void => {
    setTheme(id)
    applyTheme(id)
    // UX 硬性标准：持久化失败必须可见反馈
    window.omniget
      .settingsSet('ui.theme', id)
      .catch((err) => toastError('保存主题设置', err))
    // P2 修复：App 侧栏主题菜单是另一份本地 state——广播事件保持双端同步
    window.dispatchEvent(new CustomEvent('app:theme-changed', { detail: id }))
  }

  return (
    <Section title="主题">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {THEMES.map((th) => (
          <button
            key={th.id}
            onClick={() => change(th.id)}
            className={`flex items-center gap-2.5 rounded-panel border px-3 py-2.5 text-left text-xs transition-colors ${
              theme === th.id
                ? 'border-accent bg-accent-soft font-medium text-accent'
                : 'border-border text-text-2 hover:border-text-3 hover:text-text-1'
            }`}
          >
            <span
              className="inline-block h-6 w-6 shrink-0 rounded-full border-2 transition-colors"
              style={
                theme === th.id
                  ? { background: th.accent, borderColor: th.accent }
                  : { background: 'transparent', borderColor: th.accent }
              }
            />
            {/* 第七轮：主题名走 i18n */}
            <span className="flex-1 truncate">{t(`theme.${th.id}`)}</span>
            {theme === th.id && <CheckCircle size={14} weight="fill" className="text-accent" />}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-text-3">
        「随系统」随 Windows 深浅色自动切换曜石黑 / 石墨灰
      </p>

      {/* 第十轮审查 P3：向导重开入口（向导现已可跳过，跳过用户需要再来一次的出口） */}
      <div className="mt-4 border-t border-border pt-3">
        <button
          className="text-[11px] text-text-3 hover:text-accent hover:underline"
          onClick={() => window.dispatchEvent(new CustomEvent('app:open-onboarding'))}
        >
          重新运行首次启动向导（下载目录 / 外观 / 系统集成）
        </button>
      </div>

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

      {/* 兼容模式（跨平台加固）：Linux Wayland/NVIDIA 等环境 GPU 崩溃白屏的出口 */}
      <div className="mt-4 border-t border-border pt-4">
        <p className="mb-2 text-xs text-text-2">兼容模式</p>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-text-2">
          <input
            type="checkbox"
            disabled={!gpuLoaded}
            checked={disableGpu}
            onChange={(e) => {
              const next = e.target.checked
              setDisableGpu(next)
              window.omniget
                .settingsSet('ui.disableGpu', next)
                .then(() => toast('兼容模式设置已保存，重启应用生效'))
                .catch((err) => {
                  setDisableGpu(!next)
                  toastError('保存兼容模式设置', err)
                })
            }}
          />
          禁用 GPU 硬件加速（界面白屏/闪烁/崩溃时勾选）
        </label>
        <p className="mt-1 text-[10px] leading-relaxed text-text-3">
          关闭硬件加速改用软件渲染，解决部分 Linux/Wayland/NVIDIA 驱动与老 GPU 上的渲染崩溃；日常无需开启（性能略降）。修改后重启应用生效
        </p>
      </div>
    </Section>
  )
}

type Tab =
  | 'appearance'
  | 'keys'
  | 'template'
  | 'download'
  | 'remote'
  | 'tracker'
  | 'scripts'
  | 'update'
  | 'about'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'appearance', label: '外观' },
  { id: 'keys', label: '快捷键' },
  { id: 'template', label: '命名模板' },
  { id: 'download', label: '下载' },
  { id: 'remote', label: '远程/扩展' },
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
  // 二期（0.9.x）：音乐命名模板（支持 artist/album 目录结构，媒体服务器归档）
  const [musicTemplate, setMusicTemplate] = useState('')
  const [cookieFile, setCookieFile] = useState('')
  // R7 续（backlog #11）：短视频解析服务 sidecar 兜底
  const [sidecarUrl, setSidecarUrl] = useState('')
  const [sidecarProbing, setSidecarProbing] = useState(false)
  const [sidecarProbeMsg, setSidecarProbeMsg] = useState<{ ok: boolean; detail: string } | null>(
    null
  )
  // backlog #26（2026-10-03）：网盘聚合（OpenList / WebDAV）
  const [netdiskUrl, setNetdiskUrl] = useState('')
  const [netdiskUser, setNetdiskUser] = useState('')
  const [netdiskPass, setNetdiskPass] = useState('')
  const [netdiskProbing, setNetdiskProbing] = useState(false)
  const [netdiskProbeMsg, setNetdiskProbeMsg] = useState<{ ok: boolean; detail: string } | null>(
    null
  )
  const [netdiskBrowse, setNetdiskBrowse] = useState(false)
  const [netdiskPath, setNetdiskPath] = useState('/')
  const [netdiskEntries, setNetdiskEntries] = useState<NetdiskEntry[]>([])
  const [netdiskLoading, setNetdiskLoading] = useState(false)
  const [netdiskError, setNetdiskError] = useState('')
  const [netdiskSel, setNetdiskSel] = useState<Set<string>>(new Set())
  const [netdiskSaveDir, setNetdiskSaveDir] = useState('')
  const [netdiskDownloading, setNetdiskDownloading] = useState(false)
  const [netdiskCredBusy, setNetdiskCredBusy] = useState(false)
  // 四期（0.11.x）：内容库入库钩子——OpenSubtitles 字幕自动匹配 + NFO/海报导出
  const [subtitleHook, setSubtitleHook] = useState(false)
  const [subtitleLangs, setSubtitleLangs] = useState('zh')
  const [nfoExport, setNfoExport] = useState(false)
  const [osKey, setOsKey] = useState('')
  const [osInfo, setOsInfo] = useState<{ hasKey: boolean; encrypted: boolean } | null>(null)
  const [osBusy, setOsBusy] = useState(false)
  const [saveDir, setSaveDir] = useState('')
  // R2/R7：并发上限与自动归档
  const [maxConcurrent, setMaxConcurrent] = useState('0')
  const [autoArchive, setAutoArchive] = useState(false)
  // R7 续（backlog #19/#22）：下载行为开关
  const [dedupe, setDedupe] = useState(true)
  const [ytdlpAria2c, setYtdlpAria2c] = useState(false)
  // R7 续（backlog #18）：订阅追更
  const [subs, setSubs] = useState<Subscription[]>([])
  const [subName, setSubName] = useState('')
  const [subUrl, setSubUrl] = useState('')
  const [subInterval, setSubInterval] = useState('1440')
  const [subBusyId, setSubBusyId] = useState<string | null>(null)
  const [subAdding, setSubAdding] = useState(false)
  // 三期（backlog #18 边界收敛）：RSS 源 + 每源保存目录/预设/模板 + 条目过滤
  const [subKind, setSubKind] = useState<'ytdlp' | 'rss'>('ytdlp')
  const [subSaveDir, setSubSaveDir] = useState('')
  const [subPresetId, setSubPresetId] = useState('')
  const [subTemplate, setSubTemplate] = useState('')
  const [subMinSec, setSubMinSec] = useState('')
  const [subKeywords, setSubKeywords] = useState('')
  const [subEditingId, setSubEditingId] = useState<string | null>(null)
  // 参数预设下拉（download.videoPresets 仅取 id/name）
  const [videoPresets, setVideoPresets] = useState<Array<{ id: number; name: string }>>([])

  /** 三期：订阅表单 → 主进程入参（空值裁剪，预设下拉空串 = 不指定） */
  function subPayload() {
    return {
      name: subName.trim(),
      url: subUrl.trim(),
      intervalMin: Number(subInterval),
      sourceKind: subKind,
      saveDir: subSaveDir.trim() || undefined,
      presetId: subPresetId ? Number(subPresetId) : null,
      template: subTemplate.trim() || undefined,
      filterMinSec: Math.max(0, Math.round(Number(subMinSec) || 0)),
      filterKeywords: subKeywords.trim() || undefined
    }
  }

  /** 三期：表单复位（编辑退出/保存后调用） */
  function resetSubForm(): void {
    setSubEditingId(null)
    setSubName('')
    setSubUrl('')
    setSubInterval('1440')
    setSubKind('ytdlp')
    setSubSaveDir('')
    setSubPresetId('')
    setSubTemplate('')
    setSubMinSec('')
    setSubKeywords('')
  }

  /** 三期：行「编辑」→ 表单回填 */
  function startEditSub(s: Subscription): void {
    setSubEditingId(s.id)
    setSubName(s.name)
    setSubUrl(s.url)
    setSubInterval(String(s.intervalMin))
    setSubKind(s.sourceKind)
    setSubSaveDir(s.saveDir ?? '')
    setSubPresetId(s.presetId != null ? String(s.presetId) : '')
    setSubTemplate(s.template ?? '')
    setSubMinSec(s.filterMinSec > 0 ? String(s.filterMinSec) : '')
    setSubKeywords(s.filterKeywords ?? '')
  }
  const [upnp, setUpnp] = useState(true)
  const [btEncrypt, setBtEncrypt] = useState(true)
  const [rules, setRules] = useState<ScheduleRule[]>([])
  const [trackers, setTrackers] = useState<TrackerEntry[]>([])
  const [newTracker, setNewTracker] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [engineUpdating, setEngineUpdating] = useState(false)
  const [btDiag, setBtDiag] = useState<
    'checking' | 'listening' | 'not-listening' | 'error' | null
  >(null)
  // 审查修复：自检结果展示实际探测端口（listen-port 现为区间）+ NAT 映射状态
  const [btDiagPort, setBtDiagPort] = useState<number | null>(null)
  const [natDiag, setNatDiag] = useState<{
    attempted: boolean
    ok: boolean
    error: string | null
  } | null>(null)
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
  // R4-P3：脚本启停防连点（此前连点两次 toggle IPC，第二次 toast 与实际终态可能相反）
  const [scriptBusy, setScriptBusy] = useState<string | null>(null)
  // R4-P3：调度计划保存进行中禁用
  const [scheduleSaving, setScheduleSaving] = useState(false)
  // R1+R5：本地桥接信息
  const [bridgeInfo, setBridgeInfo] = useState<{
    port: number
    token: string
    running: boolean
    lan: boolean
    lanAddresses: string[]
  } | null>(null)
  // 五期（0.12.x）：局域网远程访问开关
  const [bridgeLan, setBridgeLan] = useState(false)
  const [bridgeLanBusy, setBridgeLanBusy] = useState(false)
  // R6：引擎按需下载
  const [engineList, setEngineList] = useState<
    Array<{ name: string; file: string; installed: boolean; size?: number }>
  >([])
  // 第七轮审查 P2：引擎清单加载失败此前渲染成「加载中…」永久空转（错误态缺失）
  const [engineLoadFailed, setEngineLoadFailed] = useState(false)
  const [engineFetching, setEngineFetching] = useState(false)
  const [engineMirror, setEngineMirror] = useState('')
  /** M11：设置加载完成前不渲染表单——输入框显示默认值时点保存会把默认值当真值落盘 */
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  // 第六轮审查：计划规则加载失败标记——失败后 rules 是空数组，此时允许「保存计划」
  // 会把空规则落盘清空全部调度计划（写前守卫）
  const rulesLoadFailedRef = useRef(false)
  const t = useI18n((s) => s.t)

  useEffect(() => {
    void (async () => {
      // 第六轮审查：17 个 IPC 此前逐个 await——页面感知延迟 = 各 IPC 往返之和；
      // 改 Promise.all 并行。失败分区守卫：计划规则加载失败时禁写（防把空规则
      // 落盘清空全部调度计划）
      const [rulesRes, subsRes] = await Promise.all([
        window.omniget.getScheduleRules().then((v) => ({ ok: true as const, v: v ?? [] })).catch((err) => ({ ok: false as const, err })),
        window.omniget.subscribeList().then((v) => ({ ok: true as const, v })).catch((err) => ({ ok: false as const, err })),
      ])
      if (rulesRes.ok) setRules(rulesRes.v)
      else rulesLoadFailedRef.current = true
      if (subsRes.ok) setSubs(subsRes.v)
      // 三期：订阅源参数预设下拉（失败静默——下拉为空仍可用默认参数）
      window.omniget
        .settingsGet('download.videoPresets')
        .then((v) => setVideoPresets(Array.isArray(v) ? (v as Array<{ id: number; name: string }>) : []))
        .catch(() => {})
      // 四期：入库钩子开关与语言偏好（加载失败按默认关闭继续，同上兜底口径）
      window.omniget.settingsGet('video.subtitleHook').then((v) => setSubtitleHook(v === true)).catch(() => {})
      window.omniget
        .settingsGet('video.subtitleLanguages')
        .then((v) => setSubtitleLangs(typeof v === 'string' && v ? v : 'zh'))
        .catch(() => {})
      window.omniget.settingsGet('video.nfoExport').then((v) => setNfoExport(v === true)).catch(() => {})
      window.omniget.opensubtitlesStatus().then((s) => setOsInfo(s)).catch(() => {})
      const [
        template, musicTemplate, cookieFile, sidecarUrl, netdiskUrl, netdiskSaveDir, saveDir,
        maxConcurrent, autoArchive, dedupe, ytdlpAria2c, upnp, btEncrypt,
        trackers, scripts, bridge, engineList, engineMirrorVal
      ] = await Promise.all([
        window.omniget.settingsGet('naming.template'),
        window.omniget.settingsGet('music.template'),
        window.omniget.settingsGet('ytdlp.cookieFile'),
        window.omniget.settingsGet('sidecar.videoApiUrl'),
        window.omniget.settingsGet('netdisk.endpoint'),
        window.omniget.defaultSaveDir(),
        window.omniget.settingsGet('download.saveDir'),
        window.omniget.settingsGet('download.maxConcurrent'),
        window.omniget.settingsGet('download.autoArchive'),
        window.omniget.settingsGet('download.dedupe'),
        window.omniget.settingsGet('download.ytdlpAria2c'),
        window.omniget.settingsGet('bt.upnp'),
        window.omniget.settingsGet('bt.forceEncryption'),
        window.omniget.listTrackers().catch(() => []),
        window.omniget.listAdapterScripts().catch(() => []),
        window.omniget.getBridgeInfo().catch(() => undefined),
        window.omniget.getEngineStatus().catch(() => 'ENGINE_LOAD_FAILED'),
        window.omniget.settingsGet('engines.mirror'),
      ])
      setTemplate(String(template ?? '{{title}}'))
      setMusicTemplate(String(musicTemplate ?? ''))
      setCookieFile(String(cookieFile ?? ''))
      setSidecarUrl(String(sidecarUrl ?? ''))
      setNetdiskUrl(String(netdiskUrl ?? ''))
      setNetdiskSaveDir(netdiskSaveDir)
      setSaveDir(String(saveDir ?? ''))
      setMaxConcurrent(String(maxConcurrent ?? 0))
      setAutoArchive(autoArchive === true)
      setDedupe(dedupe !== false)
      setYtdlpAria2c(ytdlpAria2c === true)
      setUpnp(upnp !== false)
      setBtEncrypt(btEncrypt !== false)
      setTrackers(trackers)
      setScripts(scripts)
      setBridgeInfo(bridge ?? null)
      // 五期：LAN 开关当前态（读取失败按关继续）
      window.omniget.settingsGet('bridge.lan').then((v) => setBridgeLan(v === true)).catch(() => {})
      if (typeof engineList === 'string') {
        // 加载失败哨兵值（见上方 getEngineStatus().catch）
        setEngineLoadFailed(true)
        setEngineList([])
      } else {
        setEngineLoadFailed(false)
        setEngineList(engineList ?? [])
      }
      setEngineMirror(String(engineMirrorVal ?? ''))
      setSettingsLoaded(true)
    })().catch((err) => {
      // P2 修复：任一 await 失败不得静默中断后续初始化（页面停留默认值且无提示）
      toastError('加载设置', err)
      setSettingsLoaded(true)
    })
  }, [])

  /** R6：手动补齐缺失引擎并刷新状态 */
  function fetchEnginesNow(): void {
    setEngineFetching(true)
    window.omniget
      .fetchEngines()
      .then((r) => {
        window.omniget
          .getEngineStatus()
          .then((list) => {
            // 回归审查 P3：与初始化同口径维护 engineLoadFailed（失败不得伪装成加载中）
            setEngineLoadFailed(false)
            setEngineList(list ?? [])
          })
          .catch(() => {
            setEngineLoadFailed(true)
            flash('引擎状态刷新失败（显示的可能为旧状态）', 'warning')
          })
        // 审查修复（P2-2）：部分成功部分失败此前只显示 installed 分支（else if），
        // 失败明细被静默吞掉、绿色横幅误导用户以为全部就绪
        if (r.failed.length > 0) {
          const okPart = r.installed.length > 0 ? `已安装：${r.installed.join('、')}；` : ''
          flash(
            `${okPart}失败：${r.failed.map((f) => `${f.name}（${f.error}）`).join('；')}`.slice(0, 300),
            'warning'
          )
        } else if (r.installed.length > 0) {
          flash(`已安装：${r.installed.join('、')}`)
        } else {
          flash('全部引擎已就绪，无需补齐')
        }
      })
      .catch((err) => toastError('补齐引擎', err))
      .finally(() => setEngineFetching(false))
  }

  function saveEngineMirror(): void {
    window.omniget
      .settingsSet('engines.mirror', engineMirror.trim())
      .then(() => flash('引擎分发源已保存（即时生效）'))
      .catch((err) => toastError('保存分发源', err))
  }

  /** 第七轮 P2：顶部横幅反馈在深滚动位置不可见（订阅/调度等深分区操作后用户
   * 完全无感知，会重复点击）——统一改全局 toast（右下角、3.5s、可点击关闭）。
   * 默认成功态；失败/警示调用点显式传 'warning' */
  function flash(msg: string, level: 'success' | 'warning' | 'info' = 'success'): void {
    toast(msg, level)
  }

  const reloadScripts = (): Promise<void> =>
    window.omniget
      .reloadAdapterScripts()
      .then((list) => {
        setScripts(list)
        // 第九轮审查：默认不 toast——启停脚本链路复用本函数会连发两条语义重叠
        // 提示；「重新加载」按钮自己补反馈
      })
      .catch((err) => toastError('重新加载适配脚本', err))

  // R4-P3：列表刷新失败与写操作成败分开报告——此前「添加成功但刷新失败」
  // 会走 catch 提示「添加失败」，用户重试产生重复条目
  const reloadTrackers = (): Promise<void> =>
    window.omniget.listTrackers().then(setTrackers).catch(() => {
      toast('操作成功，但 Tracker 列表刷新失败', 'warning')
    })

  // ── backlog #26（2026-10-03）：网盘目录浏览 / 提交下载 ──────────────
  /** 审查修复（P3-1）：请求序号守卫——快速连点两个目录时先发后至的响应
   * 此前会覆盖新目录内容，造成「路径显示 A、内容是 B」错配 */
  const netdiskNavSeq = useRef(0)
  function netdiskNav(path: string): void {
    const seq = ++netdiskNavSeq.current
    setNetdiskLoading(true)
    setNetdiskError('')
    window.omniget
      .netdiskList(path || '/')
      .then((list) => {
        if (seq !== netdiskNavSeq.current) return
        setNetdiskEntries(list)
        setNetdiskPath(path || '/')
        setNetdiskSel(new Set())
      })
      .catch((err) => {
        if (seq !== netdiskNavSeq.current) return
        setNetdiskError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (seq === netdiskNavSeq.current) setNetdiskLoading(false)
      })
  }
  function netdiskToggleBrowse(): void {
    if (netdiskBrowse) {
      setNetdiskBrowse(false)
      return
    }
    setNetdiskBrowse(true)
    netdiskNav('/')
  }
  function netdiskDownloadSelected(): void {
    const picked = netdiskEntries.filter((e) => !e.isDir && netdiskSel.has(e.path))
    if (picked.length === 0) return
    setNetdiskDownloading(true)
    window.omniget
      .netdiskDownload({ entries: picked, saveDir: netdiskSaveDir, threads: 8 })
      .then((r) => {
        if (r.failed.length > 0) {
          // 部分成功：明细必须可见（否则用户重试会产生重复任务）
          const detail = r.failed
            .slice(0, 3)
            .map((f) => `${f.name}（${f.error}）`)
            .join('；')
          toast(
            `已提交 ${r.created} 个，${r.failed.length} 个失败：${detail}${r.failed.length > 3 ? '…' : ''}`,
            'warning'
          )
        } else {
          toast(`已提交 ${r.created} 个网盘下载任务`, 'success')
        }
        setNetdiskSel(new Set())
      })
      .catch((err) => toastError('提交网盘下载', err))
      .finally(() => setNetdiskDownloading(false))
  }
  const fmtNetdiskSize = (n: number): string =>
    n >= 1024 ** 3
      ? `${(n / 1024 ** 3).toFixed(1)} GB`
      : n >= 1024 ** 2
        ? `${(n / 1024 ** 2).toFixed(1)} MB`
        : n >= 1024
          ? `${(n / 1024).toFixed(0)} KB`
          : `${n} B`

  if (!settingsLoaded) {
    return (
      <main className="h-full overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-8 py-6">
          <h2 className="mb-4 text-sm font-medium">设置</h2>
          <p className="animate-pulse text-xs text-text-3">设置加载中…</p>
        </div>
      </main>
    )
  }

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
              预览：{template
                ? template
                    .replace(/\{\{\s*title\s*\}\}/g, '示例标题')
                    .replace(/\{\{\s*uploader\s*\}\}/g, '示例作者')
                    .replace(/\{\{\s*date\s*\}\}/g, '2026-10-01')
                    .replace(/\{\{\s*index(:\d+)?\s*\}\}/g, (_m, pad: string | undefined) =>
                      String(1).padStart(Number(pad?.slice(1) ?? 1) || 1, '0')
                    )
                : '（空）'}
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
            {/* 二期（0.9.x）：音乐独立命名模板（媒体服务器归档） */}
            <div className="mt-5 border-t border-border pt-4">
              <TextRow
                label="音乐命名模板（可选，留空跟随上方全局模板）"
                value={musicTemplate}
                onChange={setMusicTemplate}
                hint="支持目录结构：{{artist}}/{{album}}/{{title}} 即 Navidrome/Jellyfin 归档约定（歌手/专辑/曲名三级目录）。变量额外含 {{album}} 专辑。"
              />
              <div className="num mb-3 rounded-ctl bg-surface-2 px-3 py-2 text-[11px] text-text-2">
                预览：{musicTemplate.trim()
                  ? musicTemplate
                      .replace(/\{\{\s*artist\s*\}\}/g, '示例歌手')
                      .replace(/\{\{\s*album\s*\}\}/g, '示例专辑')
                      .replace(/\{\{\s*title\s*\}\}/g, '示例曲名')
                      .replace(/\{\{\s*date\s*\}\}/g, '2026-10-01')
                      .replace(/\{\{\s*index(:\d+)?\s*\}\}/g, (_m, pad: string | undefined) =>
                        String(1).padStart(Number(pad?.slice(1) ?? 1) || 1, '0')
                      )
                  : '（空，跟随全局模板）'}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    window.omniget
                      .settingsSet('music.template', musicTemplate)
                      .then(() => flash('音乐命名模板已保存'))
                      .catch((err) => toastError('保存音乐命名模板', err))
                  }}
                >
                  保存
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setMusicTemplate('{{artist}}/{{album}}/{{title}}')}
                >
                  Navidrome 归档预设
                </Button>
              </div>
            </div>
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
                      void window.omniget
                        .pickFolder()
                        .then((dir) => {
                          if (dir) setSaveDir(dir)
                        })
                        .catch((err) => toastError('选择文件夹', err))
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
              <p className="mt-1 text-[10px] leading-relaxed text-text-3">
                分站 Cookie（R7）：在 cookie 文件同目录放置 douyin.txt / kuaishou.txt / xiaohongshu.txt / weibo.txt / xigua.txt，对应平台的任务自动优先使用
              </p>
              <Button
                size="sm"
                onClick={() => {
                  // P2 修复：只保存本分区（目录/凭据）——队列分区的值不再被顺手覆盖
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

            {/* R7 续（backlog #11）：短视频解析服务 sidecar 兜底 */}
            <Section title="短视频解析服务（可选）">
              <TextRow
                label="服务地址"
                value={sidecarUrl}
                onChange={(v) => {
                  setSidecarUrl(v)
                  setSidecarProbeMsg(null)
                }}
                mono
                hint="Evil0ctal/Douyin_TikTok_Download_API v5 自托管实例（Docker / 本地进程），示例 http://127.0.0.1:8000"
              />
              <p className="mt-1 text-[10px] leading-relaxed text-text-3">
                yt-dlp 解析失败时（快手/小红书等无内置提取器的平台）自动调用该服务获取直链并转为
                HTTP 下载；留空 = 禁用兜底。需提供 POST /api/hybrid/video_data 端点
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    window.omniget
                      .settingsSet('sidecar.videoApiUrl', sidecarUrl.trim())
                      .then(() => flash('解析服务设置已保存'))
                      .catch((err) => toastError('保存解析服务设置', err))
                  }}
                >
                  保存
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={sidecarProbing || !sidecarUrl.trim()}
                  onClick={() => {
                    setSidecarProbing(true)
                    setSidecarProbeMsg(null)
                    // 第十轮审查 P2：探测面收敛后走「先保存再测试」（与网盘同口径）
                    window.omniget
                      .settingsSet('sidecar.videoApiUrl', sidecarUrl.trim())
                      .then(() => window.omniget.sidecarProbe(sidecarUrl.trim()))
                      .then((r) => setSidecarProbeMsg(r))
                      .catch((err) => toastError('测试解析服务连接', err))
                      .finally(() => setSidecarProbing(false))
                  }}
                >
                  {sidecarProbing ? '测试中…' : '测试连接'}
                </Button>
              </div>
              {sidecarProbeMsg && (
                <p
                  className={`mt-1 text-[10px] ${
                    sidecarProbeMsg.ok ? 'text-success' : 'text-danger'
                  }`}
                >
                  测试{sidecarProbeMsg.ok ? '通过' : '失败'}：{sidecarProbeMsg.detail}
                </p>
              )}
            </Section>

            {/* backlog #26（2026-10-03）：网盘聚合（OpenList / WebDAV） */}
            <Section title="网盘聚合（OpenList / WebDAV，可选）">
              <TextRow
                label="WebDAV 端点地址"
                value={netdiskUrl}
                onChange={(v) => {
                  setNetdiskUrl(v)
                  setNetdiskProbeMsg(null)
                  // 审查修复（P3-4）：端点变更后旧浏览状态失效——残留会让用户把
                  // 旧服务的目录/错误当成新服务的结果
                  setNetdiskBrowse(false)
                  setNetdiskEntries([])
                  setNetdiskError('')
                  setNetdiskSel(new Set())
                }}
                mono
                hint="自托管 OpenList（AList 分叉）等网盘聚合服务的 WebDAV 出口，示例 http://127.0.0.1:5240/dav；留空 = 禁用"
              />
              <p className="mt-1 text-[10px] leading-relaxed text-text-3">
                不内置任何网盘协议：仅消费你自托管服务的标准 WebDAV 出口；凭据经系统安全存储加密保存，不写入日志
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    window.omniget
                      .settingsSet('netdisk.endpoint', netdiskUrl.trim())
                      .then(() => flash('网盘端点已保存'))
                      .catch((err) => toastError('保存网盘端点', err))
                  }}
                >
                  保存
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={netdiskProbing || !netdiskUrl.trim()}
                  onClick={() => {
                    setNetdiskProbing(true)
                    setNetdiskProbeMsg(null)
                    window.omniget
                      .netdiskProbe()
                      .then((r) => setNetdiskProbeMsg(r))
                      .catch((err) => toastError('测试网盘连接', err))
                      .finally(() => setNetdiskProbing(false))
                  }}
                >
                  {netdiskProbing ? '测试中…' : '测试连接'}
                </Button>
              </div>
              {netdiskProbeMsg && (
                <p
                  className={`mt-1 text-[10px] ${
                    netdiskProbeMsg.ok ? 'text-success' : 'text-danger'
                  }`}
                >
                  测试{netdiskProbeMsg.ok ? '通过' : '失败'}：{netdiskProbeMsg.detail}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  value={netdiskUser}
                  onChange={(e) => setNetdiskUser(e.target.value)}
                  placeholder="WebDAV 用户名"
                  autoComplete="off"
                  className="h-8 w-40 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
                />
                <input
                  value={netdiskPass}
                  onChange={(e) => setNetdiskPass(e.target.value)}
                  placeholder="WebDAV 密码"
                  type="password"
                  autoComplete="new-password"
                  className="h-8 w-40 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
                />
                <Button
                  size="sm"
                  disabled={!netdiskUser.trim() || netdiskCredBusy}
                  onClick={() => {
                    setNetdiskCredBusy(true)
                    window.omniget
                      .netdiskSaveCreds({ username: netdiskUser.trim(), password: netdiskPass })
                      .then((r) => {
                        if (r.ok) {
                          // 仅成功清空密码框（失败正是最需要重试的场景）；
                          // 端点/凭据变更后旧浏览状态失效，一并重置
                          setNetdiskPass('')
                          // 第十轮审查 P3：不谎称「加密存储」——netdisk 侧暂无
                          // storageInfo 回显，safeStorage 降级明文时此前文案失实
                          flash('WebDAV 凭据已保存')
                          setNetdiskBrowse(false)
                          setNetdiskEntries([])
                          setNetdiskError('')
                          setNetdiskSel(new Set())
                        }
                        setNetdiskProbeMsg(r)
                      })
                      .catch((err) => toastError('保存 WebDAV 凭据', err))
                      .finally(() => setNetdiskCredBusy(false))
                  }}
                >
                  {netdiskCredBusy ? '保存中…' : '保存凭据'}
                </Button>
              </div>
              <p className="mt-1 text-[10px] text-text-3">
                凭据保存后立即自动测试连接；匿名访问可填用户名 guest、密码留空
              </p>

              {/* 目录浏览 + 提交下载 */}
              <div className="mt-3 border-t border-border pt-3">
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={netdiskToggleBrowse}>
                    {netdiskBrowse ? '收起目录' : '浏览目录'}
                  </Button>
                  <span className="num min-w-0 flex-1 truncate text-[10px] text-text-3">
                    {netdiskPath}
                    {netdiskLoading ? ' · 加载中…' : ''}
                  </span>
                </div>
                {netdiskBrowse && (
                  <>
                    {netdiskError && (
                      <p className="mt-2 text-[10px] text-danger">{netdiskError}</p>
                    )}
                    <div className="mt-2 max-h-56 overflow-y-auto rounded-panel border border-border">
                      {netdiskPath !== '/' && (
                        <button
                          className="row-line flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-2 hover:bg-surface-2"
                          onClick={() => netdiskNav(netdiskPath.replace(/\/[^/]+\/?$/, '') || '/')}
                        >
                          <span className="text-text-3">↩</span> 返回上级
                        </button>
                      )}
                      {netdiskEntries.map((e) => (
                        <div
                          key={`${e.path}${e.name}`}
                          className="row-line flex items-center gap-2 px-3 py-1.5 text-xs"
                        >
                          {e.isDir ? (
                            <button
                              className="press min-w-0 flex-1 truncate text-left text-text-2 hover:text-text-1"
                              onClick={() => netdiskNav(e.path)}
                            >
                              <span className="text-text-3">▸</span> {e.name}
                            </button>
                          ) : (
                            <>
                              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={netdiskSel.has(e.path)}
                                  onChange={(ev) => {
                                    const next = new Set(netdiskSel)
                                    if (ev.target.checked) next.add(e.path)
                                    else next.delete(e.path)
                                    setNetdiskSel(next)
                                  }}
                                />
                                <span className="min-w-0 flex-1 truncate text-text-2">{e.name}</span>
                              </label>
                              <span className="num shrink-0 text-[10px] text-text-3">
                                {fmtNetdiskSize(e.size)}
                              </span>
                            </>
                          )}
                        </div>
                      ))}
                      {!netdiskLoading && netdiskEntries.length === 0 && (
                        <p className="px-3 py-3 text-[11px] text-text-3">目录为空</p>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        value={netdiskSaveDir}
                        onChange={(e) => setNetdiskSaveDir(e.target.value)}
                        className="num h-8 min-w-0 flex-1 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
                        placeholder="保存目录"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        icon={<FolderOpen size={13} />}
                        onClick={() =>
                          void window.omniget
                            .pickFolder()
                            .then((dir) => {
                              if (dir) setNetdiskSaveDir(dir)
                            })
                            .catch((err) => toastError('选择文件夹', err))
                        }
                      >
                        浏览
                      </Button>
                      <Button
                        size="sm"
                        disabled={netdiskDownloading || netdiskSel.size === 0}
                        onClick={netdiskDownloadSelected}
                      >
                        {netdiskDownloading ? '提交中…' : `下载所选（${netdiskSel.size}）`}
                      </Button>
                    </div>
                    <p className="mt-1 text-[10px] leading-relaxed text-text-3">
                      勾选文件提交下载：经 aria2 分片直下（认证自动注入）；目录仅用于浏览导航。单次最多 50 个文件
                    </p>
                  </>
                )}
              </div>
            </Section>

            {/* R2/R7：队列与归档 */}
            <Section title="队列与归档">
              <div className="mb-3">
                <label className="mb-1 block text-xs text-text-2">最大同时下载数（0 = 不限）</label>
                <input
                  value={maxConcurrent}
                  onChange={(e) => setMaxConcurrent(e.target.value.replace(/[^\d]/g, ''))}
                  className="num h-8 w-28 rounded-ctl border border-border bg-surface-2 px-3 text-xs outline-none focus:border-accent"
                />
                <p className="mt-1 text-[10px] leading-relaxed text-text-3">
                  超出上限的新任务自动排队（FIFO），任一任务完成/失败/暂停后按顺序自动启动；音乐与工具箱任务有各自独立的并发限制
                </p>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-text-2">
                <input
                  type="checkbox"
                  checked={autoArchive}
                  onChange={(e) => setAutoArchive(e.target.checked)}
                />
                按类型自动归档到子目录（视频 / 音乐）
              </label>
              <p className="mt-1 text-[10px] leading-relaxed text-text-3">
                开启后新建视频任务落至「保存目录/视频」，直链媒体按扩展名归类；BT/磁力保持原目录结构
              </p>
              {/* R7 续（backlog #22）：已下载去重 */}
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-text-2">
                <input
                  type="checkbox"
                  checked={dedupe}
                  onChange={(e) => setDedupe(e.target.checked)}
                />
                已下载去重（相同内容不再重复下载）
              </label>
              <p className="mt-1 text-[10px] leading-relaxed text-text-3">
                单视频命中下载档案即拒绝创建；合集内条目由 yt-dlp 档案自动跳过。订阅追更依赖此项
              </p>
              {/* R7 续（backlog #19）：yt-dlp 外部下载器 aria2c */}
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-text-2">
                <input
                  type="checkbox"
                  checked={ytdlpAria2c}
                  onChange={(e) => setYtdlpAria2c(e.target.checked)}
                />
                yt-dlp 使用 aria2c 外部下载器加速（实验）
              </label>
              <p className="mt-1 text-[10px] leading-relaxed text-text-3">
                直链格式 8 连接分段下载；分段/HLS 流不受影响。引擎未就绪时自动回落 yt-dlp 内置下载器
              </p>
              {/* P2 修复：本分区此前没有保存入口（唯一保存按钮在上方"目录与凭据"分区） */}
              <Button
                size="sm"
                className="mt-3"
                onClick={() => {
                  Promise.all([
                    window.omniget.settingsSet('download.maxConcurrent', Number(maxConcurrent) || 0),
                    window.omniget.settingsSet('download.autoArchive', autoArchive),
                    window.omniget.settingsSet('download.dedupe', dedupe),
                    window.omniget.settingsSet('download.ytdlpAria2c', ytdlpAria2c)
                  ])
                    .then(() => flash('队列与归档设置已保存'))
                    .catch((err) => toastError('保存队列设置', err))
                }}
              >
                保存
              </Button>
            </Section>

            {/* 四期（0.11.x）：内容库入库钩子——OpenSubtitles 字幕自动匹配 + NFO 导出 */}
            <Section title="内容库入库钩子（可选）">
              <p className="mb-2 text-[10px] leading-relaxed text-text-3">
                视频下载完成入库后自动执行：字幕按文件哈希在 OpenSubtitles
                内容级精确匹配并落盘视频旁；NFO/海报（Jellyfin/Emby 方言）落视频同目录。
                配合「按类型自动归档」的目录结构可被媒体服务器直接扫描
              </p>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-text-2">
                <input
                  type="checkbox"
                  checked={subtitleHook}
                  onChange={(e) => {
                    const next = e.target.checked
                    setSubtitleHook(next)
                    window.omniget
                      .settingsSet('video.subtitleHook', next)
                      .then(() => flash('字幕自动匹配设置已保存'))
                      .catch((err) => {
                        setSubtitleHook(!next)
                        toastError('保存字幕自动匹配设置', err)
                      })
                  }}
                />
                自动匹配字幕（OpenSubtitles，需配置 API Key）
              </label>
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-text-2">
                <input
                  type="checkbox"
                  checked={nfoExport}
                  onChange={(e) => {
                    const next = e.target.checked
                    setNfoExport(next)
                    window.omniget
                      .settingsSet('video.nfoExport', next)
                      .then(() => flash('NFO 导出设置已保存'))
                      .catch((err) => {
                        setNfoExport(!next)
                        toastError('保存 NFO 导出设置', err)
                      })
                  }}
                />
                自动导出 NFO 与海报（Jellyfin / Emby）
              </label>
              <div className="mt-3 border-t border-border pt-3">
                <p className="num text-[10px] text-text-3">
                  OpenSubtitles API Key：
                  {osInfo?.hasKey
                    ? `已配置（${osInfo.encrypted ? '加密存储' : '明文降级：系统安全存储不可用'}，不回显）`
                    : '未配置'}
                </p>
                <p className="mt-1 text-[10px] text-text-3">
                  api.opensubtitles.com 免费注册获取；Key 经系统安全存储加密保存，不写入日志。
                  免费账号每日查询/下载配额有限
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    value={osKey}
                    onChange={(e) => setOsKey(e.target.value)}
                    placeholder="OpenSubtitles API Key"
                    type="password"
                    autoComplete="new-password"
                    className="h-8 w-64 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
                  />
                  <Button
                    size="sm"
                    disabled={!osKey.trim() || osBusy}
                    onClick={() => {
                      setOsBusy(true)
                      window.omniget
                        .opensubtitlesSaveKey(osKey.trim())
                        .then(() => {
                          setOsKey('')
                          // 审查修复：刷新存储形态——safeStorage 降级明文时不得谎称加密
                          return window.omniget.opensubtitlesStatus()
                        })
                        .then((s) => {
                          setOsInfo(s)
                          flash(
                            `OpenSubtitles API Key 已保存${s.encrypted ? '（加密存储）' : ''}`
                          )
                        })
                        .catch((err) => toastError('保存 OpenSubtitles API Key', err))
                        .finally(() => setOsBusy(false))
                    }}
                  >
                    {osBusy ? '保存中…' : '保存 Key'}
                  </Button>
                  <input
                    value={subtitleLangs}
                    onChange={(e) => setSubtitleLangs(e.target.value)}
                    placeholder="字幕语言（如 zh,en）"
                    className="h-8 w-40 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      // 审查修复：保存前同口径校验——此前 `Chinese` 落库成功但消费端
                      // 静默回退 zh，UI 值与实际行为脱节
                      const v = subtitleLangs.trim() || 'zh'
                      if (!/^[a-z]{2,3}(,[a-z]{2,3})*$/i.test(v)) {
                        toast('字幕语言格式应为两/三字母语言代码，如 zh 或 zh,en', 'warning')
                        return
                      }
                      window.omniget
                        .settingsSet('video.subtitleLanguages', v)
                        .then(() => flash('字幕语言偏好已保存'))
                        .catch((err) => toastError('保存字幕语言偏好', err))
                    }}
                  >
                    保存语言
                  </Button>
                </div>
              </div>
            </Section>

            {/* R7 续（backlog #18）：订阅追更 */}
            <Section title="订阅追更">
              {subs.length === 0 && (
                <p className="mb-2 text-[10px] text-text-3">
                  尚无订阅。添加频道 / UP主 / 歌单链接后，将按间隔自动抓取新内容并入队下载
                </p>
              )}
              {subs.map((s) => (
                <div key={s.id} className="mb-2 rounded-panel border border-border p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-text-1">{s.name}</p>
                      <p className="num truncate text-[10px] text-text-3">{s.url}</p>
                      <p className="mt-0.5 text-[10px] text-text-3">
                        {s.sourceKind === 'rss' ? 'RSS' : 'yt-dlp'} · 每 {s.intervalMin} 分钟检查 ·
                        累计 {s.addedTotal} 条
                        {s.lastCheckedAt
                          ? ` · 上次 ${new Date(s.lastCheckedAt).toLocaleString()}`
                          : ' · 未检查'}
                        {s.saveDir && ` · 独立目录`}
                        {(s.presetId != null || s.template || s.filterMinSec > 0 || s.filterKeywords) &&
                          ' · 自定义参数'}
                        {s.filterMinSec > 0 && ` · ≥${s.filterMinSec}s`}
                        {s.filterKeywords && ` · 关键词:${s.filterKeywords}`}
                        {s.lastError && <span className="text-danger"> · {s.lastError}</span>}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => startEditSub(s)}>
                        {subEditingId === s.id ? '编辑中' : '编辑'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={subBusyId === s.id}
                        onClick={() => {
                          setSubBusyId(s.id)
                          window.omniget
                            .subscribeCheckNow(s.id)
                            // 第七轮审查 P2：成功反馈改全局 toast——flash 横幅渲染在
                            // 页面顶部，订阅分区滚动位置深时用户完全无感知
                            .then((r) =>
                              toast(r.added > 0 ? `已新增 ${r.added} 个任务` : '暂无新内容', 'success')
                            )
                            .catch((err) => toastError('检查订阅', err))
                            .finally(() => setSubBusyId(null))
                        }}
                      >
                        立即检查
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          // UX 硬性标准：删除类操作必须二次确认（此前一击即删且不可恢复）
                          void confirmAction({
                            title: '删除订阅',
                            message: `确定删除订阅「${s.name}」吗？其去重档案与自动追更将一并停止。`,
                            confirmLabel: '删除',
                            danger: true
                          }).then((ok) => {
                            if (!ok) return
                            window.omniget
                              .subscribeRemove(s.id)
                              .then(() => {
                                setSubs(subs.filter((x) => x.id !== s.id))
                                // 审查修复：删除的若是正在编辑的条目，表单复位（否则
                                // 表单停在已删条目上，保存时报「订阅不存在」）
                                if (subEditingId === s.id) resetSubForm()
                                flash('订阅已删除')
                              })
                              .catch((err) => toastError('删除订阅', err))
                          })
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  value={subName}
                  onChange={(e) => setSubName(e.target.value)}
                  placeholder="名称"
                  className="h-8 w-32 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
                />
                <select
                  value={subKind}
                  onChange={(e) => setSubKind(e.target.value === 'rss' ? 'rss' : 'ytdlp')}
                  className="h-8 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
                >
                  <option value="ytdlp">频道/合集</option>
                  <option value="rss">RSS 订阅</option>
                </select>
                <input
                  value={subUrl}
                  onChange={(e) => setSubUrl(e.target.value)}
                  placeholder={subKind === 'rss' ? 'RSS / Atom 订阅地址' : '频道 / 合集 / 歌单链接'}
                  className="num h-8 min-w-0 flex-1 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
                />
                <select
                  value={subInterval}
                  onChange={(e) => setSubInterval(e.target.value)}
                  className="h-8 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
                >
                  <option value="60">每小时</option>
                  <option value="360">每 6 小时</option>
                  <option value="720">每 12 小时</option>
                  <option value="1440">每天</option>
                </select>
              </div>
              {/* 三期：每源参数（保存目录/预设/模板）与条目过滤（时长/关键词） */}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  value={subSaveDir}
                  onChange={(e) => setSubSaveDir(e.target.value)}
                  placeholder="保存目录（留空 = 全局下载目录）"
                  className="num h-8 min-w-0 flex-1 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
                />
                <select
                  value={subPresetId}
                  onChange={(e) => setSubPresetId(e.target.value)}
                  className="h-8 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
                >
                  <option value="">默认参数</option>
                  {videoPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      预设：{p.name}
                    </option>
                  ))}
                </select>
                <input
                  value={subTemplate}
                  onChange={(e) => setSubTemplate(e.target.value)}
                  placeholder="命名模板（留空 = 全局）"
                  className="h-8 w-48 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
                />
                <input
                  value={subMinSec}
                  onChange={(e) => setSubMinSec(e.target.value)}
                  placeholder="最短秒数"
                  className="num h-8 w-24 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
                />
                <input
                  value={subKeywords}
                  onChange={(e) => setSubKeywords(e.target.value)}
                  placeholder="标题关键词过滤（逗号分隔，任一命中）"
                  className="h-8 min-w-0 flex-1 rounded-ctl border border-border bg-surface-2 px-2 text-xs outline-none focus:border-accent"
                />
                {subEditingId ? (
                  <>
                    <Button
                      size="sm"
                      disabled={subAdding || !subName.trim() || !subUrl.trim()}
                      onClick={() => {
                        // UX 硬性标准：编辑保存失败必须可见反馈
                        setSubAdding(true)
                        window.omniget
                          .subscribeUpdate({ id: subEditingId, ...subPayload() })
                          .then((s) => {
                            setSubs(subs.map((x) => (x.id === s.id ? s : x)))
                            resetSubForm()
                            flash('订阅已更新')
                          })
                          .catch((err) => toastError('更新订阅', err))
                          .finally(() => setSubAdding(false))
                      }}
                    >
                      {subAdding ? '保存中…' : '保存修改'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={resetSubForm}>
                      取消
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    disabled={subAdding || !subName.trim() || !subUrl.trim()}
                    onClick={() => {
                      // 审查修复（P3-5）：防重入——双击此前会重复登记订阅
                      setSubAdding(true)
                      window.omniget
                        .subscribeAdd(subPayload())
                        .then((s) => {
                          setSubs([...subs, s])
                          resetSubForm()
                          flash('订阅已添加')
                        })
                        .catch((err) => toastError('添加订阅', err))
                        .finally(() => setSubAdding(false))
                    }}
                  >
                    {subAdding ? '添加中…' : '添加'}
                  </Button>
                )}
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-text-3">
                新内容自动入队（单次最多 20 条，去重档案防重复）；每源可指定保存目录、参数预设与命名模板，条目可按时长/关键词过滤；RSS
                条目不支持时长过滤
              </p>
            </Section>

            <Section title="定时限速 / 停运计划（合并编排）">
              {rules.map((r, i) => {
                const isPause = r.mode === 'pause'
                const days = r.days ?? []
                const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']
                return (
                <div key={i} className="mb-2">
                  <div className="flex items-center gap-2">
                    <select
                      value={r.mode ?? 'limit'}
                      onChange={(e) =>
                        setRules(
                          rules.map((x, j) =>
                            j === i
                              ? { ...x, mode: e.target.value as 'limit' | 'pause' }
                              : x
                          )
                        )
                      }
                      className="h-7 rounded-ctl border border-border bg-surface-2 px-1 text-xs"
                    >
                      <option value="limit">限速</option>
                      <option value="pause">停运</option>
                    </select>
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
                      value={isPause ? '—' : r.limit}
                      disabled={isPause}
                      onChange={(e) =>
                        setRules(rules.map((x, j) => (j === i ? { ...x, limit: e.target.value } : x)))
                      }
                      className="num h-7 w-24 rounded-ctl border border-border bg-surface-2 px-2 text-xs disabled:opacity-40"
                    />
                    <Button
                      size="xs"
                      variant="danger"
                      icon={<Trash size={11} />}
                      onClick={() => {
                        setRules(rules.filter((_, j) => j !== i))
                        flash('时段已移除（点「保存计划」生效）')
                      }}
                    >
                      删除
                    </Button>
                  </div>
                  <div className="mt-1 flex items-center gap-1 pl-1">
                    {DAY_LABELS.map((lbl, d) => (
                      <button
                        key={d}
                        className={
                          'press h-5 w-5 rounded-ctl border text-[10px] ' +
                          (days.includes(d)
                            ? 'border-accent bg-accent/20 text-accent'
                            : 'border-border bg-surface-2 text-text-3')
                        }
                        title={(days.length === 0 ? '每天（默认）· ' : '') + `周${lbl}`}
                        onClick={() =>
                          setRules(
                            rules.map((x, j) => {
                              if (j !== i) return x
                              const cur = x.days ?? []
                              const next = cur.includes(d)
                                ? cur.filter((v) => v !== d)
                                : [...cur, d].sort((a, b) => a - b)
                              return { ...x, days: next }
                            })
                          )
                        }
                      >
                        {lbl}
                      </button>
                    ))}
                    <span className="ml-1 text-[10px] text-text-3">
                      {days.length === 0 ? '每天' : `周${days.map((d) => DAY_LABELS[d]).join('、')}`}
                    </span>
                  </div>
                </div>
                )
              })}
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
                  variant="outline"
                  onClick={() =>
                    setRules([...rules, { from: '01:00', to: '07:00', limit: '0', mode: 'pause' as const }])
                  }
                >
                  + 添加停运窗口
                </Button>
                <Button
                  size="xs"
                  disabled={scheduleSaving}
                  onClick={() => {
                    // 第六轮审查：规则加载失败时 rules 是空数组——落盘即清空全部
                    // 调度计划，写前守卫阻断
                    if (rulesLoadFailedRef.current) {
                      toastError('保存调度计划', new Error('计划规则未能加载，保存会清空现有调度，请刷新页面后重试'))
                      return
                    }
                    // R4-P3：前端预校验时段格式（主进程 sanitize 会静默丢弃非法行，
                    // 用户无感知；此处显式提示）。停运窗口不消费限速档，限速校验豁免；
                    // 限速档格式与主进程 LIMIT_RE 同口径（1G/2Mb 等会被静默丢行，审查 P3-7）
                    const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/
                    const LIMIT_RE = /^\d{1,7}[KM]?$/i
                    const bad = rules.find(
                      (r) =>
                        !TIME_RE.test(r.from) ||
                        !TIME_RE.test(r.to) ||
                        (r.mode !== 'pause' && !LIMIT_RE.test(r.limit.trim()))
                    )
                    if (bad) {
                      toastError('保存调度计划', new Error('存在格式非法的时段（时间应为 HH:MM，限速为数字 + 可选 K/M 单位，如 2M、500K），请修正后保存'))
                      return
                    }
                    setScheduleSaving(true)
                    window.omniget
                      .setScheduleRules(rules)
                      .then(() => flash('调度计划已保存（切换即时生效）'))
                      .catch((err) => toastError('保存调度计划', err))
                      .finally(() => setScheduleSaving(false))
                  }}
                >
                  保存计划
                </Button>
              </div>
              <p className="mt-1.5 text-[10px] text-text-3">
                限速格式同 aria2（2M、500K、0=不限）；支持跨天时段（22:00–06:00）与星期几（缺省每天），每分钟自动切换。
                停运窗口内新任务保持排队、运行中任务自动暂停，窗口结束统一恢复（仅恢复窗口内被自动暂停的任务）。
              </p>
            </Section>
          </>
        )}

        {/* ── 远程 / 扩展（R1+R5：本地桥接）─────────────────────────── */}
        {tab === 'remote' && (
          <Section title="远程访问 / 浏览器扩展">
            <p className="mb-3 text-[11px] leading-relaxed text-text-3">
              本地桥接服务已随应用启动（仅绑定 127.0.0.1 回环，令牌鉴权）。Web
              面板可在同机浏览器打开；浏览器扩展用于右键发送链接或接管浏览器下载。
            </p>
            {bridgeInfo?.running ? (
              <>
                <div className="mb-3 space-y-1 rounded-panel border border-border bg-surface-2/40 px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-text-3">Web 面板</span>
                    <span
                      className="num min-w-0 flex-1 truncate text-text-2"
                      title={`http://127.0.0.1:${bridgeInfo.port}/?token=${bridgeInfo.token}`}
                    >
                      http://127.0.0.1:{bridgeInfo.port}/?token={bridgeInfo.token}
                    </span>
                    <button
                      className="press shrink-0 text-[10px] text-accent hover:underline"
                      onClick={() =>
                        window.open(
                          `http://127.0.0.1:${bridgeInfo.port}/?token=${bridgeInfo.token}`,
                          '_blank',
                          'noopener'
                        )
                      }
                    >
                      打开
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-text-3">端口</span>
                    <span className="num text-text-2">{bridgeInfo.port}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-text-3">令牌</span>
                    <span className="num min-w-0 flex-1 truncate text-text-2" title={bridgeInfo.token}>
                      {bridgeInfo.token}
                    </span>
                  </div>
                </div>
                {/* ── 五期（0.12.x）：局域网远程访问（opt-in，令牌鉴权全端点强制）── */}
                <div className="mb-3 rounded-panel border border-border bg-surface-2/40 px-3 py-2 text-xs">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={bridgeLan}
                      disabled={bridgeLanBusy}
                      onChange={(e) => {
                        const on = e.target.checked
                        setBridgeLanBusy(true)
                        window.omniget
                          .toggleBridgeLan(on)
                          .then(() => {
                            setBridgeLan(on)
                            flash(
                              on ? '局域网访问已开启（桥接服务已重启）' : '局域网访问已关闭，仅本机可访问'
                            )
                            // 信息刷新失败不影响开关状态回显（审查 P1-2：此前
                            // getBridgeInfo 失败会把已生效的开关重置成相反态）
                            return window.omniget.getBridgeInfo().catch(() => undefined)
                          })
                          .then((info) => {
                            if (info) setBridgeInfo(info)
                          })
                          .catch((err) => {
                            // toggle IPC 本身失败（重启桥接失败已回滚设置）→ 回显真实态
                            setBridgeLan(!on)
                            toastError('切换局域网访问', err)
                          })
                          .finally(() => setBridgeLanBusy(false))
                      }}
                    />
                    <span className="text-text-2">允许局域网设备访问 Web 面板（手机/平板远程提交与管理任务）</span>
                  </label>
                  {bridgeLan && bridgeInfo?.running ? (
                    <div className="mt-1.5 space-y-0.5 pl-6 text-[11px] text-text-3">
                      <p>
                        局域网地址（携带令牌访问）：
                        {bridgeInfo.lanAddresses.length === 0 ? (
                          <span className="text-warning">未检测到局域网网卡地址</span>
                        ) : (
                          bridgeInfo.lanAddresses.map((ip) => (
                            <span key={ip} className="num mr-2 text-text-2">
                              http://{ip}:{bridgeInfo.port}/?token={bridgeInfo.token}
                            </span>
                          ))
                        )}
                      </p>
                      <p className="text-[10px]">注意：开启后同一局域网内的任何设备均可达本端口，务必保管好上方令牌。</p>
                    </div>
                  ) : null}
                </div>
                <div className="space-y-1 text-[11px] leading-relaxed text-text-3">
                  <p>
                    <span className="text-text-2">浏览器扩展安装</span>
                    （Chrome/Edge/Firefox，MV3）：1) 打开浏览器扩展管理页并开启「开发者模式」；2)
                    「加载已解压的扩展程序」选择应用目录下的{' '}
                    <span className="num">resources/extension</span>；3) 在扩展弹窗中填入上方端口与令牌。
                  </p>
                  <p>
                    扩展能力：右键链接「用 OmniGet 下载」；开启「自动拦截」后浏览器新建下载会被取消并转发到
                    OmniGet（含查重与秒校验）。
                  </p>
                </div>
              </>
            ) : (
              <p className="text-xs text-text-3">桥接服务未就绪（重启应用后重试）</p>
            )}
          </Section>
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
              订阅源：ngosang/trackerslist 每日最佳（每日自动刷新）；刷新失败自动降级使用本地缓存；手动条目随任务注入
            </p>

            {/* R7 P0：BT 网络加速（可连接性 = BT 速度第一影响因素） */}
            <div className="mt-4 border-t border-border pt-3">
              <p className="mb-2 text-xs font-medium text-text-2">BT 网络加速</p>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-text-2">
                <input
                  type="checkbox"
                  checked={upnp}
                  onChange={(e) => setUpnp(e.target.checked)}
                />
                UPnP / NAT-PMP 自动端口映射（TCP {`6881`} 数据 + UDP {`6881`} DHT）
              </label>
              <p className="mt-1 text-[10px] leading-relaxed text-text-3">
                在路由器上自动创建端口映射，允许外部 peer 主动连入（可连接性决定 BT/磁力速度）；路由器不支持时静默降级。修改后重启应用生效
              </p>
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-text-2">
                <input
                  type="checkbox"
                  checked={btEncrypt}
                  onChange={(e) => setBtEncrypt(e.target.checked)}
                />
                BT 消息加密（绕运营商 QoS 限速/干扰）
              </label>
              <p className="mt-1 text-[10px] leading-relaxed text-text-3">
                arc4 加密握手，绕运营商 BT QoS 限速/干扰；注意：开启后个别仅支持明文握手的 peer
                会拒绝连接（关闭可恢复兼容，但流量可能被识别限速）。修改后重启应用生效
              </p>
              <Button
                size="sm"
                className="mt-3"
                onClick={() => {
                  Promise.all([
                    window.omniget.settingsSet('bt.upnp', upnp),
                    window.omniget.settingsSet('bt.forceEncryption', btEncrypt)
                  ])
                    // 第十轮审查 P3：两项均在启动期消费（UPnP 映射 / 引擎启动参数），
                    // 保存 toast 必须提示重启生效
                    .then(() => flash('BT 网络加速设置已保存（重启应用后生效）'))
                    .catch((err) => toastError('保存 BT 网络设置', err))
                }}
              >
                保存
              </Button>
            </div>

            {/* BT 端口连通性自检（#5） */}
            <div className="mt-4 border-t border-border pt-3">
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={btDiag === 'checking'}
                  onClick={() => {
                    setBtDiag('checking')
                    void window.omniget
                      .diagBtPort()
                      .then((r) => {
                        setBtDiag(r.listening ? 'listening' : 'not-listening')
                        setBtDiagPort(r.port)
                        setNatDiag(r.nat)
                      })
                      .catch(() => setBtDiag('error'))
                  }}
                >
                  BT 端口自检
                </Button>
                <span className="text-[10px] text-text-3">
                  {btDiag === 'listening' && `✓ ${btDiagPort ?? 6881} 端口监听正常`}
                  {btDiag === 'not-listening' &&
                    `✗ ${btDiagPort ?? 6881} 端口未监听——aria2 可能未就绪，请稍后重试`}
                  {btDiag === 'error' && '自检失败'}
                  {btDiag === 'checking' && '检测中…'}
                  {btDiag === null && '检测 aria2 BT 端口监听状态'}
                </span>
              </div>
              <p className="mt-1 text-[10px] text-text-3">
                提示：本地监听正常 ≠ 外网可达。BT 提速请在路由器/防火墙放行 <span className="num">6881</span> 端口（TCP+UDP）。
              </p>
              {natDiag && (
                <p className="mt-1 text-[10px] text-text-3">
                  {natDiag.attempted
                    ? natDiag.ok
                      ? '✓ UPnP/NAT-PMP 端口映射生效（外部 peer 可主动连入）'
                      : `UPnP/NAT-PMP 映射未生效${natDiag.error ? `：${natDiag.error}` : ''}（路由器不支持时属常态，BT 仍可用但速度可能受限）`
                    : 'UPnP 端口映射尚未尝试（aria2 未上线或已在上方设置中关闭）'}
                </p>
              )}

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
                        if (scriptBusy) return
                        setScriptBusy(s.id)
                        window.omniget
                          .toggleAdapterScript(s.id, !s.enabled)
                          .then(reloadScripts)
                          .then(() => toast(s.enabled ? '脚本已停用' : '脚本已启用', 'success'))
                          .catch((err) => toastError('切换脚本状态', err))
                          .finally(() => setScriptBusy(null))
                      }}
                    >
                      {s.enabled ? '已启用' : '已停用'}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                icon={<ArrowClockwise size={11} />}
                onClick={() =>
                  void reloadScripts().then(() => toast('适配脚本已重新加载', 'success'))
                }
              >
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
                          if (r.error) flash(r.error, 'warning')
                        })
                        .catch(() => flash('检查失败：网络不可达', 'warning'))
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
                  {appUpdate?.error && <span className="text-xs text-danger">{appUpdate.error}</span>}
                </div>
                {appUpdate?.hasUpdate && (
                  <div className="mb-3">
                    <Button
                      size="sm"
                      onClick={() =>
                        void window.omniget
                          .openReleases()
                          .catch((err) => toastError('打开发布页', err))
                      }
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

            {/* R6：引擎按需下载管理 */}
            <div className="mb-4 rounded-panel border border-border p-3">
              <p className="mb-2 text-xs font-medium text-text-1">引擎管理（按需下载）</p>
              <div className="mb-2 space-y-1">
                {engineList.length === 0 && !engineLoadFailed && (
                  <p className="text-[11px] text-text-3">引擎状态加载中…</p>
                )}
                {engineList.length === 0 && engineLoadFailed && (
                  <p className="text-[11px] text-warning">
                    引擎状态加载失败——可尝试「立即补齐」，反复出现请到「帮助 → 诊断」查看日志
                  </p>
                )}
                {engineList.map((e) => (
                  <div key={e.name} className="flex items-center gap-2 text-[11px]">
                    <span
                      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                        e.installed ? 'bg-success' : 'bg-warning'
                      }`}
                    />
                    <span className="num w-16 shrink-0 text-text-2">{e.name}</span>
                    <span className="num flex-1 text-text-3">
                      {e.installed ? `已安装（${((e.size ?? 0) / 1024 / 1024).toFixed(1)} MB）` : '缺失——将从分发源按需下载'}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mb-2 flex items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={engineFetching}
                  onClick={fetchEnginesNow}
                >
                  {engineFetching ? '补齐中…' : '补齐缺失引擎'}
                </Button>
                <span className="min-w-0 flex-1 truncate text-[10px] text-text-3">
                  下载经 SHA256 校验后原子安装，并自动登记 TOFU 指纹
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={engineMirror}
                  onChange={(e) => setEngineMirror(e.target.value)}
                  placeholder="分发源（默认 GitHub Releases，可指向自建镜像）"
                  className="num h-7 min-w-0 flex-1 rounded-ctl border border-border bg-surface-2 px-2 text-[10px] outline-none focus:border-accent"
                />
                <Button size="xs" variant="ghost" onClick={saveEngineMirror}>
                  保存分发源
                </Button>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-text-3">
                目录约定：<span className="num">{engineMirror || '默认分发源'}/&lt;platform&gt;-&lt;arch&gt;/</span>{' '}
                下提供 manifest.json（文件名 → SHA256）与各引擎文件；缺失引擎会在启动时自动补齐
              </p>
            </div>
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
                void window.omniget
                  .engineUpdate('ytdlp')
                  .then((r) =>
                    flash(
                      r?.ok
                        ? `yt-dlp 已更新至 ${r.version ?? '最新版'}`
                        : `更新失败：${r?.error ?? '未知错误'}`,
                      r?.ok ? 'success' : 'warning'
                    )
                  )
                  .catch(() => flash('更新失败：无法连接更新服务，请检查网络', 'warning'))
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
                <span className="num">v<AppVersionLabel /></span> · Electron 33 · React 18 · aria2c
                1.37 · yt-dlp 2026.08.19 · ffmpeg 9.0
              </p>
            </div>
          </Section>
        )}
      </div>
    </main>
  )
}
