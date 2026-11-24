# Git 提交/推送 runbook（advisor-toggle 批次）

这份 runbook 是**流程**，不是行为证据。行为证据是每条命令的原始输出（见验收记录）。

## 1. 提交前：配置审计（R1）

必须原样采集下面这些输出，贴进验收材料：

```powershell
cd 'D:\Administrator\allWorkFiles\ds-workspace'
git config --list --show-scope | Select-String '^(system|global|local)\s+(core\.|user\.|filter\.|url\.|remote\.|commit\.)'
git config --get-regexp '^filter\.'
git config --get-regexp '^url\.'
git remote -v
git config --get remote.origin.pushurl
git check-attr -a -- <本次改动的文件列表>
git rev-parse HEAD
```

判定规则：

- **必须禁用**（提交命令上显式覆盖）：`core.hooksPath`、`core.fsmonitor`、`commit.gpgsign`、`core.untrackedCache`。
- **允许继承但必须打印核对**：`user.name` / `user.email`、`core.autocrlf`、`core.quotepath`、`system` 层的 `filter.lfs.*`。
- **只读核对、发现异常就停**：
  - `filter.*` 存在 **且** `git check-attr` 显示本次文件命中该过滤器 → 停；
  - `url.*.insteadOf` / `remote.origin.pushurl` 与预期目标不一致 → 停；
  - `remote.origin.url` 不是预期仓库 → 停。
- 停下时**不要**擅自改仓库配置，报告后等人裁决。

## 2. 提交：带隔离配置 + HEAD 断言（R2）

```powershell
$before = git rev-parse HEAD
git add <显式文件列表>
git -c core.hooksPath= -c core.fsmonitor=false -c commit.gpgsign=false -c core.untrackedCache=false commit -m "<message>"
$new = git rev-parse HEAD
$parent = git rev-parse "$new^"
node -e "import('./plugins/advisor-toggle/scripts/git-guard.mjs').then(m=>console.log(JSON.stringify(m.evaluate({headBefore:'$before',headNow:'$new',actualParent:'$parent'}))))"
```

`git-guard` 返回 `action:'stop'` 时：

- **禁止**：`git reset`（任何形式）、`git checkout`、`git branch -f`、`git push --force`；
- 只允许：停止后续提交与推送，输出 `headBefore / headNow / expectedParent / actualParent`，标记"需人工恢复"。

## 3. 推送：显式 SHA + 远端复核

```powershell
$sha = git rev-parse HEAD
git ls-remote origin refs/heads/master     # 记录推送前远端 SHA
git push origin "${sha}:refs/heads/master" # 只推这个提交，不推分支名
git ls-remote origin refs/heads/master     # 必须等于 $sha
```

推送被拒（non-fast-forward 等）时：**不强推**，先拉取远端引用做对比，报告后再决定。

## 4. 收尾

- 记录：`HEAD_BEFORE` / `NEW` / `PARENT` / 远端 SHA（四个值一起贴在验收材料里）。
- 有任何一个 stop，就在验收材料里标红并说明"本批未提交/未推送"。
