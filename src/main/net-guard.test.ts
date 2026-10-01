// net-guard 回归（P1 修复）：IPv4-mapped IPv6 / NAT64 / fe80::/10 上半段
// 此前可绕过内网判定 → 主进程代发请求成为内网探测通道（fail-open）
import test from 'node:test'
import assert from 'node:assert/strict'
import { isInternalUrl, isPrivateIPv4 } from './net-guard'

test('isPrivateIPv4：私网/回环/CGNAT/链路本地', () => {
  assert.equal(isPrivateIPv4('10.0.0.1'), true)
  assert.equal(isPrivateIPv4('127.0.0.1'), true)
  assert.equal(isPrivateIPv4('192.168.1.1'), true)
  assert.equal(isPrivateIPv4('172.16.0.1'), true)
  assert.equal(isPrivateIPv4('100.64.0.1'), true)
  assert.equal(isPrivateIPv4('169.254.1.1'), true)
})

test('isPrivateIPv4：公网/畸形输入不误判', () => {
  assert.equal(isPrivateIPv4('8.8.8.8'), false)
  assert.equal(isPrivateIPv4('172.32.0.1'), false)
  assert.equal(isPrivateIPv4('100.128.0.1'), false)
  assert.equal(isPrivateIPv4('999.1.1.1'), false)
  assert.equal(isPrivateIPv4('not-an-ip'), false)
})

// P1 回归：以下字面量必须全部命中内网判定（早退路径，不依赖 DNS）
test('isInternalUrl：IPv4-mapped IPv6 点分形态不绕过', async () => {
  assert.equal(await isInternalUrl('http://[::ffff:10.0.0.1]/x'), true)
  assert.equal(await isInternalUrl('http://[::ffff:192.168.1.1]/x'), true)
})

test('isInternalUrl：IPv4-mapped IPv6 十六进制形态不绕过', async () => {
  // 7f00:1 = 127.0.0.1；0a00:1 = 10.0.0.1
  assert.equal(await isInternalUrl('http://[::ffff:7f00:1]/x'), true)
  assert.equal(await isInternalUrl('http://[::ffff:a00:1]/x'), true)
})

test('isInternalUrl：NAT64 前缀内嵌 IPv4 不绕过', async () => {
  // 点分形态
  assert.equal(await isInternalUrl('http://[64:ff9b::10.0.0.1]/x'), true)
  // WHATWG URL 会把内嵌 IPv4 规范化为十六进制（a00:1 = 10.0.0.1）
  assert.equal(await isInternalUrl('http://[64:ff9b::a00:1]/x'), true)
})

test('isInternalUrl：fe80::/10 上半段（febf）不绕过', async () => {
  assert.equal(await isInternalUrl('http://[febf::1]/x'), true)
  assert.equal(await isInternalUrl('http://[fe80::1]/x'), true)
})

test('isInternalUrl：回环/未指定地址/ULA', async () => {
  assert.equal(await isInternalUrl('http://[::1]/x'), true)
  assert.equal(await isInternalUrl('http://[::]/x'), true)
  assert.equal(await isInternalUrl('http://[fd00::1]/x'), true)
})

test('isInternalUrl：localhost 尾点归一 + 非 http 协议 fail-closed', async () => {
  assert.equal(await isInternalUrl('http://localhost./x'), true)
  assert.equal(await isInternalUrl('ftp://example.com/x'), true)
})
