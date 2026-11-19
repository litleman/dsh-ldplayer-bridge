import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'index.js'), 'utf8')

// 事故背景（2026-11-19）：harness 重启后 webServer 比本插件晚就绪，
// apply() 里 `if (!webServer?.register) { log(...); return }` 直接返回，
// 路由没挂上 → 浏览器半 fetch 401/404 → 胶囊显示「状态同步失败（可能不是最新）」。
// 现在改成「拿不到就每秒重试」，这里把这条行为钉进源码断言，防止回退。

test('webServer 未就绪时不再提前 return（否则浏览器半永远拿不到状态）', () => {
  assert.ok(!/if \(!webServer\?\.register\) \{\s*log\('host:warn 没有 webServer 服务/.test(SOURCE),
    '不应再出现「拿不到 webServer 就 return」的旧写法')
  assert.ok(/const routeSpec = \(\) => \(\{/.test(SOURCE), '路由定义要能被延迟注册复用')
  assert.ok(/const registerRoutes = \(\) => \{/.test(SOURCE), '需要独立的注册函数供重试调用')
  assert.ok(/routeTimer = setInterval\(/.test(SOURCE), '拿不到 webServer 时要定时重试')
  assert.ok(/routeAttempts >= 60/.test(SOURCE), '重试要有上限，不能无限跑')
  assert.ok(/routeTimer\.unref/.test(SOURCE), '重试定时器不能阻止进程退出')
  assert.ok(/if \(routeDispose\) \{\s*routeDispose\(\)/.test(SOURCE), 'context 释放时要注销路由')
})
