// 应用自动更新（M4-7，§8）：electron-updater GitHub 通道
// 差分更新 + 校验由 electron-updater 内建；失败事件降级为通知，不阻断应用。
// dev / 未配置发布仓库时静默跳过；Linux 走手动通道（设置 → 更新 → 检查新版本）。

import { createLogger } from './logger'

const log = createLogger('app-updater')

/** 复查定时器句柄（模块级持有：可测试/可清理，而非匿名 setInterval 失联） */
let recheckTimer: NodeJS.Timeout | null = null

/** P3 修复配套：语义化版本比较（latest > current 才算有更新） */
function isVersionNewer(latest: string, current: string): boolean {
  if (!latest) return false
  const parse = (v: string): number[] =>
    v.replace(/^v/i, '').split(/[-+.]/).slice(0, 3).map((n) => Number(n) || 0)
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return latest !== current // 前三段相同但预发布串不同 → 视为有更新
}

export function stopAppUpdaterTimer(): void {
  if (recheckTimer) clearInterval(recheckTimer)
  recheckTimer = null
}

export function startAppUpdater(): void {
  // 仅打包态启用（dev 无签名产物与发布通道）
  if (!process.resourcesPath || process.env.NODE_ENV === 'development') {
    log.info('app updater skipped (dev mode)')
    return
  }
  // 遗留清单 #4：deb 不支持在线更新（上游限制），AppImage 支持有限 →
  // Linux 统一手动口径：设置 → 更新 提供版本比对 + 跳转下载页
  if (process.platform === 'linux') {
    log.info('linux platform: manual update channel (check in settings)')
    return
  }
  void (async () => {
    try {
      const { autoUpdater } = await import('electron-updater')
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true

      autoUpdater.on('update-available', (info) => {
        log.info(`update available: ${String(info.version)}`)
      })
      autoUpdater.on('update-not-available', () => {
        log.debug('update not available')
      })
      autoUpdater.on('error', (err) => {
        log.warn('auto update error (downgrade to manual):', String(err))
      })
      autoUpdater.on('update-downloaded', (info) => {
        log.info(`update downloaded: ${String(info.version)}, will install on quit`)
      })

      await autoUpdater.checkForUpdatesAndNotify()
      // 每 4 小时复查
      stopAppUpdaterTimer()
      recheckTimer = setInterval(
        () =>
          void autoUpdater
            .checkForUpdatesAndNotify()
            .catch((err) => log.warn('应用更新检查失败（4 小时后重试）', { error: String(err) })),
        4 * 60 * 60 * 1000
      )
    } catch (err) {
      log.warn('electron-updater unavailable:', String(err))
    }
  })()
}

/** 手动触发一次应用更新检查（IPC app:update；dev/Linux 未启用通道 → null） */
export async function checkForAppUpdateNow(): Promise<{
  ok: boolean
  version?: string
  error?: string
} | null> {
  if (
    !process.resourcesPath ||
    process.env.NODE_ENV === 'development' ||
    process.platform === 'linux'
  ) {
    return null
  }
  try {
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    const result = await autoUpdater.checkForUpdates()
    const info = result?.updateInfo
    const latest = String(info?.version ?? '')
    const current = autoUpdater.currentVersion.format()
    // P3 修复：latest !== current 会把"版本回退"也当更新——语义必须是"有更新"
    return {
      ok: isVersionNewer(latest, current),
      version: latest || undefined
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
