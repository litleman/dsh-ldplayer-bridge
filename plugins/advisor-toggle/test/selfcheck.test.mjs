// 自检扫描器本身的测试：正例必须命中、反例不得误报，缺文件/坏文件必须失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { scanText, scanPlugin, runSelfcheck, SCAN_TARGETS } from '../scripts/selfcheck.mjs'

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

const POSITIVE = [
  ['windows-drive', String.raw`D:\Administrator\allWorkFiles\ds-workspace`],
  ['posix-home', '/Users/someone/project'],
  ['unc', String.raw`\\server\share\project`],
  ['dsh-home', String.raw`D:\DeepSeekHarness\database\logs\advisor-toggle.log`],
]

const NEGATIVE = ['plugins/advisor-toggle/src', 'workspace: guailin-kb', 'https://github.com/litleman/dsh-ldplayer-bridge']

test('正例四条都必须命中', () => {
  for (const [name, sample] of POSITIVE) {
    const hits = scanText(sample, 'sample.txt')
    assert.ok(hits.length > 0, `${name} 应命中：${sample}`)
    assert.ok(hits.some((hit) => hit.pattern === name), `${name} 命中类型不符：${JSON.stringify(hits)}`)
  }
})

test('反例三条不得误报', () => {
  for (const sample of NEGATIVE) {
    assert.deepEqual(scanText(sample, 'sample.txt'), [], `不应命中：${sample}`)
  }
})

test('本插件默认文件与 README 全量扫描零命中', async () => {
  const scan = await scanPlugin(PLUGIN_DIR)
  assert.deepEqual(scan.problems, [])
  assert.deepEqual(scan.hits, [])
})

test('植入机器路径到 locale/zh.json 后自检必须失败', async () => {
  const copy = await mkdtemp(join(tmpdir(), 'adv-scan-'))
  const target = join(copy, 'plugin')
  try {
    await cp(PLUGIN_DIR, target, { recursive: true, filter: (src) => !/[\\/](gpt-notes|node_modules|\.git)([\\/]|$)/.test(src) })
    const zhPath = join(target, 'locale', 'zh.json')
    const zh = JSON.parse(await readFile(zhPath, 'utf8'))
    zh.meta.description = `${zh.meta.description || ''} ${String.raw`D:\Administrator\allWorkFiles`}`
    await writeFile(zhPath, JSON.stringify(zh, null, 2))
    const scan = await scanPlugin(target)
    assert.ok(scan.hits.some((hit) => hit.file.includes('zh.json')), '植入的路径必须被扫到')
    const result = await runSelfcheck({ root: target })
    assert.equal(result.ok, false)
  } finally {
    await rm(copy, { recursive: true, force: true })
  }
})

test('删掉扫描目标后自检必须失败（而不是跳过）', async () => {
  const copy = await mkdtemp(join(tmpdir(), 'adv-scan-'))
  const target = join(copy, 'plugin')
  try {
    await cp(PLUGIN_DIR, target, { recursive: true, filter: (src) => !/[\\/](gpt-notes|node_modules|\.git)([\\/]|$)/.test(src) })
    await rm(join(target, 'locale', 'en.json'))
    // 缺文件必须让整体自检失败（结构检查会报"缺少文件"），不能因为扫描列表里没有它就跳过。
    const scan = await scanPlugin(target)
    const result = await runSelfcheck({ root: target })
    const problems = [...scan.problems, ...result.problems].join('\n')
    assert.ok(problems.includes('en.json'), '缺失文件必须报 problem')
    assert.equal(result.ok, false)
  } finally {
    await rm(copy, { recursive: true, force: true })
  }
})

test('README.md 在扫描范围内（植入即失败）', async () => {
  const copy = await mkdtemp(join(tmpdir(), 'adv-scan-'))
  const target = join(copy, 'plugin')
  try {
    await cp(PLUGIN_DIR, target, { recursive: true, filter: (src) => !/[\\/](gpt-notes|node_modules|\.git)([\\/]|$)/.test(src) })
    const readme = join(target, 'README.md')
    const text = await readFile(readme, 'utf8')
    await writeFile(readme, `${text}\n\n${String.raw`C:\Users\someone\project`}\n`)
    const scan = await scanPlugin(target)
    assert.ok(scan.hits.some((hit) => hit.file === 'README.md'))
  } finally {
    await rm(copy, { recursive: true, force: true })
  }
})

test('config.js 也在扫描目标内（P0-1 回归：植入路径必须失败）', async () => {
  assert.ok(SCAN_TARGETS.includes('config.js'), 'SCAN_TARGETS 必须包含 config.js')
  const copy = await mkdtemp(join(tmpdir(), 'adv-scan-'))
  const target = join(copy, 'plugin')
  try {
    await cp(PLUGIN_DIR, target, { recursive: true, filter: (src) => !/[\\/](gpt-notes|node_modules|\.git)([\\/]|$)/.test(src) })
    const file = join(target, 'config.js')
    const text = await readFile(file, 'utf8')
    await writeFile(file, `${text}\n// ${String.raw`D:\Administrator\allWorkFiles\ds-workspace`}\n`)
    const scan = await scanPlugin(target)
    assert.ok(scan.hits.some((hit) => hit.file === 'config.js'), 'config.js 里的机器路径必须被扫到')
    assert.equal((await runSelfcheck({ root: target })).ok, false)
  } finally {
    await rm(copy, { recursive: true, force: true })
  }
})

test('分发模式：独立副本通过，源码目录被拒绝，缺 --root 直接失败（P0-2 回归）', async () => {
  const copy = await mkdtemp(join(tmpdir(), 'adv-dist-'))
  const target = join(copy, 'dist')
  try {
    await cp(PLUGIN_DIR, target, { recursive: true, filter: (src) => !/[\\/](gpt-notes|node_modules|\.git)([\\/]|$)/.test(src) })
    const fromCopy = await runSelfcheck({ root: target, dist: true, sourceDir: PLUGIN_DIR })
    assert.equal(fromCopy.ok, true, fromCopy.problems.join('\n'))

    const fromSource = await runSelfcheck({ root: PLUGIN_DIR, dist: true, sourceDir: PLUGIN_DIR })
    assert.equal(fromSource.ok, false, '--dist 指向源码目录必须失败')
    assert.ok(fromSource.problems.some((problem) => problem.startsWith('dist-root-same-as-source')), fromSource.problems.join('\n'))

    // 在分发副本里跑时脚本自身位置就是副本，不能拿它当"源码目录"——必须显式给 --source，否则拒判。
    const noSource = await runSelfcheck({ root: target, dist: true })
    assert.equal(noSource.ok, false)
    assert.ok(noSource.problems.some((problem) => problem.startsWith('source-root-unknown')), noSource.problems.join('\n'))
  } finally {
    await rm(copy, { recursive: true, force: true })
  }
})

test('CLI：--dist 不带 --root 直接退出码 2', async () => {
  const script = join(PLUGIN_DIR, 'scripts', 'selfcheck.mjs')
  const code = await new Promise((resolveCode) => {
    execFile(process.execPath, [script, '--dist'], (error) => resolveCode(error ? error.code : 0))
  })
  assert.equal(code, 2)
})
