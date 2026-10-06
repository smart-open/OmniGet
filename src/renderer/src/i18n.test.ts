// 渲染层 i18n 单测（五期 0.12.x 扩展语种批次）：键位齐平校验——
// 各语种键集必须与 zh-CN 完全一致（经 __DICTS__ 原始字典逐键对比，任一新键
// 漏译/多键直接失败，兑现「防漏译静默回退」承诺——审查 P2-4 指出锚点键校验
// 形同虚设）；同时覆盖 t() 的回退链（locale 缺键 → zh-CN → 键名）与插值。
// 注：i18n.ts import 期无副作用（zustand store 纯内存），node 环境可直接导入。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOCALES, useI18n, __DICTS__, type LocaleId } from './i18n'

test('LOCALES 包含五期扩展语种（zh-TW/ja）且 id 唯一', () => {
  const ids = LOCALES.map((l) => l.id)
  for (const expected of ['zh-CN', 'en', 'zh-TW', 'ja']) {
    assert.ok(ids.includes(expected as LocaleId), `缺少语种 ${expected}`)
  }
  assert.equal(new Set(ids).size, ids.length, '语种 id 有重复')
})

test('键位齐平：全部语种键集与 zh-CN 完全一致（防漏译静默回退）', () => {
  const base = Object.keys(__DICTS__['zh-CN']!).sort()
  assert.ok(base.length >= 69, `zh-CN 字典键数异常：${base.length}`)
  for (const { id } of LOCALES) {
    if (id === 'zh-CN') continue
    const keys = Object.keys(__DICTS__[id]!).sort()
    const missing = base.filter((k) => !keys.includes(k))
    const extra = keys.filter((k) => !base.includes(k))
    assert.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      `${id} 字典键集与 zh-CN 不齐平`
    )
    // 值非空（空串文案等价漏译）
    for (const k of keys) {
      assert.ok(String(__DICTS__[id]![k]).trim().length > 0, `${id}.${k} 文案为空`)
    }
  }
})

test('t() 未知键回退键名（防漏译可见性）', () => {
  useI18n.setState({ locale: 'zh-CN' })
  assert.equal(useI18n.getState().t('__no_such_key__'), '__no_such_key__')
})

test('t() 插值：{var} 被替换、未知变量保留占位', () => {
  useI18n.setState({ locale: 'zh-CN' })
  const t = useI18n.getState().t
  // 用未知键携带插值模板走键名回退路径校验插值引擎
  assert.equal(t('__k_{name}__', { name: 'X' }), '__k_X__')
  assert.equal(t('__k_{name}__'), '__k_{name}__')
})

test('扩展语种生效：切换 locale 后同键返回该语种文案（以 settings.language 为锚）', () => {
  const t = useI18n.getState().t
  useI18n.setState({ locale: 'zh-CN' })
  const zhLabel = t('settings.language')
  useI18n.setState({ locale: 'ja' })
  const jaLabel = t('settings.language')
  useI18n.setState({ locale: 'zh-TW' })
  const twLabel = t('settings.language')
  assert.notEqual(jaLabel, zhLabel, 'ja 字典疑似缺失（回退到了 zh-CN）')
  assert.notEqual(twLabel, zhLabel, 'zh-TW 字典疑似缺失（回退到了 zh-CN）')
  useI18n.setState({ locale: 'zh-CN' })
})
