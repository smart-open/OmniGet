import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import './styles/tokens.css'
import './styles/global.css'

// R4-P2：preload 桥缺失（文件损坏/版本错配）时首个 IPC 调用即 TypeError，
// 此前无任何防线直接白屏——渲染前检查并给出可操作的降级页
function BridgeMissing(): React.ReactElement {
  return (
    <div
      style={{
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        color: 'var(--text-2, #999)',
        fontFamily: 'inherit',
        padding: 24,
        textAlign: 'center'
      }}
    >
      <h2 style={{ fontSize: 16, color: 'var(--text-1, #eee)' }}>应用初始化失败</h2>
      <p style={{ fontSize: 13, lineHeight: 1.7, maxWidth: 420 }}>
        内部通信桥未加载（应用文件可能损坏或未完整更新）。
        <br />
        请完全退出应用后重新安装；若问题持续，请到「设置 → 诊断」导出日志反馈。
      </p>
    </div>
  )
}

// R4-P2：顶层 ErrorBoundary——任何渲染期异常不再白屏，给重启指引
class RootBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            height: '100dvh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            color: 'var(--text-2, #999)',
            padding: 24,
            textAlign: 'center'
          }}
        >
          <h2 style={{ fontSize: 16, color: 'var(--text-1, #eee)' }}>界面出现异常</h2>
          <p style={{ fontSize: 13, lineHeight: 1.7, maxWidth: 420 }}>
            {this.state.error.message || '未知错误'}
            <br />
            请重启应用；若反复出现，请到「设置 → 诊断」导出日志反馈。
          </p>
        </div>
      )
    }
    return this.props.children
  }
}

const root = document.getElementById('root')!
if (!window.omniget) {
  ReactDOM.createRoot(root).render(<BridgeMissing />)
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <RootBoundary>
        <App />
      </RootBoundary>
    </React.StrictMode>
  )
}
