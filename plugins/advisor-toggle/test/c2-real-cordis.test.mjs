// C2 真实 Cordis 语义：宿主在同一上下文里替换 tools 服务后，resolveTools() 必须立刻拿到新服务。
// 依赖宿主自带的 @deepseek-ai/cordis（在 app.asar 里）。找不到就 skip，不让 CI 因缺宿主而红。
// 跑法: node --test test/c2-real-cordis.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASAR = process.env.DSH_ASAR || 'D:/DeepSeekHarness/DSH NEXT/resources/app.asar'
const PKGS = ['@deepseek-ai/cordis', '@deepseek-ai/cosmokit']

// 从 asar 里抽出 cordis + cosmokit 的 package.json / lib/index.js（缓存到临时目录，避免每次解压）。
function extractCordis(root) {
  const buf = fs.readFileSync(ASAR)
  const headerSize = buf.readUInt32LE(4)
  const dataStart = 8 + headerSize
  const headerLen = buf.readUInt32LE(12)
  const index = JSON.parse(buf.subarray(16, 16 + headerLen).toString('utf8'))
  let found = 0
  const walk = (node, prefix) => {
    for (const key of Object.keys(node.files || {})) {
      const child = node.files[key]
      const full = prefix ? `${prefix}/${key}` : key
      if (child.files) { walk(child, full); continue }
      const hit = PKGS.find((name) => full === `node_modules/${name}/package.json` || full === `node_modules/${name}/lib/index.js`)
      if (!hit) continue
      const dest = path.join(root, full)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const offset = Number(child.offset)
      fs.writeFileSync(dest, buf.subarray(dataStart + offset, dataStart + offset + child.size))
      found += 1
    }
  }
  walk(index, '')
  return found
}

async function loadRealCordis() {
  if (!fs.existsSync(ASAR)) return null
  const root = path.join(os.tmpdir(), 'advisor-cordis-c2')
  const entry = path.join(root, 'node_modules/@deepseek-ai/cordis/lib/index.js')
  if (!fs.existsSync(entry)) {
    if (extractCordis(root) < 4 || !fs.existsSync(entry)) return null
  }
  const mod = await import(pathToFileURL(entry).href)
  return mod.Context || mod.default
}

const Context = await loadRealCordis()

test('C2：真实 Cordis 上下文里替换 tools 服务，resolveTools() 立即看到新服务', { skip: Context ? false : `${ASAR} 不可读，跳过真实 Cordis 用例` }, async () => {
  const { __test } = await import(pathToFileURL(join(PLUGIN_DIR, 'index.js')).href)

  const ctx = new Context()
  const serviceA = { list: async () => [{ name: 'read' }, { name: 'pwsh' }] }
  const serviceB = { list: async () => [{ name: 'read' }, { name: 'write' }, { name: 'pwsh' }] }

  ctx.provide('tools')
  ctx.tools = serviceA
  __test.setHostContext(ctx)
  try {
    assert.equal(__test.resolveTools(), serviceA, '初始应解析到 A')
    const first = await __test.toolSnapshotOf()
    assert.equal(first.trusted, true)

    // 同一上下文里替换服务（宿主热替换场景）
    ctx.tools = serviceB
    assert.equal(__test.resolveTools(), serviceB, '替换后必须解析到 B，不能停在旧句柄')
    const second = await __test.toolSnapshotOf()
    assert.equal(second.trusted, true)
    assert.notEqual(second.digest, first.digest, '工具集变了，摘要必须变')

    // 子上下文继承同一个解析结果（真实 cordis 的 extend 语义）
    const child = ctx.extend({})
    assert.equal(child.get('tools'), serviceB, '子上下文应继承同一份服务')
  } finally {
    __test.setHostContext(null)
  }
})

test('R3：卸载只清自己的绑定，不误清另一个实例的上下文', { skip: Context ? false : '缺少真实 Cordis' }, async () => {
  const { __test } = await import(pathToFileURL(join(PLUGIN_DIR, 'index.js')).href)

  const ctxA = new Context()
  const ctxB = new Context()
  const serviceB = { list: async () => [{ name: 'read' }] }
  ctxB.provide('tools')
  ctxB.tools = serviceB

  const disposeA = __test.bindHostContext(ctxA)
  const disposeB = __test.bindHostContext(ctxB)
  assert.equal(__test.resolveTools(), serviceB, '后绑定的 B 应该是现役')

  // A 的清理发生得比 B 晚（重载时序）——不能把 B 的绑定清掉。
  disposeA()
  assert.equal(__test.resolveTools(), serviceB, 'A 卸载不应影响 B')

  disposeB()
  assert.equal(__test.resolveTools(), null, 'B 卸载后应回到未绑定')
})
