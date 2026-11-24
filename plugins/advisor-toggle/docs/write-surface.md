# 写入面清单（write surface）

本文件回答一个问题：**这个插件到底会往磁盘写什么？** 门禁拦的是「Agent 的手」，所以必须先把插件自己能写的地方数清楚。

## v11 的关键变化

v11 起**插件没有任何"收尾写文件"能力**：`advisor_finalize_note` 工具与 `finalizeCreate/trustedRoots/relUnderRoot` 已整体删除（理由见 `docs/threat-model.md` 第 10.1 节：Windows + Node 无法把"创建"绑定到已验证的目录句柄，写前 TOCTOU 消除不了）。现在插件能写的只剩**日志**与**评审笔记**两类固定路径。

## 核查方法（完整 API 扫描，不只关键词）

```powershell
cd D:\Administrator\allWorkFiles\ds-workspace
# 同步/异步写、句柄、复制、重命名、删除、子进程
git grep -nE 'writeFile|appendFile|createWriteStream|writeFileSync|appendFileSync|mkdirSync|renameSync|unlinkSync|copyFileSync|\bcp\(|FileHandle|\.write\(|open\(|rm\(|unlink\(|rename\(|copyFile\(' -- plugins/advisor-toggle
# 子进程（插件不得自己跑命令）
git grep -nE 'child_process|spawn|execFile|execSync|spawnSync' -- plugins/advisor-toggle/index.js
node -e "const p=require('./plugins/advisor-toggle/package.json');console.log(p.dependencies||{})"
```

扫描结论（2026-11-24，提交 `8f5d15d` 之后）：

- `index.js`（生产宿主半）里的写入只有 4 个调用：`mkdir(LOG_DIR)`、`appendFile(BOOT_LOG)`、`mkdir(dir)`、`writeFile(file, …, {flag:'wx'})`（+ 一次同目录重试）。
- `index.js` 里**没有** `writeFileSync`/`appendFileSync`/`mkdirSync`/`renameSync`/`unlinkSync`/`copyFileSync`/`cp(`/`FileHandle`/`createWriteStream`。
- `index.js` 里有 `execFile`，但只用于 `git` 读取（`rev-parse`/`status`/`diff`），且 `run()` 是唯一的调用点；没有任何写文件型命令。
- `dependencies` 为空对象（零运行时依赖），没有数据库、没有 JSON 状态落盘。
- 其余命中全部在 `scripts/`（证据采集/自检）与 `test/`（测试夹具）里，属于开发者工具，不参与运行时。

> 注意：grep 只能证明「当前代码里出现了哪些名字」，不能证明「没有别的写法」（别名、间接引用、动态 require）。所以本清单与代码同版本维护，**改动写入逻辑必须同步改这里**；`test/no-write-surface.test.mjs` 会对生产文件做结构断言，防止写面回潮。

## 与「宿主工具写面」的区别（v11.1 模型 A）

本文件只统计**插件自己**的写入。`edit`/`write`/`apply_patch`/`pwsh`/`cua_*` 这些是**宿主工具**的写面，插件管不到它们的实现：

- 插件能做的是**授权前**的路径校验（`allowed_paths`）与**执行后**的审计（journal），不是拦截宿主工具内部行为。
- 因此"插件零写面"不等于"这一批活只改允许的路径"——后者依赖 `allowed_paths` 声明 + 事后 diff 核对。
- `docs/threat-model.md` 第 11 节列出这条边界与残余风险；改动这两档约束的语义时，三份文档（本文件、威胁模型、README）必须一起改。


## 生产代码的写入点（v11 共 4 处，全部固定路径）

| # | 位置 | 目标 | 语义 | 失败处理 |
|---|------|------|------|----------|
| W1 | `index.js:249-250` | `%DSH_HOME%\logs\advisor-toggle.log` | `mkdir(LOG_DIR,{recursive:true})` + `appendFile`，追加一行日志 | 整体 try/catch，写日志失败不影响业务 |
| W2 | `index.js:475` | `DEFAULTS.notesDir` | `mkdir(dir,{recursive:true})` 建会话目录 | 抛错由调用方 catch 成 `ok:false` |
| W3 | `index.js:500` | `notesDir/<会话>/<ISO 时间>-<阶段>-<reqid>.md` | `writeFile(...,{flag:'wx'})` 新建审计笔记，重名则换随机 tag 重试一次 | 重试仍失败则抛错（`ok:false`） |
| W4 | `tools/audit.mjs:408,426` | `gpt-notes/audit/<stamp>-audit.md` | `mkdir` + `writeFile`，写对抗评审报告 | 命令行工具，失败直接抛错、用户可见 |

路径约束：

- W2/W3 用 `path.relative()` 检查结果必须仍在 `notesDir` 内，越界即抛错（防会话 id 里的 `..`）。
- 文件名里的会话 id 去掉前导点；时间戳用 ISO 的 `:`→`-` 形式，避免 Windows 非法字符。
- `notesDir` 默认在 `D:\Administrator\allWorkFiles\ds-workspace\gpt-notes`，**在 git 仓库里**，因此版本指纹必须排除它（`VERSION_EXCLUDES`/`isExcludedPath`）。

## 插件不写的东西（明确声明）

- **不写工作区源码**：v11 起没有任何"由 Agent 传入目标路径"的写入；`plugins/` 之外的业务文件一律不可写。
- 不写 `docs/`：收尾阶段的"写文档"由关掉开关后的人（或 Agent 用普通写工具）完成。
- 不落盘对话状态：所有 state 都在内存 `sessions: Map` 里，重启即清零（`apply()` 里 `sessions.clear()`）。
- 不写数据库、不建临时文件（测试除外）。

## 与门禁的关系

门禁（`tools/pre-execute`）只决定**是否放行 Agent 的工具调用**；上面 4 处写入是插件自身行为，不受门禁影响，也不构成绕过——它们的目标路径固定，且不含用户可控的任意路径。

唯一的「Agent 可影响」的写入是 `advisor_review`/`advisor_plan` 触发的笔记正文（W3），内容来自评审往返，写入前经过 `redactForAdvisor`（见 `docs/threat-model.md` 第 4 节）。

## 变更规则

1. 新增任何写入点，必须在本表加一行，并在提交说明里写明目标路径与失败语义。
2. 目标路径若可被会话数据影响，必须过 `path.relative()` 边界检查。
3. 目标路径若在 git 仓库内，必须同时更新 `VERSION_EXCLUDES`/`VERSION_EXCLUDED_SEGMENTS`，否则版本指纹会自指抖动（v0.1 的真实事故）。
4. **禁止恢复"按调用方给的路径写文件"的能力**（`flag:'wx'` + 任意路径那一类）；`test/no-write-surface.test.mjs` 会直接失败。
