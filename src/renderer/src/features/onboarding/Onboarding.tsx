// 首次启动向导（M4-8，§8）：默认目录 → 主题（全套七主题）→ 协议/剪贴板 → 完成，四步即用
import { useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, Check, FolderOpen } from '@phosphor-icons/react'
import { Button } from '../../components/ui'
import { THEMES, applyTheme, type ThemeId } from '../../theme'

export function Onboarding({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState(0)
  const [saveDir, setSaveDir] = useState('')
  const [theme, setTheme] = useState<ThemeId>('dark')
  const [clipboard, setClipboard] = useState(true)

  if (!open) return null

  async function finish(): Promise<void> {
    if (saveDir) void window.omniget.settingsSet('download.saveDir', saveDir)
    void window.omniget.settingsSet('ui.theme', theme)
    applyTheme(theme)
    // 剪贴板监听默认开（§8 向导第四步）；关闭则记录偏好
    void window.omniget.settingsSet('ui.clipboardWatch', clipboard ? 'true' : 'false')
    void window.omniget.settingsSet('onboarded', true)
    onClose()
  }

  const steps = ['下载目录', '外观', '系统集成']

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 100, damping: 20 }}
        className="w-[440px] rounded-dialog border border-border bg-surface p-6 shadow-[var(--shadow-float)]"
      >
        {/* 步骤指示 */}
        <div className="mb-5 flex items-center gap-2">
          {steps.map((s, i) => (
            <div key={s} className="flex flex-1 items-center gap-2">
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${
                  i <= step ? 'bg-accent text-white' : 'bg-surface-2 text-text-3'
                }`}
              >
                {i < step ? <Check size={10} weight="bold" /> : i + 1}
              </span>
              <span className={`text-[11px] ${i === step ? 'text-text-1' : 'text-text-3'}`}>{s}</span>
              {i < steps.length - 1 && <div className="h-px flex-1 bg-border" />}
            </div>
          ))}
        </div>

        {step === 0 && (
          <div>
            <h2 className="mb-1 text-sm font-medium">选择默认下载目录</h2>
            <p className="mb-3 text-[11px] text-text-3">所有任务默认保存到这里，可按任务修改。</p>
            <div className="flex gap-2">
              <input
                value={saveDir}
                onChange={(e) => setSaveDir(e.target.value)}
                placeholder={saveDir || '点击加载系统默认'}
                onFocus={() => {
                  if (!saveDir) void window.omniget.defaultSaveDir().then(setSaveDir)
                }}
                className="num h-9 min-w-0 flex-1 rounded-ctl border border-border bg-surface-2 px-3 text-xs outline-none focus:border-accent"
              />
              <Button
                variant="outline"
                icon={<FolderOpen size={14} />}
                onClick={() =>
                  void window.omniget.pickFolder().then((dir) => {
                    if (dir) setSaveDir(dir)
                  })
                }
              >
                浏览
              </Button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div>
            <h2 className="mb-1 text-sm font-medium">选择外观</h2>
            {/* 全套七主题（与设置·外观一致）：实色圆（选中实心）+ 名称，点击即时预览 */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setTheme(t.id)
                    applyTheme(t.id)
                  }}
                  className={`press flex items-center gap-2 rounded-panel border px-3 py-2.5 text-left transition-colors ${
                    theme === t.id
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-border text-text-2 hover:border-text-3 hover:text-text-1'
                  }`}
                >
                  <span
                    className="inline-block h-4 w-4 shrink-0 rounded-full border-2"
                    style={
                      theme === t.id
                        ? { background: t.accent, borderColor: t.accent }
                        : { background: 'transparent', borderColor: t.accent }
                    }
                  />
                  <span className="flex-1 truncate text-xs">{t.label}</span>
                  {theme === t.id && <Check size={12} weight="bold" className="shrink-0" />}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-text-3">
              「随系统」跟随 Windows 深浅色自动切换；后续可在 设置 → 外观 修改
            </p>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="mb-1 text-sm font-medium">系统集成</h2>
            <p className="mb-3 text-[11px] text-text-3">
              magnet: 协议注册在安装时完成；剪贴板监听检测到链接时自动弹出新建任务。
            </p>
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={clipboard}
                onChange={(e) => setClipboard(e.target.checked)}
              />
              启用剪贴板监听（可随时在系统托盘菜单关闭）
            </label>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          {step > 0 && (
            <Button variant="ghost" onClick={() => setStep(step - 1)}>
              上一步
            </Button>
          )}
          {step < 2 ? (
            <Button icon={<ArrowRight size={13} />} onClick={() => setStep(step + 1)}>
              下一步
            </Button>
          ) : (
            <Button icon={<Check size={13} weight="bold" />} onClick={() => void finish()}>
              开始使用
            </Button>
          )}
        </div>
      </motion.div>
    </div>
  )
}
