#!/usr/bin/env node
/**
 * dsh-reverse-mode —— 把「逆向模式（IDA Pro MCP）」装进一台已有的 dsh。
 *
 * 设计要点（为什么不是「拷一份 preset 过去」）：
 *   1. 预设是**版本相关**的：plugins 是整份替换，随包 standard 每隔几个版本就会多/少几行。
 *      所以这里不内置 preset，而是读**目标机自己的**
 *      `@deepseek-ai/dsh-web-app/presets/standard.patch.yml`，在它的副本上只加三样东西：
 *        · 开头一行 prompt-inject-scoped（把 prompt-inject.md 整份换掉系统提示词）
 *        · skill-filesystem 的 customSkillDirs（两个技能根）
 *        · 末尾一行 MCP 客户端（idalib-mcp）
 *      dsh 升级后重跑一遍 `node install.mjs` 即自动跟上新行。
 *   2. 只改 profile 的 `cordis.patch.yml`，用 `# >>> dsh-reverse-mode` 哨兵区块包住，
 *      重复执行就是替换，卸载就是删区块 —— 不碰对方其它配置，第一次写之前先备份。
 *   3. 技能**复制**不软链：Windows 上 `ln -s` 要开发者模式，`mklink /J` 要额外权限，
 *      7 MB 的复制最稳；按 SKILL.md frontmatter 的 `name:` 去重、嵌套技能拉平，
 *      与上游 make-ida-skills.sh 的语义一致。
 *
 * 用法：
 *   node install.mjs                     # 装到 ~/.dsh（profile 自动找：web → 第一个）
 *   node install.mjs --profile web
 *   node install.mjs --mcp "C:/Program Files/IDA/.../idalib-mcp.exe"   # 指定 MCP 可执行文件
 *   node install.mjs --overlay ~/.dsh/reverse-mode/ida.patch.yml       # 不改 profile，只出 overlay
 *   node install.mjs --emit /tmp/ida.patch.yml                         # 只渲染，不落盘（校验用）
 *   node install.mjs --uninstall        # 删哨兵区块（--purge 再删插件/技能/提示词）
 *
 * 选项：--dsh-home <dir> --profile <name> --preset-id <id> --preset-name <s>
 *       --mcp <path> --no-mcp --skip-skills --skip-prompt --force --dry-run
 *       --uninstall --purge
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const BEGIN = '# >>> dsh-reverse-mode'
const END = '# <<< dsh-reverse-mode <<<'
const SKILLS_REPO = 'https://github.com/dhicoc/dsh-reverse-skill.git'
const CORE_DIR = '.dsh-reverse-mode' // 放在 DSH_HOME 下的状态目录名

// ─────────────────────────────── CLI ───────────────────────────────

function parseArgs(argv) {
  const out = {
    dshHome: process.env.DSH_HOME || '',
    profile: '',
    presetId: 'ida',
    presetName: '逆向模式（IDA Pro MCP）',
    mcp: '',
    noMcp: false,
    overlay: '',
    emit: '',
    skipSkills: false,
    skipPrompt: false,
    noInstallDeps: false,
    force: false,
    dryRun: false,
    uninstall: false,
    purge: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} 需要一个值`)
      return v
    }
    switch (a) {
      case '-h':
      case '--help':
        out.help = true
        break
      case '--dsh-home': out.dshHome = next(); break
      case '--profile': out.profile = next(); break
      case '--preset-id': out.presetId = next(); break
      case '--preset-name': out.presetName = next(); break
      case '--mcp': out.mcp = next(); break
      case '--no-mcp': out.noMcp = true; break
      case '--overlay': out.overlay = next(); break
      case '--emit': out.emit = next(); break
      case '--skip-skills': out.skipSkills = true; break
      case '--skip-prompt': out.skipPrompt = true; break
      case '--no-install-deps': out.noInstallDeps = true; break
      case '--force': out.force = true; break
      case '--dry-run': out.dryRun = true; break
      case '--uninstall': out.uninstall = true; break
      case '--purge': out.purge = true; break
      default: throw new Error(`未知参数 ${a}（--help 看用法）`)
    }
  }
  return out
}

const log = (...a) => console.log(...a)
const warn = (...a) => console.warn('!', ...a)
const step = (n, s) => console.log(`\n[${n}] ${s}`)

/** Windows 路径进 YAML：一律正斜杠 + 单引号包起来。 */
function yamlPath(p) {
  return String(p).replace(/\\/g, '/').replace(/'/g, "''")
}

/** 目录里是否真的有一份 dsh profile。 */
function isProfileDir(dir) {
  return (
    fs.existsSync(path.join(dir, 'cordis.patch.yml')) &&
    fs.existsSync(path.join(dir, 'package.json'))
  )
}

function findDshHome(explicit) {
  const home = explicit || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const abs = path.resolve(home)
  if (!fs.existsSync(abs)) throw new Error(`找不到 DSH_HOME：${abs}（先装 dsh，或用 --dsh-home 指定）`)
  return abs
}

function findProfile(dshHome, wanted) {
  const root = path.join(dshHome, 'profiles')
  const entries = fs.existsSync(root)
    ? fs.readdirSync(root).filter((n) => isProfileDir(path.join(root, n)))
    : []
  if (entries.length === 0) throw new Error(`找不到任何 profile：${root}（先跑一次 dsh 初始化）`)
  if (wanted) {
    if (!entries.includes(wanted)) {
      throw new Error(`profile "${wanted}" 不存在（现有：${entries.join(', ')}）`)
    }
    return { name: wanted, dir: path.join(root, wanted) }
  }
  const pick = entries.includes('web') ? 'web' : entries[0]
  if (entries.length > 1) {
    log(`  发现多个 profile：${entries.join(', ')} —— 默认用 "${pick}"（--profile 可指定）`)
  }
  return { name: pick, dir: path.join(root, pick) }
}

// ─────────────────────── 找目标机自己的 standard ───────────────────────

function findShippedStandard(profileDir) {
  const rel = path.join('@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')
  const candidates = [path.join(profileDir, 'node_modules', rel)]

  const nodeRoots = []
  if (process.platform === 'win32') {
    if (process.env.APPDATA) nodeRoots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'))
    if (process.env.ProgramFiles) nodeRoots.push(path.join(process.env.ProgramFiles, 'nodejs', 'node_modules'))
  } else {
    nodeRoots.push('/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules')
  }
  const npmRoot = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
    encoding: 'utf8',
  })
  if (npmRoot.status === 0 && npmRoot.stdout.trim()) nodeRoots.push(npmRoot.stdout.trim())
  for (const r of nodeRoots) candidates.push(path.join(r, '@deepseek-ai', 'dsh', 'node_modules', rel))

  for (const c of candidates) if (fs.existsSync(c)) return c
  throw new Error(
    `找不到随包 standard 预设。找过：\n  ${candidates.join('\n  ')}\n` +
      `这台机器上的 dsh 可能是更老的版本（预设还没搬进 dsh-web-app/presets/）。`,
  )
}

// ───────────────────────── 生成 preset 文本 ─────────────────────────

const indentOf = (line) => /^\s*/.exec(line)[0].length
const sp = (n) => ' '.repeat(n)

/**
 * 把随包 standard 的 insert 条目改造成本机 preset 的 insert 条目。
 * 返回**条目本身**的行数组（首行 `    - id: preset-<id>`，4 空格缩进，供外层 `- insert:` 使用）。
 */
function renderPreset(stockText, opts) {
  const raw = stockText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  let lines = raw.split('\n')

  if (!/^\s*-\s*id:\s*preset-[A-Za-z0-9_-]+\s*$/m.test(raw)) {
    throw new Error('随包 standard.patch.yml 里找不到 `- id: preset-<name>` 条目，版本可能不兼容')
  }

  // 只留条目本身：去掉文件头注释 + 外层 `- insert:`
  const entryIdx = lines.findIndex((l) => /^\s*-\s*id:\s*preset-[A-Za-z0-9_-]+\s*$/.test(l))
  lines = lines.slice(entryIdx)

  // 条目结尾 = 下一条同缩进（或更浅）的列表项 / 文件尾
  const entryIndent = indentOf(lines[0])
  let cut = lines.length
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim()) continue
    if (indentOf(l) < entryIndent) { cut = i; break }
    if (indentOf(l) === entryIndent && /^\s*-\s/.test(l)) { cut = i; break }
  }
  let body = lines.slice(0, cut)
  while (body.length && !body[body.length - 1].trim()) body.pop()

  // 统一成 4 空格（normalize）
  const delta = 4 - entryIndent
  if (delta > 0) body = body.map((l) => (l.trim() ? sp(delta) + l : l))
  else if (delta < 0) body = body.map((l) => (l.trim() ? l.slice(-delta) : l))

  // ── 1. 身份：preset id / id / name / description / order ──────────────
  body = body.map((l) => l.replace(/^(\s*)-\s*id:\s*preset-[\w-]+\s*$/, `$1- id: preset-${opts.presetId}`))

  let idLine = body.findIndex((l) => /^\s*id:\s*\S+\s*$/.test(l) && indentOf(l) > 6)
  if (idLine < 0) throw new Error('standard 条目里找不到 config.id，版本可能不兼容')
  const cfgIndent = indentOf(body[idLine])
  body[idLine] = `${sp(cfgIndent)}id: ${opts.presetId}`

  const insertIdentity = (key, value) => {
    const existing = body.findIndex(
      (l, i) => i > idLine && indentOf(l) === cfgIndent && new RegExp(`^${sp(cfgIndent)}${key}:`).test(l),
    )
    if (existing >= 0) body[existing] = `${sp(cfgIndent)}${key}: '${value}'`
    else body.splice(++idLine, 0, `${sp(cfgIndent)}${key}: '${value}'`)
  }
  insertIdentity('name', opts.presetName)
  insertIdentity(
    'description',
    '标准模式的全部能力，外加 idalib-mcp 交给模型的 IDA Pro 逆向工具。只有用这个预设的会话才付这份 schema 成本。',
  )

  const orderLine = body.findIndex((l) => new RegExp(`^${sp(cfgIndent)}order:`).test(l))
  if (orderLine >= 0) body[orderLine] = `${sp(cfgIndent)}order: 9`
  else body.splice(idLine + 1, 0, `${sp(cfgIndent)}order: 9`)

  // ── 2. prompt-inject-scoped：plugins 首行（整份替换系统提示词）──────────
  const pluginsLine = body.findIndex((l) => /^\s*plugins:\s*$/.test(l))
  if (pluginsLine < 0) throw new Error('standard 条目里找不到 plugins:，版本可能不兼容')
  const pIndent = indentOf(body[pluginsLine])
  const childIndent = pIndent + 2

  // 已经手工改过就跳过（重复执行幂等）
  const hasInject = body.some((l) => new RegExp(`^${sp(childIndent)}-\\s*id:\\s*prompt-inject-scoped\\s*$`).test(l))
  if (!hasInject) {
    const row = [
      `${sp(childIndent)}- id: prompt-inject-scoped`,
      `${sp(childIndent)}  name: '${yamlPath(opts.pluginPath)}'`,
      `${sp(childIndent)}  config:`,
      `${sp(childIndent)}    file: '${yamlPath(opts.promptPath)}'`,
      `${sp(childIndent)}    complete: true`,
      `${sp(childIndent)}    suppressRuntimeContext: true`,
    ]
    body.splice(pluginsLine + 1, 0, ...row)
  }

  // ── 3. skill-filesystem：customSkillDirs ────────────────────────────
  if (opts.skillsDirs && opts.skillsDirs.length > 0) {
    let idx = body.findIndex((l) => new RegExp(`^\\s*-\\s*id:\\s*skill-filesystem\\s*$`).test(l))
    if (idx < 0) {
      // 没有这一行（极老/极新版本）—— 自己补一行，别静默丢技能
      body.push(
        `${sp(childIndent)}- id: skill-filesystem`,
        `${sp(childIndent)}  name: '@deepseek-ai/dsh-skill-filesystem'`,
      )
      idx = body.length - 2
    }
    const ind = indentOf(body[idx])
    let nameLine = -1
    for (let i = idx + 1; i < body.length; i++) {
      if (indentOf(body[i]) === ind + 2 && /^name:/.test(body[i].trim())) { nameLine = i; break }
      if (body[i].trim() && indentOf(body[i]) <= ind) break
    }
    const anchor = nameLine >= 0 ? nameLine : idx
    let cfg = -1
    for (let i = anchor + 1; i < body.length; i++) {
      if (indentOf(body[i]) === ind + 2 && /^config:/.test(body[i].trim())) { cfg = i; break }
      if (body[i].trim() && indentOf(body[i]) <= ind) break
    }
    const custom = [
      `${sp(ind + 4)}customSkillDirs:`,
      ...opts.skillsDirs.map((d) => `${sp(ind + 6)}- '${yamlPath(d)}'`),
    ]
    if (cfg >= 0) {
      // 已有 config：删掉旧的 customSkillDirs（若有）再插
      let end = cfg + 1
      while (end < body.length && (indentOf(body[end]) > ind + 2 || !body[end].trim())) end++
      const block = body.slice(cfg + 1, end)
      const kept = block.filter((l) => !/^\s*customSkillDirs:/.test(l))
      body.splice(cfg + 1, end - cfg - 1, ...kept, ...custom)
    } else {
      body.splice(anchor + 1, 0, `${sp(ind + 2)}config:`, ...custom)
    }
  }

  // ── 4. MCP：plugins 末尾 ────────────────────────────────────────────
  let lastItem = pluginsLine
  for (let i = pluginsLine + 1; i < body.length; i++) {
    if (body[i].trim() && indentOf(body[i]) > pIndent) lastItem = i
  }
  const hasMcpRow = body.some((l) => new RegExp(`^${sp(childIndent)}-\\s*id:\\s*mcp-ida-pro\\s*$`).test(l))
  if (!hasMcpRow) {
    const row = [
      `${sp(childIndent)}- id: mcp-ida-pro`,
      `${sp(childIndent)}  name: '@deepseek-ai/dsh-mcp-client'`,
    ]
    if (!opts.mcp) row.push(`${sp(childIndent)}  disabled: true`)
    row.push(
      `${sp(childIndent)}  config:`,
      `${sp(childIndent)}    serverName: ida`,
      `${sp(childIndent)}    transport: stdio`,
      `${sp(childIndent)}    command: '${yamlPath(opts.mcp || 'idalib-mcp')}'`,
      `${sp(childIndent)}    args:`,
      `${sp(childIndent)}      - '--stdio'`,
      `${sp(childIndent)}    toolCallTimeoutMs: 600000`,
    )
    body.splice(lastItem + 1, 0, ...row)
  }

  return body
}

/** 给 cordis.patch.yml 用的完整区块（含哨兵）。 */
function wrapBlock(bodyLines, meta) {
  return [
    `${BEGIN} (generated; 重复执行 install.mjs 会替换本区块，删除即卸载) >>>`,
    `# 生成于 ${meta.time} · 来源 ${meta.source}`,
    '- insert:',
    ...bodyLines,
    END,
  ].join('\n')
}

// ─────────────────────── 写 profile patch（带备份） ───────────────────────

function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const dst = `${file}.bak-reverse-mode-${stamp}`
  fs.copyFileSync(file, dst)
  return dst
}

function applyBlock(profileDir, block, { dryRun }) {
  const file = path.join(profileDir, 'cordis.patch.yml')
  const text = fs.readFileSync(file, 'utf8')
  const re = new RegExp(`\\n?${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'm')
  const has = re.test(text)
  // 全新 profile 的 patch 层常常只有一句 `[]`（空数组）——直接追加会变成两份文档，必须替换掉
  const stripped = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .trim()
  const next = has
    ? text.replace(re, `\n${block}\n`)
    : stripped === '[]'
      ? text.replace(/^[ \t]*\[\][ \t]*$/m, block)
      : `${text.replace(/\s*$/, '')}\n\n${block}\n`

  if (dryRun) {
    log(`  [dry-run] 将${has ? '替换' : '追加'} ${path.basename(file)} 里的哨兵区块（${block.split('\n').length} 行）`)
    return { file, replaced: has }
  }
  const b = backup(file)
  fs.writeFileSync(file, next, 'utf8')
  log(`  ${has ? '已替换' : '已追加'}哨兵区块 → ${file}`)
  log(`  备份 → ${b}`)
  return { file, replaced: has }
}

function removeBlock(profileDir, { dryRun }) {
  const file = path.join(profileDir, 'cordis.patch.yml')
  const text = fs.readFileSync(file, 'utf8')
  if (!text.includes(BEGIN)) {
    log('  没有找到哨兵区块，无需卸载')
    return false
  }
  const re = new RegExp(`\\n?${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'm')
  let next = text.replace(re, '\n')
  // 删干净后别留下一个空文件：patch 层要求顶层是数组，补回 `[]`
  const rest = next
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .trim()
  if (rest === '') next = `${next.replace(/\s*$/, '')}\n[]\n`
  if (dryRun) {
    log(`  [dry-run] 将从 ${file} 删除哨兵区块`)
    return true
  }
  const b = backup(file)
  fs.writeFileSync(file, next, 'utf8')
  log(`  已删除哨兵区块（备份 ${b}）`)
  return true
}

// ───────────────────────────── 技能树 ─────────────────────────────

function skillName(dir) {
  const md = path.join(dir, 'SKILL.md')
  let text
  try { text = fs.readFileSync(md, 'utf8') } catch { return path.basename(dir) }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  let start = lines.findIndex((l) => l.trim() === '---')
  if (start < 0) return path.basename(dir)
  const end = lines.findIndex((l, i) => i > start && l.trim() === '---')
  for (const line of lines.slice(start + 1, end < 0 ? lines.length : end)) {
    const m = /^name:\s*(.+?)\s*$/.exec(line)
    if (m) return m[1].replace(/^["']|["']$/g, '')
  }
  return path.basename(dir)
}

/** 收集所有含 SKILL.md 的目录（跳过 .git / node_modules），按路径排序。 */
function collectSkillDirs(root) {
  const out = []
  // 根目录自己也可能是一个技能（reverse-skill-router：路由入口，依赖整棵树的 scripts/ 与 config/）
  if (fs.existsSync(path.join(root, 'SKILL.md'))) out.push(root)
  const walk = (dir) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const e of entries) {
      if (!e.isDirectory() || e.name === '.git' || e.name === 'node_modules') continue
      const sub = path.join(dir, e.name)
      if (fs.existsSync(path.join(sub, 'SKILL.md'))) out.push(sub)
      walk(sub)
    }
  }
  walk(root)
  return out
}

function buildFarm(repoDir, srcRel, outDir, { dryRun }) {
  const src = path.join(repoDir, srcRel)
  const dirs = collectSkillDirs(src)
  let linked = 0
  const seen = new Map()
  if (!dryRun) {
    fs.rmSync(outDir, { recursive: true, force: true })
    fs.mkdirSync(outDir, { recursive: true })
  }
  for (const dir of dirs) {
    const name = skillName(dir)
    if (seen.has(name)) {
      warn(`名字重复，跳过：${name}（${path.relative(repoDir, dir)}，已在 ${seen.get(name)}）`)
      continue
    }
    seen.set(name, path.relative(repoDir, dir))
    if (!dryRun) {
      fs.cpSync(dir, path.join(outDir, name), {
        recursive: true,
        dereference: true,
        filter: (s) => path.basename(s) !== '.git' && path.basename(s) !== 'node_modules',
      })
    }
    linked++
  }
  log(`  ${srcRel}: ${linked} 条 → ${outDir}`)
  return linked
}

function ensureSkillsRepo(dshHome, { dryRun }) {
  const repoDir = path.join(dshHome, 'vendor', 'reverse-skill')
  if (fs.existsSync(path.join(repoDir, 'skills'))) {
    log(`  技能仓库已存在：${repoDir}（更新：git -C "${repoDir}" pull）`)
    return repoDir
  }
  if (dryRun) {
    log(`  [dry-run] 将 git clone ${SKILLS_REPO} → ${repoDir}`)
    return repoDir
  }
  fs.mkdirSync(path.dirname(repoDir), { recursive: true })
  const r = spawnSync('git', ['clone', '--depth', '1', SKILLS_REPO, repoDir], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`git clone 失败（需要 git 在 PATH 上）；也可手动 clone 到 ${repoDir}`)
  return repoDir
}

// ───────────────────────── MCP 可执行文件 ─────────────────────────

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findIdalibMcp(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`--mcp 指向的文件不存在：${explicit}`)
    return explicit
  }
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  const names = ['idalib-mcp', 'ida-pro-mcp']
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const home = os.homedir()
  dirs.push(
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links'),
  )
  for (const d of dirs) {
    for (const n of names) for (const e of exts) {
      const c = path.join(d, n + e)
      if (fs.existsSync(c) && isExecutable(c)) return c
    }
  }
  return ''
}

// ─────────────────── 依赖：MCP 客户端包 ───────────────────

function resolveFrom(profileDir, spec) {
  try {
    return createRequire(path.join(profileDir, 'package.json')).resolve(spec)
  } catch {
    return ''
  }
}

/** 从 profile 依赖里取运行时版本（所有 @deepseek-ai/* 是同一版本号）。 */
function runtimeVersion(profileDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    const deps = pkg.dependencies || {}
    const v = deps['@deepseek-ai/dsh-base'] || deps['@deepseek-ai/dsh-web-app']
    return v ? String(v).replace(/^[~^]/, '') : ''
  } catch {
    return ''
  }
}

/**
 * 随包 profile 不带 @deepseek-ai/dsh-mcp-client（只有 chrome/xcode 这类本地预设才用）。
 * 没有它，preset 里那行会在挂载时报 module not found —— 整个预设变 broken。
 * 所以先补装：dsh plugin --profile <p> add @deepseek-ai/dsh-mcp-client@<运行时版本>
 */
function ensureMcpClientPackage(profileDir, profileName, { dryRun, skipInstall }) {
  if (resolveFrom(profileDir, '@deepseek-ai/dsh-mcp-client')) return true
  const v = runtimeVersion(profileDir)
  const spec = v ? `@deepseek-ai/dsh-mcp-client@${v}` : '@deepseek-ai/dsh-mcp-client'
  const manual = `dsh plugin --profile ${profileName} add ${spec}`
  if (skipInstall) {
    warn(`profile 里没有 @deepseek-ai/dsh-mcp-client，且指定了 --no-install-deps`)
    log(`  手动补：${manual}`)
    return false
  }
  if (dryRun) {
    log(`  [dry-run] 将执行：${manual}`)
    return true
  }
  log(`  补装 ${spec}（profile 里没有 MCP 客户端包）`)
  // Windows 上 .cmd 需要 shell；这里的参数都是包名，没有空格，安全
  const r = spawnSync('dsh', ['plugin', '--profile', profileName, 'add', spec], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (r.status !== 0 || !resolveFrom(profileDir, '@deepseek-ai/dsh-mcp-client')) {
    warn(`补装失败（dsh/pnpm 不在 PATH 或缺网络）`)
    log(`  手动补：${manual}`)
    return false
  }
  log(`  @deepseek-ai/dsh-mcp-client 就绪`)
  return true
}

// ─────────────────────────── 主流程 ───────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(5, 30).join('\n'))
    return
  }

  const dshHome = findDshHome(opts.dshHome)
  const profile = findProfile(dshHome, opts.profile)
  const stateDir = path.join(dshHome, CORE_DIR)
  const stateFile = path.join(stateDir, 'install.json')
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}
  const mcp = opts.noMcp ? '' : findIdalibMcp(opts.mcp || state.mcp || '')

  log(`DSH_HOME : ${dshHome}`)
  log(`profile  : ${profile.name}  (${profile.dir})`)
  const modeLabel = opts.emit ? '仅渲染（--emit）' : opts.dryRun ? 'dry-run（不写任何文件）' : opts.overlay ? 'overlay 模式（不改 profile）' : '真实安装'
  log(`模式     : ${modeLabel}`)

  if (opts.uninstall) {
    step(1, '删除哨兵区块')
    removeBlock(profile.dir, { dryRun: opts.dryRun })
    if (opts.purge) {
      step(2, '删除插件 / 技能树（--purge）')
      for (const p of [
        path.join(profile.dir, 'plugins', 'dsh-prompt-inject-scoped'),
        path.join(dshHome, 'vendor', 'reverse-ida'),
      ]) {
        if (!fs.existsSync(p)) continue
        if (opts.dryRun) log(`  [dry-run] rm -r ${p}`)
        else { fs.rmSync(p, { recursive: true, force: true }); log(`  已删除 ${p}`) }
      }
    }
    log('\n完成。重启 dsh 后该预设从选择器消失。')
    return
  }

  // 0) 依赖：preset 里那行 MCP 客户端需要 @deepseek-ai/dsh-mcp-client
  let mcpPkgReady = true
  if (!opts.emit) {
    step(0, '检查依赖：@deepseek-ai/dsh-mcp-client')
    mcpPkgReady = ensureMcpClientPackage(profile.dir, profile.name, {
      dryRun: opts.dryRun,
      skipInstall: opts.noInstallDeps,
    })
  }
  const mcpUsable = mcp && mcpPkgReady ? mcp : ''

  // 1) 生成 preset
  step(1, '生成 preset（基于本机随包 standard）')
  const stockPath = findShippedStandard(profile.dir)
  log(`  基准：${stockPath}`)
  const stockText = fs.readFileSync(stockPath, 'utf8')

  const pluginPath = path.join(profile.dir, 'plugins', 'dsh-prompt-inject-scoped', 'index.js')
  const promptPath = path.join(dshHome, 'prompt-inject.md')
  const skillsRoot = path.join(dshHome, 'vendor', 'reverse-ida')
  const skillsDirs = [path.join(skillsRoot, 'skills'), path.join(skillsRoot, 'ctf')]

  const body = renderPreset(stockText, {
    presetId: opts.presetId,
    presetName: opts.presetName,
    pluginPath,
    promptPath,
    skillsDirs,
    mcp: mcpUsable,
  })
  if (mcp && !mcpPkgReady) {
    warn('MCP 客户端包不可用 —— 该行先写成 disabled: true（补好依赖后重跑本脚本即可启用）')
  } else if (!mcp) {
    warn('没找到 idalib-mcp —— 该行会先写成 disabled: true，装好 IDA 后跑 `node install.mjs --mcp <路径>` 启用')
  }

  const block = wrapBlock(body, {
    time: new Date().toISOString(),
    source: stockPath,
  })

  if (opts.emit) {
    const target = path.resolve(opts.emit)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, block + '\n', 'utf8')
    log(`  已渲染 → ${target}（未做任何其它改动）`)
    log(`  校验：dsh --profile ${profile.name} --patch "${target}" --dump-config | grep -A3 "preset-${opts.presetId}"`)
    return
  }

  // 2) 技能
  if (!opts.skipSkills) {
    step(2, '准备技能树（复制，不建软链）')
    const repoDir = ensureSkillsRepo(dshHome, { dryRun: opts.dryRun })
    buildFarm(repoDir, 'skills', skillsDirs[0], { dryRun: opts.dryRun })
    buildFarm(repoDir, path.join('CTF-Sandbox-Orchestrator'), skillsDirs[1], { dryRun: opts.dryRun })
  } else {
    step(2, '跳过技能（--skip-skills）')
  }

  // 3) 插件 + 提示词
  step(3, '安装提示词插件与 prompt-inject.md')
  const assetPlugin = new URL('./assets/plugins/dsh-prompt-inject-scoped/', import.meta.url)
  const pluginDir = path.dirname(pluginPath)
  if (opts.dryRun) {
    log(`  [dry-run] 复制插件 → ${pluginDir}`)
  } else {
    fs.mkdirSync(pluginDir, { recursive: true })
    for (const f of ['index.js', 'package.json', 'README.md']) {
      fs.copyFileSync(new URL(f, assetPlugin), path.join(pluginDir, f))
    }
    log(`  插件 → ${pluginDir}`)
  }

  if (fs.existsSync(promptPath) && !opts.force) {
    log(`  已存在提示词，保留不动：${promptPath}（--force 覆盖）`)
  } else if (opts.dryRun) {
    log(`  [dry-run] 写入 ${promptPath}`)
  } else {
    fs.mkdirSync(path.dirname(promptPath), { recursive: true })
    fs.copyFileSync(new URL('./assets/prompt-inject.md', import.meta.url), promptPath)
    log(`  提示词 → ${promptPath}`)
  }

  // 4) 写 profile patch（或用 --overlay 出一份独立 overlay，不碰 profile）
  if (opts.overlay) {
    step(4, '写独立 overlay（不修改 profile）')
    const target = path.resolve(opts.overlay)
    if (opts.dryRun) {
      log(`  [dry-run] 写入 ${target}`)
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, block + '\n', 'utf8')
      log(`  overlay → ${target}`)
      log(`  启动时带：dsh --profile ${profile.name} --patch "${target}"`)
    }
  } else {
    step(4, '写入 profile 的 cordis.patch.yml（哨兵区块，可重复执行）')
    applyBlock(profile.dir, block, { dryRun: opts.dryRun })
  }

  // 5) 状态
  if (!opts.dryRun) {
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify({ profile: profile.name, presetId: opts.presetId, mcp, mcpEnabled: Boolean(mcpUsable), at: new Date().toISOString() }, null, 2) + '\n')
  }

  log(`\n完成。重启 dsh（或等 profile 热重载）→ 新建会话选「${opts.presetName}」`)
  log(`自检：dsh --profile ${profile.name} --dump-config | grep -A3 "preset-${opts.presetId}"`)
  if (!mcp) {
    log(`IDA 装好后：uv run "<IDA>/idalib/python/py-activate-idalib.py" 激活 idalib，`)
    log(`然后 node install.mjs --mcp "<venv>/Scripts/idalib-mcp.exe" 重新生成（会去掉 disabled）`)
  }
}

try {
  main()
} catch (e) {
  console.error(`\n失败：${e.message}`)
  process.exit(1)
}
