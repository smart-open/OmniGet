// 全局布局（§7.4 信息架构）：72px 侧边导航 + 玻璃顶栏 + 任务工作区 + 状态栏。
// 图标一律 Phosphor（§7.2 禁 emoji）；主题切换持久化（settings）。

import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ChartBar,
  CheckCircle,
  DownloadSimple,
  GearSix,
  MagnifyingGlass,
  Magnet,
  Minus,
  MonitorPlay,
  MusicNote,
  Palette,
  Books,
  Plus,
  Pulse,
  Square,
  Trash,
  Tray,
  WarningCircle,
  Wrench,
  X
} from '@phosphor-icons/react'
import { useTasks, wireTaskEvents } from '../stores/tasks'
import type { ToolEvent } from '@shared/types'
import logoUrl from '../assets/logo.png'
import { THEMES, applyTheme, parseStoredTheme, watchSystemTheme, type ThemeId } from '../theme'
import { initLocale, useI18n } from '../i18n'
import { TaskList } from '../features/tasks/TaskList'
import { NewTaskDialog } from '../features/new-task/NewTaskDialog'
import { MusicWorkbench } from '../features/music/MusicWorkbench'
// 四期（0.11.x）：统一内容库（音乐 + 视频汇合视图，roadmap「统一媒体库」）
import { MediaLibrary } from '../features/library/MediaLibrary'
import { SettingsPage } from '../features/settings/SettingsPage'
import { StatsPage } from '../features/stats/StatsPage'
import { ToolboxPage } from '../features/toolbox/ToolboxPage'
import { HelpOverlay } from '../features/help/HelpOverlay'
import { Onboarding } from '../features/onboarding/Onboarding'
import { SpeedSparkline, IconButton, ConfirmDialog } from '../components/ui'
import { toast, useToasts, confirmAction, isConfirmActive, toastError, dismissToast } from '../lib/feedback'
import { isAnyModalOpen } from '../lib/modalGate'
import {
  effectiveKeys,
  eventToKey,
  parseKeymap,
  type Keymap,
  type ShortcutAction
} from '../shortcuts'
import { Inspector } from '../features/inspector/Inspector'
import { HealthPage } from '../features/health/HealthPage'
import { formatBytes } from '../features/new-task/fileTree'

interface NavItem {
  id: string
  label: string
  icon: typeof Tray
  badge?: 'running' | 'completed' | 'failed' | 'trash'
}

const NAV_GROUPS: { title?: string; items: NavItem[] }[] = [
  {
    items: [
      { id: 'all', label: '全部', icon: Tray },
      { id: 'downloading', label: '处理中', icon: DownloadSimple, badge: 'running' },
      // R6：失败任务专属视图（红色角标提示用户有任务需要重试）
      { id: 'failed', label: '处理失败', icon: WarningCircle, badge: 'failed' },
      { id: 'completed', label: '处理完成', icon: CheckCircle, badge: 'completed' }
    ]
  },
  {
    title: '分类',
    items: [
      { id: 'bt', label: '种子磁力', icon: Magnet },
      { id: 'video', label: '视频', icon: MonitorPlay },
      { id: 'music', label: '音乐', icon: MusicNote },
      { id: 'health', label: '平台健康', icon: Pulse },
      { id: 'toolbox', label: '工具箱', icon: Wrench }
    ]
  },
  {
    title: '库',
    items: [
      // 四期（0.11.x）：音乐库 + 视频库合并为统一内容视图（分段切换）
      { id: 'library', label: '内容库', icon: Books },
      { id: 'trash', label: '回收站', icon: Trash, badge: 'trash' }
    ]
  }
]

function LogoMark() {
  // 左上角品牌标识：直接使用设计稿 logo.png（深色圆角底 + 蓝色聚合下载箭头）
  return (
    <img
      src={logoUrl}
      width="28"
      height="28"
      alt="OmniGet"
      className="shrink-0 select-none rounded-[7px]"
      draggable={false}
    />
  )
}

export default function App() {
  const t = useI18n((s) => s.t)
  const [active, setActive] = useState('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogSource, setDialogSource] = useState<string | undefined>(undefined)
  const [theme, setTheme] = useState<ThemeId>('system')
  const [themeMenu, setThemeMenu] = useState(false)
  // 快捷键屏蔽经 ref 中转：themeMenu 开合不重挂全局键盘监听（selRef 同款模式）
  const themeMenuRef = useRef(false)
  themeMenuRef.current = themeMenu
  const searchRef = useRef<HTMLInputElement>(null)

  // 第六轮审查：工具完成/失败 toast 上收 App 层——ToolboxPage 的页级监听随卸载
  // 解除，ffmpeg 转码动辄数分钟，用户切走后任务终态完全无感知（反馈硬性标准
  // 在「离开页面」场景落空）
  useEffect(() => {
    const off = window.omniget.onToolEvents((e: ToolEvent) => {
      if (e.status === 'completed') toast('工具任务处理完成', 'success')
      if (e.status === 'failed') toast(`工具任务处理失败：${e.message ?? ''}`, 'warning')
    })
    return off
  }, [])

  const engines = useTasks((s) => s.engines)
  const globalSpeedBps = useTasks((s) => s.globalSpeedBps)
  const speedHistory = useTasks((s) => s.speedHistory)
  // P2 修复：App 不再订阅整个 tasks Map（每个进度批次都会换新 Map 引用，
  // 侧栏/顶栏/状态栏全量重渲染）——只按 id 选取当前选中任务
  const selectedTask = useTasks((s) =>
    s.selectedTaskId ? (s.tasks.get(s.selectedTaskId) ?? null) : null
  )
  const reload = useTasks((s) => s.load)

  useEffect(() => wireTaskEvents(), [])
  // P3 修复：stats/settings/toolbox/health 不是任务过滤器——此前把这些字符串原样
  // 发给主进程 listTasks，既浪费 IPC 又会把 loadedFilter 污染成非任务视图值
  const TASK_FILTERS = ['all', 'downloading', 'completed', 'failed', 'bt', 'video', 'music', 'trash']
  useEffect(() => {
    if (TASK_FILTERS.includes(active)) void reload(active)
  }, [active, reload])
  useEffect(() => initLocale(), [])

  // 主题：恢复 + 应用 + 跟随系统（多主题见 theme.ts）
  useEffect(() => {
    void window.omniget
      .settingsGet('ui.theme')
      .then((v) => {
        const id = parseStoredTheme(v)
        setTheme(id)
        applyTheme(id)
      })
      .catch(() => {
        // R4-P3：启动期读取失败按默认主题继续（此前 unhandledrejection）
        applyTheme('system')
      })
    // P2 修复：设置页改主题时同步侧栏菜单选中态（此前两份独立 state 不互通）
    const onThemeChanged = (e: Event): void => {
      const id = (e as CustomEvent<ThemeId>).detail
      if (id) setTheme(id)
    }
    window.addEventListener('app:theme-changed', onThemeChanged)
    // 审查修复：主进程广播的主题变更（含悬浮窗发起的）经 IPC 桥接同步
    const offTheme = window.omniget.onThemeChanged((id) => setTheme(parseStoredTheme(id)))
    return () => {
      window.removeEventListener('app:theme-changed', onThemeChanged)
      offTheme()
    }
  }, [])
  useEffect(() => watchSystemTheme(theme, () => {}), [theme])
  const changeTheme = (id: ThemeId): void => {
    setTheme(id)
    setThemeMenu(false)
    applyTheme(id)
    // UX 硬性标准：持久化失败必须可见反馈
    window.omniget
      .settingsSet('ui.theme', id)
      .catch((err) => toastError('保存主题设置', err))
  }

  // 托盘/剪贴板/协议唤起 → 打开新建任务（M1-12）
  // 第七轮审查 P2：对话框已打开时不得应用新 payload——initialSource 变化会整体
  // 重置在途解析会话（磁力 90s 解析结果/勾选全丢）；向导期间打开会被全屏遮罩盖住
  // 且 Esc 会静默关掉看不见的对话框
  const dialogOpenRef = useRef(dialogOpen)
  dialogOpenRef.current = dialogOpen
  const onboardingRef = useRef(false) // current 在 onboarding state 声明处同步
  useEffect(() => {
    const off = window.omniget.onUiAction(({ action, payload }) => {
      if (action === 'new-task') {
        if (onboardingRef.current) return
        // 回归审查 P3：对话框已开时静默丢弃会让托盘按钮「无响应」/剪贴板新链
        // 接「无反应」——带 payload 的唤起给一次性提示（托盘纯聚焦主进程已做）
        if (dialogOpenRef.current) {
          if (payload) toast('已有新建任务窗口打开，链接未自动填入', 'info')
          return
        }
        setDialogSource(payload)
        setDialogOpen(true)
      }
    })
    return off
  }, [])

  // 顶栏搜索 → 任务列表过滤（Ctrl+F 聚焦）
  const [query, setQuery] = useState('')

  // 全局 toast（渲染层 toast + 主进程 onNotices 合流，3.5s 自动消失）
  const toasts = useToasts((s) => s.toasts)
  useEffect(() => {
    const off = window.omniget.onNotices((items) => {
      if (!Array.isArray(items) || items.length === 0) return
      for (const n of items) toast(n.message, n.level === 'warning' ? 'warning' : 'info')
    })
    return off
  }, [])

  const [showHelp, setShowHelp] = useState(false)
  const [onboarding, setOnboarding] = useState(false)
  onboardingRef.current = onboarding
  const selectedTaskId = useTasks((s) => s.selectedTaskId)
  const select = useTasks((s) => s.select)

  // P2 修复：进入非任务视图时清空选中——Space/Delete 快捷键不再作用于
  // 用户当前看不见的后台任务（selRef 跨视图残留曾导致误暂停/误删）
  // R4-P3：回收站同样纳入——在「全部」选中任务后切到回收站按 Delete 会对已删除
  // 任务弹「移入回收站」确认。
  // 第九轮清账（注释口径修正）：搜索词仅在切往非任务视图时清空；任务视图之间
  // （含回收站）保留——回收站也是任务视图，搜索可用，保留可避免返回时「突然
  // 生效」的反面：频繁清空造成「搜不到了」困惑
  useEffect(() => {
    if (['music', 'library', 'health', 'settings', 'stats', 'toolbox'].includes(active)) {
      select(null)
      setQuery((q) => (q ? '' : q))
    } else if (active === 'trash') {
      select(null)
    }
  }, [active, select])

  // M4-8 首次启动向导
  useEffect(() => {
    void window.omniget
      .settingsGet('onboarded')
      .then((v) => {
        if (!v) setOnboarding(true)
      })
      .catch(() => {
        // R4-P3：读取失败按未完成向导处理（可再走一遍，无害）
        setOnboarding(true)
      })
    // 第十轮审查 P3：设置页「重新运行向导」入口
    const reopen = (): void => setOnboarding(true)
    window.addEventListener('app:open-onboarding', reopen)
    return () => window.removeEventListener('app:open-onboarding', reopen)
  }, [])

  // 快捷键（§7.9 可自定义）：默认表 + 用户覆盖（settings ui.keymap），设置页录制后经事件刷新
  const [keymap, setKeymap] = useState<Keymap>({})
  useEffect(() => {
    const readKeymap = (): void => {
      void window.omniget
        .settingsGet('ui.keymap')
        .then((v) => setKeymap(parseKeymap(v)))
        .catch(() => {})
    }
    readKeymap()
    const onChanged = (): void => readKeymap()
    window.addEventListener('keymap-changed', onChanged)
    return () => window.removeEventListener('keymap-changed', onChanged)
  }, [])

  // R4-P3：订阅窗口最大化状态——此前 onWinState 桥无渲染层调用方，
  // 最大化按钮图标恒为「最大化 / 还原」不反映真实窗口态
  const [maximized, setMaximized] = useState(false)
  useEffect(() => window.omniget.onWinState(setMaximized), [])

  // R4-P3：主题弹层支持 Esc 关闭（此前只能点击遮罩）
  useEffect(() => {
    if (!themeMenu) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // stopImmediatePropagation：Inspector 等同在 window 上的 Esc 监听
        // 不能连带被触发（帮助面板 + 详情一键双关）
        e.stopImmediatePropagation()
        setThemeMenu(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [themeMenu])

  // 快捷键全集（§7.9）：新建/搜索/帮助/分组 1-6/Space 暂停/Delete 回收站（键位可自定义）。
  // selectedTaskId 经 ref 中转避免事件批次重挂监听器；任务详情改用 getState() 按需读取
  const selRef = useRef(selectedTaskId)
  selRef.current = selectedTaskId
  useEffect(() => {
    const keys = effectiveKeys(keymap)
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      // P2 修复：焦点在按钮/链接/可编辑元素上时全局快捷键必须让位——
      // 否则 Space 会误暂停后台任务且抑制按钮自身激活，Delete 会弹出
      // 用户无感知的「移入回收站」确认框
      if (target?.closest?.('button,[role="button"],a,[contenteditable="true"],[contenteditable=""]')) {
        return
      }
      // 模态期间屏蔽全局快捷键（确认框/新建任务/帮助/向导/产物预览等弹层——防穿透误触发后台任务操作）
      // 第六轮审查：补 themeMenu——主题菜单未走 useModalGate，开着它 Space 可误
      // 暂停后台任务、Delete 可弹出回收站确认框
      if (isConfirmActive() || isAnyModalOpen() || dialogOpen || showHelp || onboarding || themeMenuRef.current) return
      const k = eventToKey(e)
      if (!k) return
      if (k === keys['new-task']) {
        e.preventDefault()
        setDialogSource(undefined)
        setDialogOpen(true)
      } else if (k === keys.search) {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (k === keys.help) {
        e.preventDefault()
        setShowHelp((v) => !v)
      } else {
        // 分组切换：按键来自 keymap（用户可改绑），不得硬编码 ctrl+N——否则改绑后永不触发
        const groupActions: ShortcutAction[] = ['group1', 'group2', 'group3', 'group4', 'group5', 'group6']
        const hit = groupActions.find((a) => k === keys[a])
        if (hit) {
          e.preventDefault()
          const flat = NAV_GROUPS.flatMap((g) => g.items)
          const idx = Number(hit.slice(5)) - 1
          if (flat[idx]) setActive(flat[idx].id)
        } else if (k === keys['pause-toggle']) {
          const sel = selRef.current
          if (!sel) return
          e.preventDefault()
          const t = useTasks.getState().tasks.get(sel)
          if (!t) return
          // P3 修复：completed/failed/parsing 等状态不可暂停——守卫后再发，防无意义报错
          if (t.status !== 'running' && t.status !== 'queued' && t.status !== 'paused') return
          const action = t.status === 'paused' ? 'resume' : 'pause'
          void window.omniget
            .controlTask({ taskId: sel, action })
            .then(() => toast(action === 'pause' ? '任务已暂停' : '任务已继续下载', 'success'))
            .catch((err) => toastError('任务操作', err)) // P1 修复：失败不得静默
        } else if (k === keys.trash) {
          const sel = selRef.current
          if (!sel) return
          e.preventDefault()
          const t = useTasks.getState().tasks.get(sel)
          // 移入回收站属删除类操作：二次确认（可恢复，用轻量确认）
          void confirmAction({
            title: '移入回收站',
            message: `「${t?.name || sel}」将被移入回收站，可在回收站中恢复。`,
            confirmLabel: '移入回收站'
          }).then((ok) => {
            if (!ok) return
            void window.omniget
              .controlTask({ taskId: sel, action: 'remove' })
              .then(() => {
                toast('任务已移入回收站', 'success')
                // 第七轮审查 P3：按当前 loadedFilter 重载——固定 'all' 会污染
                // loadedFilter 触发 TaskList 守卫双载 + 骨架闪烁（NewTaskDialog/
                // TaskRow 同型修复的漏网）
                const cur = useTasks.getState().loadedFilter
                return reload(TASK_FILTERS.includes(cur) ? cur : 'all')
              })
              .catch((err) => toastError('移入回收站', err))
          })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // themeMenu 经 ref 中转（下方同步），不进依赖数组防菜单开合重挂监听
  }, [keymap, reload, dialogOpen, showHelp, onboarding])

  // 侧栏角标计数：主进程 SQL 全表口径（跨视图一致，含回收站）
  const counts = useTasks((s) => s.counts)
  const runningPlusQueued = counts.running + counts.queued

  const online = (n: string): boolean =>
    engines.find((e) => e.name === n)?.online ?? false

  const openDialog = (): void => {
    setDialogSource(undefined)
    setDialogOpen(true)
  }

  // 顶栏搜索作用域提示：query 只过滤任务列表视图（TaskList），不作用于
  // 音乐/设置/工具箱等功能页——placeholder 动态标注当前分组，消除「搜不到」困惑
  const isTaskListView = !['music', 'library', 'health', 'settings', 'stats', 'toolbox'].includes(active)
  const activeGroupLabel = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === active)?.label
  const searchPlaceholder =
    isTaskListView && activeGroupLabel ? `在「${activeGroupLabel}」内搜索…` : t('search.placeholder')

  return (
    /* 圆角窗口外壳：透明窗口 + 自绘圆角边框（全平台一致） */
    <div className="fixed inset-0 grid grid-cols-[200px_1fr] overflow-hidden rounded-[10px] border border-border bg-[var(--bg)] shadow-[var(--shadow-float)]">
      {/* ── 侧边导航 200px（宽松版）────────────────────────────────── */}
      <aside className="flex flex-col border-r border-border bg-surface">
        {/* Logo 行（自绘标题栏拖拽区） */}
        <div className="titlebar-drag flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-4">
          <LogoMark />
          <span className="text-sm font-semibold tracking-wide">OmniGet</span>
        </div>

        {/* 导航区（可滚动，不挤压底部） */}
        <nav className="flex-1 overflow-y-auto px-2.5 py-3">
          {NAV_GROUPS.map((g, gi) => (
            <div key={gi} className="mb-2">
              {g.title && (
                <div className="mb-1 mt-2 px-2.5 text-[10px] uppercase tracking-[0.16em] text-text-3">
                  {g.title}
                </div>
              )}
              {g.items.map((item) => {
                const isActive = active === item.id
                const badge =
                  item.badge === 'running'
                    ? runningPlusQueued
                    : item.badge === 'completed'
                      ? counts.completed
                      : item.badge === 'failed'
                        ? counts.failed
                        : item.badge === 'trash'
                          ? counts.trashed
                          : null
                return (
                  <button
                    key={item.id}
                    onClick={() => setActive(item.id)}
                    className={`relative flex h-9 w-full items-center gap-3 rounded-ctl px-3 text-[13px] transition-colors ${
                      isActive
                        ? 'nav-rail bg-accent-soft font-medium text-accent'
                        : 'text-text-2 hover:bg-surface-2 hover:text-text-1'
                    }`}
                  >
                    <item.icon
                      size={17}
                      weight={isActive ? 'fill' : 'regular'}
                      className="shrink-0"
                    />
                    <span className="flex-1 truncate text-left leading-none">{t(`nav.${item.id}`)}</span>
                    {badge !== null && badge > 0 && (
                      <span
                        className={`num flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-medium leading-none text-white ${
                          // R6：失败角标用警示红，与其他计数角标区分
                          item.badge === 'failed' ? 'bg-danger' : 'bg-accent'
                        }`}
                      >
                        {badge}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        {/* 底部固定组（shrink-0：永不因导航挤压消失/抖动） */}
        <div className="relative shrink-0 border-t border-border px-2.5 py-2">
          {[
            { id: 'stats', label: t('nav.stats'), icon: ChartBar, onClick: () => setActive('stats') },
            {
              id: 'theme',
              label: t(`theme.${theme}`),
              icon: Palette,
              onClick: () => setThemeMenu((v) => !v)
            },
            {
              id: 'settings',
              label: t('nav.settings'),
              icon: GearSix,
              onClick: () => setActive('settings')
            }
          ].map((b) => {
            const isActive = active === b.id
            return (
              <button
                key={b.id}
                onClick={b.onClick}
                className={`flex h-8 w-full items-center gap-3 rounded-ctl px-3 text-[12px] transition-colors ${
                  isActive
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-text-2 hover:bg-surface-2 hover:text-text-1'
                }`}
              >
                <b.icon size={15} className="shrink-0" />
                <span className="leading-none">{b.label}</span>
              </button>
            )
          })}

          {/* 主题选择弹层（向上展开） */}
          {themeMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setThemeMenu(false)} />
              <div className="absolute bottom-12 left-2.5 z-50 w-44 overflow-hidden rounded-panel border border-border bg-surface shadow-[var(--shadow-pop)]">
                {THEMES.map((th) => (
                  <button
                    key={th.id}
                    onClick={() => changeTheme(th.id)}
                    className={`flex h-9 w-full items-center gap-2.5 px-3 text-xs transition-colors ${
                      theme === th.id
                        ? 'bg-accent-soft font-medium text-accent'
                        : 'text-text-2 hover:bg-surface-2 hover:text-text-1'
                    }`}
                  >
                    {/* 色板：默认空心环，选中实心（均为主题色） */}
                    <span
                      className="inline-block h-4 w-4 shrink-0 rounded-full border-2 transition-colors"
                      style={
                        theme === th.id
                          ? { background: th.accent, borderColor: th.accent }
                          : { background: 'transparent', borderColor: th.accent }
                      }
                    />
                    {/* 第七轮：主题名走 i18n（en locale 此前仍显示中文） */}
                    <span className="flex-1 truncate text-left">{t(`theme.${th.id}`)}</span>
                    {theme === th.id && <CheckCircle size={13} weight="fill" className="text-accent" />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </aside>

      {/* ── 工作区 ────────────────────────────────────────────────── */}
      <div className="grid grid-rows-[44px_1fr_32px] overflow-hidden">
        {/* 玻璃顶栏（整条可拖动；玻璃效果放装饰底层——backdrop-filter 会破坏 -webkit-app-region 拖拽） */}
        <header className="titlebar-drag relative flex items-center gap-3 pl-4 pr-2">
          <div aria-hidden className="glass-panel pointer-events-none absolute inset-0" />
          <div className="relative min-w-0 flex-1">
            <div className="titlebar-no-drag flex h-8 max-w-md items-center gap-2 rounded-ctl border border-transparent bg-surface-2/60 px-2.5 transition-colors focus-within:border-accent">
              <MagnifyingGlass size={14} className="shrink-0 text-text-3" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-text-3"
                placeholder={searchPlaceholder}
                title="搜索范围为当前分组的任务名称与链接（不跨分组）"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  aria-label="清除搜索"
                  className="press shrink-0 text-text-3 hover:text-text-1"
                >
                  <X size={12} weight="bold" />
                </button>
              )}
            </div>
          </div>

          {/* 全局速度迷你图（§7.4）——可拖拽区的一部分 */}
          <div className="relative hidden shrink-0 items-center gap-2 sm:flex" title="全局下载速度">
            <SpeedSparkline history={speedHistory} />
            <span className="num w-20 text-right text-xs text-text-2">
              {formatBytes(globalSpeedBps)}/s
            </span>
          </div>

          {/* 新建任务（主色胶囊：图标+名称，§7.2） */}
          <div className="titlebar-no-drag relative z-10 shrink-0">
            <button
              onClick={openDialog}
              className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 text-xs font-medium text-white shadow-[0_2px_8px_var(--accent-soft)] transition-colors hover:bg-accent-press"
            >
              <Plus size={14} weight="bold" />
              {t('action.newTask')}
            </button>
          </div>

          {/* 自绘窗口控件（frameless 圆角窗口） */}
          <div className="titlebar-no-drag relative z-10 flex shrink-0 items-center">
            <IconButton tip="最小化" onClick={() => window.omniget.windowMinimize()}>
              <Minus size={14} weight="bold" />
            </IconButton>
            <IconButton
              tip={maximized ? '还原' : '最大化'}
              onClick={() => window.omniget.windowMaximize()}
            >
              {maximized ? (
                // 还原态：双矩形（Copy 样式）——此前不订阅 onWinState，图标恒为最大化
                <span className="relative flex h-[11px] w-[11px] items-center justify-center">
                  <Square size={11} weight="bold" />
                  <span className="absolute -bottom-[2px] -right-[2px] h-[5px] w-[5px] border-b-2 border-r-2 border-current bg-[var(--bg)]" />
                </span>
              ) : (
                <Square size={11} weight="bold" />
              )}
            </IconButton>
            <IconButton
              tip="关闭"
              onClick={() => window.omniget.windowClose()}
              className="hover:bg-danger/15 hover:text-danger"
            >
              <X size={15} weight="bold" />
            </IconButton>
          </div>
        </header>

        {/* 工作区路由 + Inspector 抽屉（M4-2） */}
        <div className="flex min-h-0">
          <div className="min-w-0 flex-1 overflow-hidden">
            {active === 'music' ? (
              <MusicWorkbench onOpenTasks={() => setActive('all')} />
            ) : active === 'library' ? (
              <MediaLibrary />
            ) : active === 'health' ? (
              <HealthPage />
            ) : active === 'settings' ? (
              <SettingsPage />
            ) : active === 'stats' ? (
              <StatsPage onNewTask={openDialog} />
            ) : active === 'toolbox' ? (
              <ToolboxPage />
            ) : (
              <TaskList active={active} onNewTask={openDialog} query={query} />
            )}
          </div>
          {active !== 'music' && active !== 'library' && active !== 'settings' && (
            <Inspector
              task={selectedTask}
              onClose={() => select(null)}
              onChanged={() => void reload(active)}
            />
          )}
        </div>

        {/* 底部状态栏（§7.4） */}
        <footer className="flex items-center gap-4 border-t border-border bg-surface px-4 text-[11px] text-text-2">
          <span className="num inline-flex items-center gap-1">
            <ArrowDown size={11} weight="bold" className="text-accent" />
            {formatBytes(globalSpeedBps)}/s
          </span>
          {/* 上传速度已移除硬编码 0 B/s 假数据——真实上行数据经托盘 tooltip 展示 */}
          <span className="num text-text-3">
            {t('status.running')} {counts.running} · {t('status.queued')} {counts.queued}
          </span>
          <span className="ml-auto flex items-center gap-3">
            {(['aria2', 'ytdlp', 'nm3u8', 'music'] as const).map((name) => (
              <span key={name} className="inline-flex items-center gap-1 text-text-3">
                {name}
                {/* aria2 常驻引擎红/绿；ytdlp·nm3u8·music 按需拉起：离线=待机灰（非常驻，不算故障） */}
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    online(name)
                      ? 'bg-success'
                      : name === 'aria2'
                        ? 'bg-danger'
                        : 'bg-[var(--text-3)] opacity-60'
                  }`}
                />
              </span>
            ))}
          </span>
        </footer>
      </div>

      <NewTaskDialog
        open={dialogOpen}
        initialSource={dialogSource}
        onClose={() => setDialogOpen(false)}
      />
      <HelpOverlay open={showHelp} onClose={() => setShowHelp(false)} />
      <Onboarding open={onboarding} onClose={() => setOnboarding(false)} />
      <ConfirmDialog />

      {/* 全局 toast（右下角，操作失败/降级告警统一反馈；R4-P3：可点击手动关闭）
          第七轮审查 P3：role=status 让屏幕阅读器播报操作反馈 */}
      <div
        role="status"
        className="pointer-events-none fixed bottom-10 right-4 z-[60] flex flex-col items-end gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            onClick={() => dismissToast(t.id)}
            className={`stagger-in pointer-events-auto cursor-pointer rounded-ctl border px-3 py-2 text-xs shadow-[var(--shadow-pop)] ${
              t.level === 'warning'
                ? 'border-warning/40 bg-[var(--tooltip-bg)] text-warning'
                : t.level === 'success'
                  ? 'border-success/40 bg-[var(--tooltip-bg)] text-success'
                  : 'border-border bg-[var(--tooltip-bg)] text-text-1'
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}
