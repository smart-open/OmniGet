// 文件树构建与三态勾选（M1-9，§7.5）

import type { TaskFile } from '@shared/types'

export interface TreeNode {
  name: string
  path: string
  isLeaf: boolean
  /** 叶子节点：1-based 全局索引（映射 select-file） */
  index?: number
  size: number
  children: TreeNode[]
}

export type CheckState = 'checked' | 'unchecked' | 'indeterminate'

export function buildTree(files: TaskFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isLeaf: false, size: 0, children: [] }
  files.forEach((f, i) => {
    const parts = f.path.split('/')
    let cur: TreeNode = root
    for (let d = 0; d < parts.length; d++) {
      const isLast = d === parts.length - 1
      const path = parts.slice(0, d + 1).join('/')
      const existing = cur.children.find((c) => c.name === parts[d])
      if (existing) {
        cur = existing
        continue
      }
      const node: TreeNode = {
        name: parts[d] ?? '',
        path,
        isLeaf: isLast,
        index: isLast ? i + 1 : undefined,
        size: isLast ? f.size : 0,
        children: []
      }
      cur.children.push(node)
      cur = node
    }
  })
  // 目录行聚合大小（§7.5）
  const aggregate = (n: TreeNode): number => {
    if (n.isLeaf) return n.size
    n.size = n.children.reduce((s, c) => s + aggregate(c), 0)
    return n.size
  }
  aggregate(root)
  sortTree(root)
  return root
}

function sortTree(n: TreeNode): void {
  n.children.sort((a, b) => {
    if (a.isLeaf !== b.isLeaf) return a.isLeaf ? 1 : -1
    return a.name.localeCompare(b.name)
  })
  n.children.forEach(sortTree)
}

/** 目录/叶子三态（父半选） */
export function nodeState(
  node: TreeNode,
  selected: Set<string>
): CheckState {
  if (node.isLeaf) return selected.has(node.path) ? 'checked' : 'unchecked'
  const states = node.children.map((c) => nodeState(c, selected))
  const allChecked = states.every((s) => s === 'checked')
  const anyChecked = states.some((s) => s !== 'unchecked')
  if (allChecked) return 'checked'
  return anyChecked ? 'indeterminate' : 'unchecked'
}

/** 收集选中叶子路径（确认勾选 → select-file） */
export function collectSelected(node: TreeNode, selected: Set<string>): string[] {
  if (node.isLeaf) return selected.has(node.path) ? [node.path] : []
  return node.children.flatMap((c) => collectSelected(c, selected))
}

/** 勾选目录 = 全选/全不选其子树 */
export function setSubtree(node: TreeNode, checked: boolean, selected: Set<string>): void {
  if (node.isLeaf) {
    if (checked) selected.add(node.path)
    else selected.delete(node.path)
    return
  }
  node.children.forEach((c) => setSubtree(c, checked, selected))
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--:--'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':')
}
