// 自检扫描器本身的测试：正例必须命中、反例不得误报，缺文件/坏文件必须失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { scanText, scanPlugin, runSelfcheck } from '../scripts/selfcheck.mjs'

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

test('分发模式检查必需文件与入口语法', async () => {
  const result = await runSelfcheck({ root: PLUGIN_DIR, dist: true })
  assert.equal(result.ok, true, result.problems.join('\n'))
})
