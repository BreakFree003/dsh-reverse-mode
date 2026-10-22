# dsh-reverse-mode

把本机 dsh 的 **「逆向模式（IDA Pro MCP）」** 预设一键装到另一台已经装了 dsh 的电脑上
（Windows / macOS / Linux 同一条命令）。

目标机**不需要**先有 dsh 的任何本机定制 —— 安装器读它自己的随包 `standard` 预设现场生成，
所以 dsh 升级后重跑一遍就自动跟上新行。

```powershell
git clone https://github.com/BreakFree003/dsh-reverse-mode.git
cd dsh-reverse-mode
node install.mjs
```

> 本仓库是 **private**：目标机得能访问 GitHub。最省事是那台机器上 `gh auth login` 过一次，
> 然后 `gh repo clone BreakFree003/dsh-reverse-mode`；也可以用 PAT：
> `git clone https://<token>@github.com/BreakFree003/dsh-reverse-mode.git`。
> 想彻底免登录：`gh repo edit --visibility public`（先把 `assets/prompt-inject.md` 换成你自己的）。

装完重启 dsh → 新建会话 → 选择器里选 **「逆向模式（IDA Pro MCP）」**。

---

## 它到底装了什么

| # | 动作 | 落点 |
|---|---|---|
| 1 | 以**目标机自己的** `standard.patch.yml` 为基准，生成 `ida` 预设 | `<profile>/cordis.patch.yml` 里的哨兵区块 |
| 2 | 复制系统提示词（27.8 KB，整份替换用） | `<DSH_HOME>/prompt-inject.md` |
| 3 | 复制 `dsh-prompt-inject-scoped` 插件（单文件 ESM，零依赖） | `<profile>/plugins/dsh-prompt-inject-scoped/` |
| 4 | clone 技能仓库并生成技能树（**复制**，不建软链） | `<DSH_HOME>/vendor/reverse-skill` → `reverse-ida/{skills,ctf}` |
| 5 | 补装 MCP 客户端包（随包 profile 里没有） | `dsh plugin add @deepseek-ai/dsh-mcp-client@<运行时版本>` |

生成出来的预设 = 目标机 standard **原样** + 三处增量：

- `plugins` 首行 `prompt-inject-scoped`（`complete: true` + `suppressRuntimeContext: true`，
  于是本预设的系统提示词**只剩这一份文件**，persona / 工具指引 / 仓库 AGENTS.md / 动态上下文都不再注入；
  工具表不受影响）；
- `skill-filesystem` 的 `customSkillDirs` 多扫两个根（46 + 42 条技能）；
- `plugins` 末尾 `mcp-ida-pro` → `@deepseek-ai/dsh-mcp-client` 拉起 `idalib-mcp --stdio`。

`cordis.patch.yml` 只动哨兵区块：

```yaml
# >>> dsh-reverse-mode (generated; 重复执行 install.mjs 会替换本区块，删除即卸载) >>>
- insert:
    - id: preset-ida
      ...
# <<< dsh-reverse-mode <<<
```

第一次写入前会备份成 `cordis.patch.yml.bak-reverse-mode-<时间戳>`；重复执行是替换，不会堆叠。

---

## IDA 还没装？

可以先装预设：这时 MCP 那行写成 `disabled: true`，逆向模式照样出现在选择器里，只是没有 IDA 工具。
装好 IDA（≥ 8.3，9 推荐；**IDA Free 不支持**）之后：

```powershell
# 1) 激活 idalib（路径按你的 IDA 版本改）
uv run "C:\Program Files\IDA Professional 9.3\idalib\python\py-activate-idalib.py"

# 2) 装 idalib-mcp
uv tool install ida-pro-mcp          # 或：pipx install ida-pro-mcp

# 3) 告诉安装器 MCP 在哪（会自动去掉 disabled）
node install.mjs --mcp "C:\Users\<你>\.local\bin\idalib-mcp.exe"
```

`uv tool` 的 bin 目录：Windows 是 `%USERPROFILE%\.local\bin`，macOS/Linux 是 `~/.local/bin`。
如果 `idalib-mcp` 已经在 `PATH` 上，第 3 步可以直接 `node install.mjs`（会自动找到）。

---

## 参数

```
node install.mjs [--profile web] [--dsh-home <dir>] [--preset-id ida] [--mcp <path>]
                 [--no-mcp] [--skip-skills] [--skip-prompt] [--force]
                 [--overlay <path>] [--emit <path>] [--no-install-deps]
                 [--dry-run] [--uninstall [--purge]]
```

| 参数 | 作用 |
|---|---|
| `--profile <name>` | 装进哪个 profile；默认 `web`，没有就取第一个 |
| `--mcp <path>` | 指定 `idalib-mcp` 可执行文件；不传则查 PATH / `~/.local/bin` |
| `--no-mcp` | 不启用 MCP 行（先只装提示词 + 技能） |
| `--skip-skills` | 不动技能树（已手动 clone 过时用） |
| `--skip-prompt` | 不覆盖已存在的 `prompt-inject.md`（默认也不覆盖，除非 `--force`） |
| `--overlay <path>` | **不碰 profile**，只写一份独立 overlay；启动时 `dsh --profile web --patch "<path>"` |
| `--emit <path>` | 只渲染预设（校验用），不做任何其它改动 |
| `--no-install-deps` | 不自动 `dsh plugin add`（离线环境） |
| `--dry-run` | 打印计划，不写任何文件 |
| `--uninstall` | 删哨兵区块；加 `--purge` 再删插件与技能树（提示词保留） |

`--overlay` 的用法（不想改目标机配置时）：

```powershell
node install.mjs --overlay "C:\Users\<你>\.dsh\ida.patch.yml"
# 以后每次这样启动（做个 .cmd / 快捷方式即可）：
dsh --profile web --patch "C:\Users\<你>\.dsh\ida.patch.yml"
```

---

## 验证

```powershell
# 1) 组合栈里能看到预设（不花 token、不开会话）
dsh --profile web --dump-config | findstr /C:"preset-ida"

# 2) 技能树
(Get-ChildItem "$env:USERPROFILE\.dsh\vendor\reverse-ida\skills").Count   # 46
(Get-ChildItem "$env:USERPROFILE\.dsh\vendor\reverse-ida\ctf").Count      # 42

# 3) 真用：重启 dsh → 新建会话选「逆向模式」→ 让模型 idb_list / idb_open
```

选择器里出现「加载失败」角标，通常是三件事之一：MCP 客户端包没装上
（`dsh plugin add @deepseek-ai/dsh-mcp-client`）、插件路径写错、`prompt-inject.md` 不见了。

---

## 和 Mac 原机的差异（有意为之）

| 原机 | 这里 | 为什么 |
|---|---|---|
| `billion-context-dsh`（ACP）接管压缩 | 用随包 `compaction-basic` | ACP 是第三方 0.2.x 包，版本绑得很死；随包压缩在任何 dsh 上都成立 |
| `dsh-mcp-client-idle`（fork，空闲 15 分钟拆连） | 上游 `@deepseek-ai/dsh-mcp-client` | fork 依赖 `@modelcontextprotocol/client` 等包，可移植性差；泄漏只在长期挂 MCP 时出现 |
| 预设 410 行手写副本 | 每次从目标机 `standard.patch.yml` 生成 | dsh 升级后 `plugins` 是整份替换，手写副本会悄悄落后 |
| 技能用软链 | 复制（含路由技能整棵树，约 19 MB） | Windows 上 `ln -s` 需要开发者模式，`mklink /J` 需要额外权限 |

提示词是本机自用的 27.8 KB 文本（人格设定 + 反审查口径）。**要分享给别人前先自己审一遍**，
或换成自己的版本：改 `<DSH_HOME>/prompt-inject.md` 即热生效，不用重跑安装器。

技能仓库来自 [dhicoc/dsh-reverse-skill](https://github.com/dhicoc/dsh-reverse-skill)
（根目录 MIT；`CTF-Sandbox-Orchestrator/` 为 GPLv3）。安装器只 clone，不把技能内容放进本仓库。

---

## 更新 / 卸载

```powershell
# 更新技能
git -C "$env:USERPROFILE\.dsh\vendor\reverse-skill" pull
node install.mjs --skip-prompt

# 升级 dsh 之后（预设随目标机的 standard 重新生成）
node install.mjs --skip-skills --skip-prompt

# 卸载
node install.mjs --uninstall          # 只删预设区块
node install.mjs --uninstall --purge  # 再删插件与技能树（prompt-inject.md 保留）
```

---

## 故障排查

- **`找不到随包 standard 预设`** —— 目标机 dsh 太老（预设还没搬进 `dsh-web-app/presets/`）。
  先 `dsh --version` 看一眼，升级 dsh 再装。
- **`找不到任何 profile`** —— dsh 还没初始化过；随便跑一次 `dsh web` 或 `dsh --profile web` 再装。
- **Windows 路径过长** —— 技能名里有 `competition-request-normalization-smuggling` 这类长目录，
  路径超 260 字符会失败。把 `DSH_HOME` 放短路径（`C:\dsh`），或给系统打开 `LongPathsEnabled`。
- **`dsh plugin add` 失败** —— 需要 `dsh` 在 PATH 上、有网络、pnpm 可用。手动补：
  `dsh plugin --profile web add @deepseek-ai/dsh-mcp-client@<dsh 版本>`。
- **重跑后预设没变** —— 看 `dsh --profile web --dump-config | findstr /C:"preset-ida"` 是不是旧内容；
  dsh 的 profile 是启动时装配的，**重启**才作数。

---

## 已知取舍

- 预设里那行 `prompt-inject-scoped` 读的是 `complete: true`，所以**这个模式的系统提示词只有这一份文件**，
  仓库的 `AGENTS.md` 不会注入。这是原设计（逆向模式的提示词自带完整工作流），不是 bug。
- `idalib-mcp` 第一次 `idb_open` 要跑完整自动分析，可能几分钟；`toolCallTimeoutMs` 已调到 600 秒。
- 工具 schema 很大（66 个工具 ≈ 117 KB ≈ 3 万 tokens），只有用这个预设的会话付这份成本 —— 这也是它
  必须做成预设而不是全局 MCP 的原因。
