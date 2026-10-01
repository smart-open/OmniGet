// 全屏弹层快捷键闸门：确认对话框之外的浮层（工具产物预览等）打开时注册，
// App 全局快捷键统一经 isAnyModalOpen() 检查，避免弹层开着时快捷键穿透到后台页面。
import { useEffect, useRef } from 'react'

const gates = new Set<symbol>()

/** 声明式注册：active=true 期间占一个闸位，卸载/关闭自动释放 */
export function useModalGate(active: boolean): void {
  const ref = useRef<symbol | null>(null)
  useEffect(() => {
    if (!active) return
    const gate = Symbol('modal-gate')
    ref.current = gate
    gates.add(gate)
    return () => {
      gates.delete(gate)
      ref.current = null
    }
  }, [active])
}

export function isAnyModalOpen(): boolean {
  return gates.size > 0
}
