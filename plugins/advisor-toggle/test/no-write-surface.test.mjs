// v11 结构断言：插件**没有任何写文件能力**。
// 这条测试的意义不是"跑通某个函数"，而是防止将来有人（包括我自己）把写面悄悄加回来：
// 一旦出现这些**可执行形式**（而不是注释里的提及），说明"收尾写文件"又被引入了。
// 跑法: node --test test/no-write-surface.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const index = await readFile(join(ROOT, 'index.js'), 'utf8')
const client = await readFile(join(ROOT, 'client.js'), 'utf8')
// 注释里会提到被删掉的实现（例如解释 TOCTOU 时写 open(...,'wx')），
// 结构断言只应看代码本身，所以先把整行注释去掉。
const indexCode = index
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n')

test('Host 半不存在收尾写面的任何可执行符号', () => {
  const forbidden = [
    "name: 'advisor_finalize_note'",
    'function finalizeCreate',
    'function trustedRoots',
    'function relUnderRoot',
    'function finalizeDecision',
    'FINALIZE_ONLY_TOOL =',
    'FINALIZE_COMMAND_RE',
    'FINALIZE_PATH_RE',
  ]
  for (const symbol of forbidden) {
    assert.equal(indexCode.includes(symbol), false, `index.js 里不该再出现 ${symbol}`)
  }
})

test('Host 半不再删除文件（写后复核失败也不 unlink）', () => {
  assert.equal(/await\s+unlink\(/.test(indexCode), false, '不该再 await unlink(...)')
  // open(...,'wx') 这种排他创建也属于写面
  assert.equal(/open\([^)\n]*'wx'/.test(indexCode), false, "不该再 open(..., 'wx')")
  // 唯一允许的删除是 saveNote 里对 gpt-notes 的旧笔记裁剪（保留 5 份），必须限定在 notesDir 内。
  const rmCalls = indexCode.match(/await\s+rm\(/g) || []
  assert.ok(rmCalls.length <= 1, `删除调用只允许 saveNote 的笔记裁剪，实际 ${rmCalls.length} 处`)
  if (rmCalls.length === 1) {
    assert.ok(indexCode.includes('notesDir'), '笔记裁剪必须绑定 notesDir')
  }
})

test('/state 不再暴露 finalize 许可，改为动态 writeSurface', () => {
  assert.equal(indexCode.includes('finalize: state.finalizePermit'), false)
  assert.ok(indexCode.includes('writeSurface: await writeSurface()'), '/state 必须用动态写面画像')
})

test('收尾阶段是纯只读（finalizePermit 与写许可状态已移除）', () => {
  assert.equal(indexCode.includes('state.finalizePermit'), false, 'stateOf 里不该还有 finalizePermit')
  assert.ok(indexCode.includes('paused: false'), 'paused 必须是独立布尔字段')
  assert.ok(indexCode.includes('mode=read-only'), '收尾阶段必须记 read-only 日志')
})

test('浏览器半的胶囊文案与 v11 一致（收尾只读、暂停用布尔）', () => {
  assert.ok(client.includes('收尾：只读'), 'delivering 阶段要说明只读')
  assert.ok(client.includes('const paused = Boolean(state.paused)'), '胶囊必须读 paused 布尔字段')
})
