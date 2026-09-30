// 文件树搜索框语法（M1-9，§4.2 关键词/索引选择）
// 语法：`1,3,5-10` 索引区间 / `VID,mp4` 关键词，二者可混用，命中集合取并集。

export interface SyntaxMatchResult {
  /** 1-based 文件索引集合（对应 aria2 select-file） */
  indexes: Set<number>
  /** 纯索引语法（无关键词）时为 true，可直接映射 select-file */
  indexOnly: boolean
}

/**
 * @param input 用户输入（空格分隔的多 token，逗号分组；支持 `1,3,5-10` 与 `VID mp4`）
 * @param paths 全量文件相对路径列表（顺序即 1-based 索引）
 */
export function matchSelectSyntax(input: string, paths: string[]): SyntaxMatchResult {
  const indexes = new Set<number>()
  if (!input.trim()) return { indexes, indexOnly: false }

  let indexOnly = true
  const tokens = input
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)

  for (const token of tokens) {
    const range = /^(\d+)-(\d+)$/.exec(token)
    const single = /^(\d+)$/.exec(token)
    if (range) {
      const lo = Math.max(1, Number(range[1]))
      const hi = Math.min(paths.length, Number(range[2]))
      for (let i = lo; i <= hi; i++) indexes.add(i)
    } else if (single) {
      const idx = Number(single[1])
      if (idx >= 1 && idx <= paths.length) indexes.add(idx)
    } else {
      indexOnly = false
      const kw = token.toLowerCase()
      paths.forEach((p, i) => {
        if (p.toLowerCase().includes(kw)) indexes.add(i + 1)
      })
    }
  }
  return { indexes, indexOnly }
}
