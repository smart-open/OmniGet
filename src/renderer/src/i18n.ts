// Backlog：多语言 i18n 基础设施（MVP：框架 + 外壳/健康页/设置分区文案集中化）
// 迁移策略：字典键按「分区.条目」组织，存量页面按改动节奏逐步收敛到 t()；
// 缺键时回退 zh-CN，再回退键名（开发期可见，防漏译）。
import { create } from 'zustand'
import { toastError } from './lib/feedback'

export type LocaleId = 'zh-CN' | 'en'

export const LOCALES: Array<{ id: LocaleId; label: string }> = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en', label: 'English' }
]

type Dict = Record<string, string>

const zh: Dict = {
  // 侧栏导航
  'nav.all': '全部',
  'nav.downloading': '处理中',
  'nav.failed': '处理失败',
  'nav.completed': '处理完成',
  'nav.bt': '种子磁力',
  'nav.video': '视频',
  'nav.music': '音乐',
  'nav.health': '平台健康',
  'nav.toolbox': '工具箱',
  'nav.trash': '回收站',
  'nav.stats': '统计',
  'nav.theme': '主题',
  'nav.settings': '设置',
  // 顶栏 / 通用
  'action.newTask': '新建任务',
  'search.placeholder': '搜索任务…',
  'common.refresh': '刷新',
  'common.close': '关闭',
  'common.enabled': '已启用',
  'common.disabled': '已停用',
  'common.loading': '加载中…',
  // 状态栏
  'status.running': '运行',
  'status.queued': '排队',
  // 任务列表
  'tasks.title.all': '全部任务',
  'tasks.title.downloading': '正在下载',
  'tasks.title.completed': '已完成',
  'tasks.title.bt': '种子与磁力',
  'tasks.title.video': '视频',
  'tasks.title.music': '音乐',
  'tasks.title.health': '平台健康',
  'tasks.title.toolbox': '工具箱',
  'tasks.title.trash': '回收站',
  // 健康面板
  'health.title': '平台健康',
  'health.subtitle': '提取器健康度与失效平台公示（Backlog：平台适配状态面板）',
  'health.engines': '引擎在线状态',
  'health.table': '平台适配状态',
  'health.empty': '暂无平台健康数据——出现下载失败或平台降级后这里会展示',
  'health.status.ok': '正常',
  'health.status.degraded': '降级',
  'health.status.down': '失效',
  'health.status.unknown': '未知',
  'health.lastOk': '最近成功',
  'health.lastFail': '最近失败',
  'health.failCount': '24h 失败',
  'health.recent': '最近错误',
  'health.hint': '建议',
  'health.autoRefresh': '每 10s 自动刷新',
  // 设置页
  'settings.title': '设置',
  'settings.tab.appearance': '外观',
  // 主题名（第七轮：i18n 接入——此前 en locale 下侧栏/设置/向导仍显示中文主题名）
  'theme.system': '随系统',
  'theme.light': '石墨灰',
  'theme.dark': '曜石黑',
  'theme.violet': '暗夜紫',
  'theme.green': '青墨绿',
  'theme.amber': '琥珀橙',
  'theme.blue': '科技蓝',
  'settings.tab.keys': '快捷键',
  'settings.tab.template': '命名模板',
  'settings.tab.download': '下载',
  'settings.tab.tracker': 'Tracker',
  'settings.tab.scripts': '适配脚本',
  'settings.tab.update': '更新',
  'settings.tab.remote': '远程 / 扩展',
  'settings.tab.about': '说明',
  'settings.language': '语言 / Language',
  'settings.scripts.title': '平台适配脚本（内置自维护 + 热更）',
  'settings.scripts.desc': '平台 API 改版时无需更新应用：编辑 userData/adapter-scripts/ 下的 JSON 清单（host 重写表），保存后自动热更；停用的脚本不参与请求改写。',
  'settings.scripts.reload': '重新加载',
  'settings.scripts.empty': '暂无脚本清单',
  'settings.scripts.override': 'host 重写'
}

const en: Dict = {
  'nav.all': 'All',
  'nav.downloading': 'Processing',
  'nav.completed': 'Completed',
  'nav.failed': 'Failed',
  'nav.bt': 'Torrent',
  'nav.video': 'Video',
  'nav.music': 'Music',
  'nav.health': 'Health',
  'nav.toolbox': 'Toolbox',
  'nav.trash': 'Trash',
  'nav.stats': 'Stats',
  'nav.theme': 'Theme',
  'nav.settings': 'Settings',
  'action.newTask': 'New Task',
  'search.placeholder': 'Search tasks…',
  'common.refresh': 'Refresh',
  'common.close': 'Close',
  'common.enabled': 'Enabled',
  'common.disabled': 'Disabled',
  'common.loading': 'Loading…',
  'status.running': 'Running',
  'status.queued': 'Queued',
  'tasks.title.all': 'All Tasks',
  'tasks.title.downloading': 'Downloading',
  'tasks.title.completed': 'Completed',
  'tasks.title.bt': 'Torrent & Magnet',
  'tasks.title.video': 'Video',
  'tasks.title.music': 'Music',
  'tasks.title.health': 'Platform Health',
  'tasks.title.toolbox': 'Toolbox',
  'tasks.title.trash': 'Trash',
  'health.title': 'Platform Health',
  'health.subtitle': 'Extractor health and degraded-platform board',
  'health.engines': 'Engine Status',
  'health.table': 'Platform Adapters',
  'health.empty': 'No platform health data yet — failures and degradations will appear here',
  'health.status.ok': 'OK',
  'health.status.degraded': 'Degraded',
  'health.status.down': 'Down',
  'health.status.unknown': 'Unknown',
  'health.lastOk': 'Last OK',
  'health.lastFail': 'Last failure',
  'health.failCount': 'Fails 24h',
  'health.recent': 'Recent errors',
  'health.hint': 'Suggestion',
  'health.autoRefresh': 'Auto refresh every 10s',
  'settings.title': 'Settings',
  'settings.tab.appearance': 'Appearance',
  // 主题名（与 zh-CN 顺序一一对应）
  'theme.system': 'Follow System',
  'theme.light': 'Graphite',
  'theme.dark': 'Obsidian',
  'theme.violet': 'Night Violet',
  'theme.green': 'Ink Green',
  'theme.amber': 'Amber',
  'theme.blue': 'Tech Blue',
  'settings.tab.keys': 'Shortcuts',
  'settings.tab.template': 'Naming',
  'settings.tab.download': 'Download',
  'settings.tab.tracker': 'Trackers',
  'settings.tab.scripts': 'Adapters',
  'settings.tab.update': 'Update',
  'settings.tab.remote': 'Remote / Ext',
  'settings.tab.about': 'About',
  'settings.language': 'Language / 语言',
  'settings.scripts.title': 'Platform adapter scripts (built-in + hot reload)',
  'settings.scripts.desc': 'No app update needed when a platform API changes: edit the JSON manifest under userData/adapter-scripts/ (host rewrite table); changes hot-reload automatically. Disabled scripts are not applied.',
  'settings.scripts.reload': 'Reload',
  'settings.scripts.empty': 'No adapter scripts',
  'settings.scripts.override': 'host overrides'
}

const DICTS: Record<LocaleId, Dict> = { 'zh-CN': zh, en }

interface I18nState {
  locale: LocaleId
  setLocale: (locale: LocaleId) => void
  /** t('nav.all')；支持 {var} 插值；缺键回退 zh-CN → 键名 */
  t: (key: string, vars?: Record<string, string | number>) => string
}

export const useI18n = create<I18nState>((set, get) => ({
  locale: 'zh-CN',
  setLocale: (locale) => {
    set({ locale })
    // UX 硬性标准：持久化失败必须可见反馈（此前 fire-and-forget，重启后语言回退且无提示）
    window.omniget
      .settingsSet('ui.locale', locale)
      .catch((err) => toastError('保存语言设置', err))
  },
  t: (key, vars) => {
    const raw = DICTS[get().locale][key] ?? DICTS['zh-CN'][key] ?? key
    if (!vars) return raw
    return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`))
  }
}))

/** App 挂载时调用：从 settings 恢复语言偏好 */
export function initLocale(): void {
  void window.omniget
    .settingsGet('ui.locale')
    .then((v) => {
      const id: LocaleId = v === 'en' ? 'en' : 'zh-CN'
      if (useI18n.getState().locale !== id) useI18n.setState({ locale: id })
    })
    .catch(() => {
      // R4-P3：读取失败按默认 zh-CN 继续（此前 unhandledrejection）
    })
}
