// 路径边界判定的回归测试（顾问 GO 里点名的 T7–T10）：
// 同名前缀兄弟目录、UNC 共享根、\\?\ 扩展前缀、驱动器相对路径、大小写语义、符号链接。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { isInsideNormalized, isInside, stripExtendedPath, isDriveRelative, isWindows } from '../scripts/selfcheck.mjs'

const WIN = isWindows()

test('T7 同名前缀兄弟目录不得被当成内部', () => {
  if (!WIN) return
  assert.equal(isInsideNormalized('C:\\work', 'C:\\work\\notes'), true)
  assert.equal(isInsideNormalized('C:\\work', 'C:\\workspace-escape\\notes'), false)
  assert.equal(isInsideNormalized('C:\\work', 'C:\\work2'), false)
  assert.equal(isInsideNormalized('C:\\work', 'C:\\work\\..\\work-escape\\x'), false)
})

test('T8 UNC 共享根不同不得互为内部，同根之下可以', () => {
  if (!WIN) return
  assert.equal(isInsideNormalized('\\\\srv\\share', '\\\\srv\\share\\ws\\notes'), true)
  assert.equal(isInsideNormalized('\\\\srv\\share', '\\\\srv\\other\\ws'), false)
  assert.equal(isInsideNormalized('\\\\srv\\share', '\\\\srv2\\share\\ws'), false)
})

test('T9 \\\\?\\ 扩展前缀规范化后仍按边界判定，驱动器相对路径一律拒绝', () => {
  assert.equal(stripExtendedPath('\\\\?\\C:\\a\\b'), 'C:\\a\\b')
  assert.equal(stripExtendedPath('\\\\?\\UNC\\srv\\share\\x'), '\\\\srv\\share\\x')
  assert.equal(isDriveRelative('C:foo'), true)
  assert.equal(isDriveRelative('C:\\foo'), false)
  assert.equal(isDriveRelative('/x/foo'), false)
  if (WIN) {
    assert.equal(isInsideNormalized('\\\\?\\C:\\a', '\\\\?\\C:\\a\\b'), true)
    assert.equal(isInsideNormalized('C:\\a', 'C:b\\c'), false)
    assert.equal(isInsideNormalized('C:\\a', '\\\\?\\D:\\a\\b'), false)
  }
})

test('T10 大小写按平台语义：Windows 不敏感，POSIX 敏感', () => {
  if (WIN) {
    assert.equal(isInsideNormalized('C:\\Work', 'c:\\work\\notes'), true)
  } else {
    assert.equal(isInsideNormalized('/tmp/Work', '/tmp/work/notes'), false)
  }
  // 非绝对路径永远不是"内部"
  assert.equal(isInsideNormalized('relative', 'relative/x'), false)
  assert.equal(isInsideNormalized('C:\\a', ''), false)
})

test('T10b 符号链接逃逸必须被判为外部（realpath 语义）', async () => {
  const base = await mkdtemp(join(tmpdir(), 'adv-path-'))
  try {
    const root = join(base, 'ws')
    const outside = join(base, 'outside')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'x')
    const link = join(root, 'escape')
    await symlink(outside, link, 'junction').catch(() => symlink(outside, link).catch(() => null))
    // 链接存在时，候选路径的真实目标在 root 之外 → 必须 false
    if (await isInside(root, link)) {
      assert.fail('指向外部的符号链接被误判为内部')
    }
    // 普通子路径仍然 true
    assert.equal(await isInside(root, join(root, 'sub', 'notes')), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
