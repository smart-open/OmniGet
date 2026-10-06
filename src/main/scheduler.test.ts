// 调度器单测（五期 0.12.x 合并编排）：sanitizeRules 结构校验（mode/days 归一、
// 旧数据兼容）+ 时段/星期匹配（inRange 跨天 + days 过滤）。经 IPC 边界函数
// getScheduleRules/setScheduleRules 走真实 settings 表——db 单例按 tests 同口径
// 指向临时 userData（见下方 db 环境搭建）。
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { test } from 'node:test'
import {
  currentLimit,
  getScheduleRules,
  isPausedWindow,
  setScheduleRules,
  type ScheduleRule
} from './scheduler'

// db/index.ts 经 env.userDataDir() 定位库目录——OMNIGET_TEST_DATA_DIR 注入
// 每文件独立临时目录（env.ts 测试隔离口径，node:test 单进程多文件互不串库）
;(process.env as Record<string, string | undefined>).OMNIGET_TEST_DATA_DIR =
  mkdtempSync(join(tmpdir(), 'omniget-sched-test-'))

test('sanitize：mode/days 归一 + pause 规则不消费限速档', () => {
  setScheduleRules([
    { from: '09:00', to: '18:00', limit: '2M' },
    { from: '01:00', to: '07:00', limit: '99X', mode: 'pause' },
    { from: '08:00', to: '09:00', limit: '1M', days: [1, 3, 5, 9, -1] }
  ] as ScheduleRule[])
  const rules = getScheduleRules()
  assert.equal(rules.length, 3)
  assert.equal(rules[0]!.mode, undefined) // 缺省 = limit（不落字段，向后兼容）
  assert.equal(rules[1]!.limit, '0') // pause 归一为 '0'
  assert.deepEqual(rules[2]!.days, [1, 3, 5]) // 越界星期被过滤，合法值保留
})

test('sanitize：合法 days 去重升序；非法行被丢弃', () => {
  setScheduleRules([
    { from: '08:00', to: '09:00', limit: '1M', days: [5, 1, 1, 3] },
    { from: '99:00', to: '10:00', limit: '1M' }
  ] as ScheduleRule[])
  const rules = getScheduleRules()
  assert.equal(rules.length, 1)
  assert.deepEqual(rules[0]!.days, [1, 3, 5])
})

test('currentLimit / isPausedWindow：时段与星期匹配', () => {
  setScheduleRules([
    { from: '00:00', to: '23:59', limit: '1M', days: [1] }, // 仅周一
    { from: '00:00', to: '23:59', limit: '0', mode: 'pause', days: [0] } // 仅周日停运
  ] as ScheduleRule[])
  const monday = new Date(2026, 9, 5, 12, 0) // 2026-10-05 = 周一
  const sunday = new Date(2026, 9, 4, 12, 0) // 2026-10-04 = 周日
  const tuesday = new Date(2026, 9, 6, 12, 0) // 周二
  assert.equal(currentLimit(monday), '1M')
  assert.equal(currentLimit(tuesday), null) // 非命中日：无限速规则生效
  assert.equal(isPausedWindow(monday), false)
  assert.equal(isPausedWindow(sunday), true)
  // 全天段（from === to）语义保持
  setScheduleRules([{ from: '00:00', to: '00:00', limit: '3M' }])
  assert.equal(currentLimit(monday), '3M')
})

test('跨零点时段的星期按窗口开始日判定（审查 P2-3 回归锁）', () => {
  setScheduleRules([
    // 仅周五生效的跨零点停运窗口（22:00–06:00）
    { from: '22:00', to: '06:00', limit: '0', mode: 'pause', days: [5] }
  ] as ScheduleRule[])
  const friNight = new Date(2026, 9, 9, 23, 30) // 2026-10-09 = 周五 23:30
  const satEarly = new Date(2026, 9, 10, 0, 30) // 周六 00:30——仍属周五窗口
  const satNoon = new Date(2026, 9, 10, 12, 0) // 周六中午——窗口已过
  const sunEarly = new Date(2026, 9, 11, 0, 30) // 周日凌晨——非周五窗口
  assert.equal(isPausedWindow(friNight), true)
  assert.equal(isPausedWindow(satEarly), true, '跨零点凌晨段被当天星期误掐断')
  assert.equal(isPausedWindow(satNoon), false)
  assert.equal(isPausedWindow(sunEarly), false)
})
