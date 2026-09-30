// yt-dlp 热更器 E2E（M3-9）：GitHub 拉取 → SHA256 校验 → 替换 → TOFU 登记 → 版本复查
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'og-upd-'))
process.env.OMNIGET_TEST_DATA_DIR = tmp

async function main(): Promise<void> {
  const { updateYtDlp } = await import('../src/main/updater/ytdlp')
  const { getYtDlpSupervisor } = await import('../src/main/orchestrator/ytdlp')

  console.log('[e2e] current version:', await getYtDlpSupervisor().version())
  const result = await updateYtDlp()
  console.log('[e2e] update result:', JSON.stringify(result))
  if (!result.ok) throw new Error(result.error ?? 'update failed')

  // 替换后版本复查（readBinary 生效）
  const v = await getYtDlpSupervisor().version()
  console.log('[e2e] version after update:', v)
  if (!v) throw new Error('version probe failed after update')
  console.log('[e2e] PASSED')
}

main()
  .catch((err) => {
    console.error('[e2e] FAILED:', err.message ?? err)
    process.exitCode = 1
  })
  .finally(() => {
    const { closeDb } = require('../src/main/db')
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })
