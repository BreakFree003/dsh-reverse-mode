# dsh-prompt-inject-scoped

把一份文本文件的内容当**系统提示词**注入，**只对挂载它的那个 preset 生效**。宿主平面与其它预设
一点都不碰 —— 这是它存在的唯一理由。

## 谁在用它

`~/.dsh/profiles/web/cordis.patch.yml` 的 `preset-ida` 块（`- id: prompt-inject-scoped` 那一行），
配 `config.complete: true` + `config.file: $DSH_HOME/prompt-inject.md`。
那份 md（27,841 字节，2026-10-05 从 `~/.dsh/.backup/revert-purge-rs-20261005-055617/moved-prompt-inject.md`
归位）是**该预设唯一的系统提示词段落**；文件每次组装都重读 ⇒ 改 md 即热生效，不用重启。

## 为什么不是 bundle 包

bundle 的 `dsh.bundle.patch` 只能往 **profile 平面**插行 —— 那会让这份提示词注入**每一个预设**
（正是它要避免的）。所以它只被 `preset-ida` 按相对路径引用，不做 bundle、不进
`dsh.profile.bundles`。同类例外（`dsh-cwd-context-off`）已登记在 `AGENTS.md` 的「DSH 插件一律
做成 bundle 包」一节。

## 完整说明

设计、两种模式（`complete` 真/假的区别）、以及「为什么当年不继续用 `dsh-purge` 主行」的来龙去脉，
全部写在 `index.js` 顶部的注释里（40 余行）—— 改本插件前先读那里。

## 验收

预设有工具表与系统提示词两个面：**工具表**用
`node ~/Documents/Projects/dsh/dsh-upgrade-checks/dsh-preset-surface-audit.mjs ida`
（会打印工具数与运行时 sections）；**系统提示词**只能用真实会话肉眼确认（会话日志不记录组装后的
系统提示词）。文件读不到时本行整行不注册（退回常规系统提示词），不会得到空的系统提示词。
