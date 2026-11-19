# 写入面清单（write surface）

本文件回答一个问题：**这个插件到底会往磁盘写什么？** 门禁拦的是「Agent 的手」，所以必须先把插件自己能写的地方数清楚。

## 核查方法

```powershell
cd D:\Administrator\allWorkFiles\ds-workspace
git grep -nE 'writeFile|appendFile|createWriteStream|mkdir' -- plugins/advisor-toggle
git grep -nE 'createWriteStream' -- plugins/advisor-toggle tools
node -e "const p=require('./plugins/advisor-toggle/package.json');console.log(p.dependencies||{})"
```

结果：`dependencies` 为空对象（零运行时依赖），没有 `createWriteStream`，没有数据库、没有 JSON 状态落盘、没有 `child_process`。

> 注意：grep 只能证明「当前代码里出现在这些名字的写入点」，不能证明「没有别的写法」（比如 `fs.promises` 别名、间接引用）。所以本清单与代码同版本维护，**改动写入逻辑必须同步改这里**。

## 生产代码的写入点（共 4 处）

| # | 位置 | 目标 | 语义 | 失败处理 |
|---|------|------|------|----------|
| W1 | `index.js:175-176` | `%DSH_HOME%\logs\advisor-toggle.log` | `mkdir(LOG_DIR,{recursive:true})` + `appendFile`，追加一行日志 | 整体 try/catch，写日志失败不影响业务 |
| W2 | `index.js:385` | `DEFAULTS.notesDir` | `mkdir(dir,{recursive:true})` 建会话目录 | 抛错由调用方 catch 成 `ok:false` |
| W3 | `index.js:410` | `notesDir/<会话>/<ISO 时间>-<阶段>.md` | `writeFile(...,{flag:'wx'})`，新建审计笔记，已存在则换随机 tag 重试 | 重试一次后抛错 |
| W4 | `tools/audit.mjs:408-426` | `gpt-notes/audit/<stamp>-audit.md` | `mkdir` + `writeFile`，写对抗评审报告 | 失败直接抛错（命令行工具，用户可见） |

路径约束：

- W2/W3 用 `path.relative()` 检查结果必须仍在 `notesDir` 内，越界即抛错（防会话 id 里的 `..`）。
- 文件名里的会话 id 去掉前导点；时间戳用 ISO 的 `:`→`-` 形式，避免 Windows 非法字符。
- `notesDir` 默认在 `D:\Administrator\allWorkFiles\ds-workspace\gpt-notes`，**在 git 仓库里**，因此版本指纹必须排除它（`VERSION_EXCLUDES`/`isExcludedPath`）。

## 插件不写的东西（明确声明）

- 不写工作区源码：没有任何 `writeFile` 指向 `plugins/` 之外的业务文件。
- 不落盘对话状态：所有 state 都在内存 `sessions: Map` 里，重启即清零（`apply()` 里 `sessions.clear()`）。
- 不写数据库、不调外部 CLI、不建临时文件（测试除外）。

## 与门禁的关系

门禁（`tools/pre-execute`）只决定**是否放行 Agent 的工具调用**；上面 4 处写入是插件自身行为，不受门禁影响，也不构成绕过——它们的目标路径是固定的，且不含用户可控的任意路径。

唯一的「Agent 可影响」的写入是 `advisor_review`/`advisor_plan` 触发的笔记正文（W3），内容来自评审往返，且写入前经过 `redactForAdvisor`（见 `docs/threat-model.md` 第 4 节）。

## 变更规则

1. 新增任何写入点，必须在本表加一行，并在 PR/提交说明里写明目标路径与失败语义。
2. 目标路径若可被会话数据影响，必须过 `path.relative()` 边界检查。
3. 目标路径若在 git 仓库内，必须同时更新 `VERSION_EXCLUDES`/`VERSION_EXCLUDED_SEGMENTS`，否则版本指纹会自指抖动（v0.1 的真实事故）。
