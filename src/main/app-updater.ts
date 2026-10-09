// 应用自动更新（M4-7，§8）：electron-updater GitHub 通道
// 差分更新 + 校验由 electron-updater 内建；失败事件降级为通知，不阻断应用。
// dev / 未配置发布仓库时静默跳过；Linux 走手动通道（设置 → 更新 → 检查新版本）。

import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { createLogger } from './logger'

const log = createLogger('app-updater')

/** 复查定时器句柄（模块级持有：可测试/可清理，而非匿名 setInterval 失联） */
let recheckTimer: NodeJS.Timeout | null = null

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
  // 第十一轮审查 P2：electron-updater 仅支持 NSIS 安装形态——MSI/zip 用户触发
  // 自动更新会把 NSIS 包装到 %LOCALAPPDATA%，与现有安装并存成双实例。
  // NSIS 判定 = 安装目录存在其卸载器（NSIS 安装必写 Uninstall <name>.exe）；
  // 非命中（MSI/绿色解压）降级手动通道，与 linux 同口径
  if (process.platform === 'win32') {
    const nsisUninstaller = 'Uninstall OmniGet.exe'
    const isNsis = existsSync(join(dirname(process.execPath), nsisUninstaller))
    if (!isNsis) {
      log.info('non-NSIS install (msi/portable): manual update channel (check in settings)')
      return
    }
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
      // 第十轮审查 P2：失败/下载完成事件必须用户可见——文件头声称「失败事件
      // 降级为通知」但此前只有日志，用户以为后台已更新成功而静默不生效。
      // error 只广播首次（4h 复查的瞬时网络抖动不做通知轰炸）
      let errorNoticeShown = false
      autoUpdater.on('error', (err) => {
        log.warn('auto update error (downgrade to manual):', String(err))
        if (errorNoticeShown) return
        errorNoticeShown = true
        const msg = err instanceof Error ? err.message : String(err)
        void import('./ipc')
          .then(({ broadcastNotices }) =>
            broadcastNotices([
              {
                level: 'warning',
                message: `自动更新失败（当前版本可正常使用）：${msg.slice(0, 120)}。可到设置 → 更新 手动检查`
              }
            ])
          )
          .catch(() => {})
      })
      autoUpdater.on('update-downloaded', (info) => {
        log.info(`update downloaded: ${String(info.version)}, will install on quit`)
        void import('./ipc')
          .then(({ broadcastNotices }) =>
            broadcastNotices([
              { level: 'info', message: `新版本 ${String(info.version)} 已下载，重启应用后自动安装` }
            ])
          )
          .catch(() => {})
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
