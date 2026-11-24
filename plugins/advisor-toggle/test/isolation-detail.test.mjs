// /isolation?detail=1 的边界：只读、可复现、不改判定结果。
// 顾问 2026-11-24 HOLD 里的硬要求：detail 必须复用现有计算结果，
// 不得调用 gateDecision()、不得消费额度、不得改 phase/paused，且与普通 /isolation 判定一致。
// 跑法: node --test test/isolation-detail.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import('../index.js')
const { auditIsolation } = mod.__test
const source = await readFile(join(ROOT, 'index.js'), 'utf8')

// auditIsolation 的源码块：从定义到下一个顶层 async function。
const body = source.slice(source.indexOf('async function auditIsolation'), source.indexOf('async function writeSurface'))

test('detail 不改变任何判定字段（与普通 /isolation 完全一致）', async () => {
  const plain = await auditIsolation('executing', 'root', false)
  const withDetail = await auditIsolation('executing', 'root', true)
  const { allowedNames, readOnlyNames, pathBoundedTools, declaredWriteTools, ...rest } = withDetail
  assert.deepEqual(rest, plain, 'detail 版本除新增清单外必须逐字段相同')
  assert.ok(Array.isArray(allowedNames), 'detail 必须给出 allowedNames')
  assert.ok(Array.isArray(readOnlyNames), 'detail 必须给出 readOnlyNames')
  assert.ok(Array.isArray(pathBoundedTools), 'detail 必须给出受路径约束的工具清单（模型 A）')
  assert.ok(Array.isArray(declaredWriteTools), 'detail 必须给出只靠声明的写工具清单（模型 A）')
  assert.deepEqual(allowedNames, plain.allowed, 'allowedNames 必须就是 allowed 本身')
})

test('detail 的清单与 total/readOnlyCount 自洽', async () => {
  const withDetail = await auditIsolation('executing', 'root', true)
  assert.equal(withDetail.allowedNames.length, withDetail.allowed.length)
  assert.equal(withDetail.readOnlyNames.length, withDetail.readOnlyCount)
  assert.equal(withDetail.total, withDetail.allowed.length + withDetail.deniedCount)
})

test('审计源码里没有副作用调用（不调 gateDecision、不消费额度）', () => {
  assert.equal(/gateDecision\(/.test(body), false, 'auditIsolation 不许调 gateDecision（那会消费额度）')
  assert.equal(/used\s*\+\+/.test(body), false, 'auditIsolation 不许消费额度')
  assert.equal(/totalUsed\s*\+=/.test(body), false, 'auditIsolation 不许累计额度')
  assert.equal(/state\.phase\s*=/.test(body), false, 'auditIsolation 不许改 phase')
  assert.equal(/state\.paused\s*=/.test(body), false, 'auditIsolation 不许改 paused')
})

test('detail 允许参数从路由透传，且默认关闭', () => {
  assert.ok(source.includes("const detail = q.get('detail') === '1'"), '路由必须按 ?detail=1 开关')
  assert.ok(source.includes('await auditIsolation(stateName, scopeName, detail)'), '路由必须把 detail 透传下去')
})
