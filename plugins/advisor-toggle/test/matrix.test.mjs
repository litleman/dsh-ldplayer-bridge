// 真机测试矩阵（D）里能自动化的部分：版本可信度、并发评审串行、单批授权被两个写操作共享。
// 需要人眼/真机参与的项（刷新、多标签、进程中断）记在 docs/test-matrix.md 的「手工项」。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as mod from '../index.js'

const {
  contentVersion,
  gateDecision,
  enqueue,
  stateOf,
  DEFAULTS,
  isVersionTrusted,
  resetVersionCache,
} = mod.__test

test('git 不可用：版本打上 untrusted- 前缀，且旧授权一律失效（不能靠旧 grant 绕过）', async () => {
  const original = DEFAULTS.workspace
  const dir = mkdtempSync(join(tmpdir(), 'adv-notgit-'))
  try {
    DEFAULTS.workspace = dir
    resetVersionCache()
    const version = await contentVersion({ maxAgeMs: 0 })
    assert.match(version, /^untrusted-/, 'git 失败必须显式标记不可信，而不是悄悄返回旧值')
    assert.equal(isVersionTrusted(), false)

    // 就算手里有同版本的 grant，也不许放行写工具。
    const state = stateOf('matrix-untrusted')
    state.enabled = true
    state.activePlanId = 'plan-m1'
    state.toolSnapshotDigest = 'snap-m1'
    state.grant = { id: 'g1', planId: 'plan-m1', version, toolSnapshotDigest: 'snap-m1', at: Date.now(), expiresAt: Date.now() + 60000, maxOps: 300, used: 0 }
    const denied = gateDecision(state, 'write', version, Date.now(), { trusted: false })
    assert.equal(denied.allow, false)
    assert.match(denied.reason, /版本不可信|untrusted/)
  } finally {
    DEFAULTS.workspace = original
    resetVersionCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('git 恢复：版本重新可信，新版本上的授权可以正常放行', async () => {
  resetVersionCache()
  const version = await contentVersion({ maxAgeMs: 0 })
  assert.equal(isVersionTrusted(), true, '真实工作区是 git 仓库，恢复后必须可信')
  assert.doesNotMatch(version, /^untrusted-/)

  const state = stateOf('matrix-trusted')
  state.enabled = true
  state.activePlanId = 'plan-m2'
  state.toolSnapshotDigest = 'snap-m2'
  state.grant = { id: 'g2', planId: 'plan-m2', version, toolSnapshotDigest: 'snap-m2', at: Date.now(), expiresAt: Date.now() + 60000, maxOps: 300, used: 0 }
  const ok = gateDecision(state, 'write', version, Date.now(), { trusted: true })
  assert.equal(ok.allow, true)
})

test('同一会话的两个写操作共享同一批授权，操作数累计到上限就拒绝', () => {
  const state = stateOf('matrix-share')
  state.enabled = true
  const version = 'deadbee1'
  state.activePlanId = 'plan-m3'
  state.toolSnapshotDigest = 'snap-m3'
  state.grant = { id: 'g3', planId: 'plan-m3', version, toolSnapshotDigest: 'snap-m3', at: Date.now(), expiresAt: Date.now() + 60000, maxOps: 2, used: 0 }

  const first = gateDecision(state, 'write', version, Date.now(), { trusted: true })
  const second = gateDecision(state, 'edit', version, Date.now(), { trusted: true })
  const third = gateDecision(state, 'pwsh', version, Date.now(), { trusted: true })

  // 前两个由同一个 grant 放行，第三个因为额度用完被拒（拒绝理由要写明额度）。
  assert.equal(first.allow, true)
  assert.equal(second.allow, true)
  assert.equal(third.allow, false)
})

test('同一会话的评审请求串行执行，不会两个请求同时打到桥上', async () => {
  const order = []
  const job = (tag, ms) => async () => {
    order.push(`${tag}:start`)
    await new Promise((resolve) => setTimeout(resolve, ms))
    order.push(`${tag}:end`)
  }
  await Promise.all([enqueue('matrix-queue', job('a', 30)), enqueue('matrix-queue', job('b', 1))])
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end'], '第二个任务必须等第一个结束')
})

test('不同会话的评审互不阻塞（串行只发生在同一会话内）', async () => {
  const order = []
  const job = (tag, ms) => async () => {
    order.push(`${tag}:start`)
    await new Promise((resolve) => setTimeout(resolve, ms))
    order.push(`${tag}:end`)
  }
  await Promise.all([enqueue('matrix-x', job('x', 30)), enqueue('matrix-y', job('y', 1))])
  assert.deepEqual(order, ['x:start', 'y:start', 'y:end', 'x:end'], '不同会话应并发')
})
