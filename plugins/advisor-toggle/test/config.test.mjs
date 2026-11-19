// 配置解析的边界测试：对应顾问 GO 的 A/B/D/F 组与"空值语义"8 条组合。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig, workspaceConfig, bridgeConfig, resolveHome, resolveInside } from '../config.js'

async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), 'adv-cfg-'))
  const ws = join(base, 'ws')
  await mkdir(ws, { recursive: true })
  return { base, ws, done: () => rm(base, { recursive: true, force: true }) }
}

test('workspace: 空值语义 8 种组合', async () => {
  const box = await sandbox()
  try {
    const blanks = [undefined, null, '', '   ']
    for (const value of blanks) {
      const none = await workspaceConfig({ workspace: value }, { DSH_HOME: box.base })
      assert.equal(none.state, 'unconfigured', `workspace=${JSON.stringify(value)} 且无环境变量应为 unconfigured`)
      const fromEnv = await workspaceConfig({ workspace: value }, { DSH_WORKSPACE: box.ws, DSH_HOME: box.base })
      assert.equal(fromEnv.state, 'ready', `workspace=${JSON.stringify(value)} 有环境变量时应回退到 ready`)
      assert.equal(fromEnv.source, 'env')
    }
  } finally {
    await box.done()
  }
})

test('workspace: 提供了值但不合法的四种情况都 invalid', async () => {
  const box = await sandbox()
  try {
    const rel = await workspaceConfig({ workspace: 'relative/path' }, {})
    assert.equal(rel.state, 'invalid')
    assert.equal(rel.reason, 'workspace-not-absolute')

    const missing = await workspaceConfig({ workspace: join(box.base, 'nope') }, {})
    assert.equal(missing.reason, 'workspace-missing')

    const file = join(box.base, 'a-file')
    await writeFile(file, 'x')
    const notDir = await workspaceConfig({ workspace: file }, {})
    assert.equal(notDir.reason, 'workspace-not-directory')

    const link = join(box.base, 'ws-link')
    await symlink(box.ws, link, 'dir')
    const viaLink = await workspaceConfig({ workspace: link }, {})
    assert.equal(viaLink.state, 'ready')
    assert.equal(viaLink.path, await (await import('node:fs/promises')).realpath(box.ws))
  } finally {
    await box.done()
  }
})

test('notesDir 与 bridgeConfigPath 默认落在 workspace 内', async () => {
  const box = await sandbox()
  try {
    const resolved = await workspaceConfig({ workspace: box.ws }, {})
    assert.equal(resolved.state, 'ready')
    const root = resolved.path.toLowerCase()
    assert.ok(resolved.notesDir.toLowerCase().startsWith(root))
    assert.ok(resolved.bridgeConfigPath.toLowerCase().startsWith(root))
  } finally {
    await box.done()
  }
})

test('gpt-notes 本身是指向 workspace 外的目录符号链接 → 拒绝', async () => {
  const box = await sandbox()
  try {
    const outside = join(box.base, 'outside-notes')
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(box.ws, 'gpt-notes'), 'dir')
    const resolved = await workspaceConfig({ workspace: box.ws }, {})
    assert.equal(resolved.state, 'invalid')
    assert.match(resolved.reason, /notes-path-escape/)
  } finally {
    await box.done()
  }
})

test('bridge config.json 本身是指向 workspace 外的文件符号链接 → 拒绝', async () => {
  const box = await sandbox()
  try {
    const bridgeDir = join(box.ws, '雷电bridge', 'windows-bridge')
    await mkdir(bridgeDir, { recursive: true })
    const outsideFile = join(box.base, 'outside.json')
    await writeFile(outsideFile, '{"token":"x"}')
    await symlink(outsideFile, join(bridgeDir, 'config.json'), 'file')
    const resolved = await workspaceConfig({ workspace: box.ws }, {})
    assert.equal(resolved.state, 'invalid')
    assert.match(resolved.reason, /bridge-config-path-escape/)
  } finally {
    await box.done()
  }
})

test('目标不存在时按最近存在祖先重建，且重建结果仍在 workspace 内', async () => {
  const box = await sandbox()
  try {
    const result = await resolveInside(box.ws, join(box.ws, 'gpt-notes'))
    assert.equal(result.ok, true)
    const root = (await (await import('node:fs/promises')).realpath(box.ws)).toLowerCase()
    assert.ok(result.resolved.toLowerCase().startsWith(root))
    const escape = await resolveInside(box.ws, join(box.ws, '..', 'outside'))
    assert.equal(escape.ok, false)
    assert.equal(escape.reason, 'path-escape')
  } finally {
    await box.done()
  }
})

test('桥状态：文件缺失 / JSON 坏 / 缺 token 都是 unconfigured', async () => {
  const box = await sandbox()
  try {
    const none = await bridgeConfig(join(box.base, 'missing.json'), {})
    assert.equal(none.state, 'unconfigured')
    assert.equal(none.reason, 'bridge-token-missing')

    const bad = join(box.base, 'bad.json')
    await writeFile(bad, '{not json')
    const invalid = await bridgeConfig(bad, {})
    assert.equal(invalid.state, 'unconfigured')
    assert.equal(invalid.reason, 'bridge-config-invalid-json')

    const noToken = join(box.base, 'no-token.json')
    await writeFile(noToken, '{"baseUrl":"http://127.0.0.1:1"}')
    const tokenMissing = await bridgeConfig(noToken, {})
    assert.equal(tokenMissing.reason, 'bridge-token-missing')
  } finally {
    await box.done()
  }
})

test('桥状态：配置有效但连不上 → unreachable；能连 → ready', async () => {
  const box = await sandbox()
  try {
    const file = join(box.base, 'bridge.json')
    await writeFile(file, JSON.stringify({ token: 't', baseUrl: 'http://127.0.0.1:1' }))
    const down = await bridgeConfig(file, {}, { fetchImpl: async () => { throw Object.assign(new Error('boom'), { name: 'AbortError' }) } })
    assert.equal(down.state, 'unreachable')

    const up = await bridgeConfig(file, {}, { fetchImpl: async () => ({ ok: true, status: 200 }) })
    assert.equal(up.state, 'ready')
    assert.equal(up.token, 't')
  } finally {
    await box.done()
  }
})

test('桥健康探测超时不会拖住初始化（3 秒上限）', async () => {
  const box = await sandbox()
  try {
    const file = join(box.base, 'bridge.json')
    await writeFile(file, JSON.stringify({ token: 't', baseUrl: 'http://127.0.0.1:1' }))
    const started = Date.now()
    const slow = await bridgeConfig(file, {}, {
      timeoutMs: 200,
      fetchImpl: () => new Promise((_resolve, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'AbortError' })), 5000)),
    })
    assert.equal(slow.state, 'unreachable')
    assert.ok(Date.now() - started < 2000)
  } finally {
    await box.done()
  }
})

test('DSH_HOME：有变量 / 无变量 / 目录不可创建三种情况都不抛错', async () => {
  const box = await sandbox()
  try {
    const withVar = resolveHome({ DSH_HOME: join(box.base, 'home1') })
    assert.ok(withVar.logDir.startsWith(join(box.base, 'home1')))
    const withoutVar = resolveHome({})
    assert.ok(withoutVar.logDir.length > 0)
    const blocker = join(box.base, 'blocker')
    await writeFile(blocker, 'x')
    const broken = resolveHome({ DSH_HOME: join(blocker, 'database') })
    assert.ok(broken.logDir.startsWith(blocker))
  } finally {
    await box.done()
  }
})

test('resolveConfig 汇总三态（未配置 / 有 workspace 无桥 / 都正常）', async () => {
  const box = await sandbox()
  try {
    const unconfigured = await resolveConfig({}, { DSH_HOME: box.base })
    assert.equal(unconfigured.workspace.state, 'unconfigured')
    assert.equal(unconfigured.bridge.state, 'unconfigured')

    const noBridge = await resolveConfig({ workspace: box.ws }, { DSH_HOME: box.base })
    assert.equal(noBridge.workspace.state, 'ready')
    assert.equal(noBridge.bridge.state, 'unconfigured')

    const bridgeFile = join(box.ws, '雷电bridge', 'windows-bridge', 'config.json')
    await mkdir(join(box.ws, '雷电bridge', 'windows-bridge'), { recursive: true })
    await writeFile(bridgeFile, JSON.stringify({ token: 't', baseUrl: 'http://127.0.0.1:1' }))
    const both = await resolveConfig(
      { workspace: box.ws, fetchImpl: async () => ({ ok: true, status: 200 }) },
      { DSH_HOME: box.base },
    )
    assert.equal(both.workspace.state, 'ready')
    assert.equal(both.bridge.state, 'ready')
  } finally {
    await box.done()
  }
})
