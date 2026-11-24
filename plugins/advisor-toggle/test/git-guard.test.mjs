// R2 的判定逻辑测试：异常只停不改。
// 注意：这些用例证明的是"判定函数不会给出任何改动引用的指令"，
// 真实 git 行为由 runbook 的原始输出证明（这里不跑 git）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import('../scripts/git-guard.mjs')
const { evaluate, PASS, STOP, FORBIDDEN_ACTIONS } = mod

test('正常提交：父提交等于提交前 HEAD → pass', () => {
  const out = evaluate({ headBefore: 'A', headNow: 'B', actualParent: 'A' })
  assert.equal(out.action, PASS)
  assert.equal(out.needsHuman, false)
})

test('父提交不符 → stop，且结论里不出现任何改动引用的动作', () => {
  const out = evaluate({ headBefore: 'A', headNow: 'B', actualParent: 'X' })
  assert.equal(out.action, STOP)
  assert.equal(out.reason, 'parent-mismatch')
  assert.equal(out.needsHuman, true)
  assert.equal(out.headBefore, 'A')
  assert.equal(out.actualParent, 'X')
  const text = JSON.stringify(out).toLowerCase()
  for (const word of FORBIDDEN_ACTIONS) assert.equal(text.includes(word), false, `结论里不该出现 ${word}`)
})

test('HEAD 在提交期间被换成别的提交（没有新提交） → stop', () => {
  const out = evaluate({ headBefore: 'A', headNow: 'A', actualParent: '' })
  assert.equal(out.action, STOP)
  assert.equal(out.reason, 'no-new-commit')
})

test('取不到 HEAD → stop，不猜', () => {
  const out = evaluate({ headBefore: '', headNow: 'B' })
  assert.equal(out.action, STOP)
  assert.equal(out.reason, 'missing-head')
})

test('源码层面：git-guard 只判定，不会真的执行 git 命令', async () => {
  const source = await readFile(join(here, '../scripts/git-guard.mjs'), 'utf8')
  for (const needle of ['child_process', 'execSync', 'spawn(', 'execFile(']) {
    assert.equal(source.includes(needle), false, `git-guard 不该包含 ${needle}`)
  }
})
