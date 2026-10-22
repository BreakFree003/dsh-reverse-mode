/**
 * dsh-prompt-inject-scoped —— 把一个文本文件的内容当作系统提示词，**只对挂载它的 preset 生效**，
 * 宿主平面与其它预设一点都不碰。
 *
 * ## 两种模式（由 `config.complete` 决定）
 *   * `complete: false`（默认）：文件正文作为**一段** systemPrompt 段落注入，order 默认 -99999
 *     （排在系统提示词最前面），其余段落照旧 —— 与当年红队预设用同一份文件的做法一致。
 *   * `complete: true`：本段声明为 complete ⇒ 组装后 `sections` 只剩这一份
 *     （`dsh-system-prompt/lib/index.js` 的 `assemble()` 末尾把 complete 段恢复成唯一段落），
 *     persona、工具指引、仓库 AGENTS.md、其它插件注册的段落全部不再出现。**工具本身与工具
 *     schema 不受影响**（那是 `assembly.tools`，不随 `sections` 一起被裁）。
 *     配合 `suppressRuntimeContext: true` 再清掉动态上下文快照（沙箱 / 审批 / 文件策略通知）
 *     —— 两者管的是不同的东西，要「整份换掉」必须都设，缺一个就会漏内容进来
 *     （同随包 minimal 与本机 bare 的写法：complete + includeRuntimeContext: false）。
 *
 * ## 为什么会有这个文件（2026-10-05）
 * 这段文本（`file`，本机约定 `$DSH_HOME/prompt-inject.md`）原本由 dsh-purge **主行**注入。
 * 但主行一挂载，启动就会走 `settleInstalledPatches()` → `reapplyInstalled()`，把 42 个
 * harness 源文件重打一遍 —— `autoApplyOnStart: false` **拦不住**（判据是文件里还有没有
 * `[dsh-purge]` 标记：`dsh-purge/lib/reapply.js:126`）。所以主行不挂，改用这个只做一件事的
 * 小替身：读文件 → 在本 preset 的作用域里注册 systemPrompt。完整推导与实测见
 * `~/Documents/Projects/dsh/project-map.md` §7。
 *
 * ## 为什么是「裸文件行」而不是 bundle 包（本项目的常规要求）
 * bundle 的 patch 层只作用于 **profile 平面**，挂在那儿就会漏进每一个 preset（§7.1 实测）；
 * 只有预设自己 `plugins` 里的行才按定义只属于本预设。同类先例：
 * `plugins/dsh-sidepanel/tool-read-image.js`。
 *
 * ## 注册方式（踩过的坑，别改）
 * 照抄 `@deepseek-ai/dsh-persona`：声明式 `inject = ['systemPrompt']` +
 * `ctx.effect(() => ctx.systemPrompt.section(...))`。**不要**改成「动态 inject」那种写法 ——
 * 2026-10-05 实测：`ctx.inject(['systemPrompt'], scope => scope.systemPrompt.section(...))`
 * 注册进的是**全局层**，漏进了一个 standard-256k 的新会话（system/message 里出现了这段文本）。
 * `interpolate: false` 同样照抄 —— 正文里的 `{{...}}` 是字面量，不该被渲染器替换
 * （persona 的 prefix 是**模板**，把这份正文塞进 persona 会因未注册变量直接报错，所以只能走段落）。
 * 异常仍然只记日志、不向外抛（预设里一行抛错会让整个预设挂载失败）。
 *
 * ## 读不到文件怎么办
 * 挂载时先探一次：读不到就**整行不注册**、只记 error —— complete 模式下「空系统提示词」比
 * 「退回常规系统提示词」更糟。运行期每次组装都重读文件（改那个 md 即热生效，不用重启、也不用
 * 重新挂载）；读到空则退回上一次成功读到的正文，连一次都没读到过才给一行诊断文本 ——
 * 同样是为了别把 complete 段变成空字符串。
 */

import { readFileSync } from 'node:fs'

/** cordis 插件名（fiber 诊断用；与文件名、预设行 id 无关）。 */
export const name = 'dsh-prompt-inject-scoped'

/**
 * 声明式注入 systemPrompt —— 与 `@deepseek-ai/dsh-persona` 完全一致（那是本机已验证
 * 「挂在预设里只影响该预设」的写法：`ctx.systemPrompt.section(...)` 注册进**挂载它的
 * 那个作用域**）。
 *
 * ⚠ 2026-10-05 实测教训：**不要**改成 `inject = []` + `ctx.inject(['systemPrompt'], scope =>
 * scope.systemPrompt.section(...))` —— 那样注册进的是**全局层**，实测漏进了 standard-256k
 * 的会话（新建会话的 system/message 里出现了这段人格提示词）。sidepanel 那种
 * 「动态 inject 保平安」的写法是为 tools/attachments 那种**可能缺席**的服务准备的；
 * systemPrompt 是每个预设都在用的宿主服务，缺席不了，所以这里用声明式。
 */
export const inject = ['systemPrompt']

const TAG = '[dsh-prompt-inject-scoped]'
const DEFAULT_ORDER = -99999
const DEFAULT_NAME = 'prompt-inject-scoped'

/** 默认注入 `$DSH_HOME/prompt-inject.md`（与 dsh-purge 用的是同一个文件）。 */
function resolveFile(config) {
  const configured = config && typeof config.file === 'string' ? config.file.trim() : ''
  if (configured) return configured
  const home = process.env.DSH_HOME || `${process.env.HOME || ''}/.dsh`
  return `${home}/prompt-inject.md`
}

/** 读正文；任何失败都返回空串（= 读不到），绝不抛。 */
function readBody(file, trim) {
  try {
    const raw = readFileSync(file, 'utf8')
    return trim ? raw.trim() : raw
  } catch {
    return ''
  }
}

/**
 * 在调用者所在作用域注册段落。
 *
 * @param ctx - 预设作用域（calling context）。
 * @param config - `{ file, order, name, trim, complete, suppressRuntimeContext }`，都可省略。
 */
export function apply(ctx, config = {}) {
  const file = resolveFile(config)
  const order = Number.isFinite(config?.order) ? config.order : DEFAULT_ORDER
  const trim = config?.trim !== false
  const complete = config?.complete === true
  const suppressRuntimeContext = config?.suppressRuntimeContext === true
  const sectionName =
    typeof config?.name === 'string' && config.name.trim() ? config.name.trim() : DEFAULT_NAME

  // 挂载时先探一次：读不到就整行不注册（见文件头「读不到文件怎么办」）。
  const probe = readBody(file, trim)
  if (probe === '') {
    ctx.logger?.error?.(`${TAG} 读不到文件，本行不注册：${file}（本预设退回常规系统提示词）`)
    return
  }

  /** 上一次成功读到的正文；只有它也为空时才给诊断文本。 */
  let lastGood = probe
  const text = () => {
    const body = readBody(file, trim)
    if (body !== '') {
      lastGood = body
      return body
    }
    return `${lastGood}\n\n${TAG} 警告：${file} 读不到，上面是最后一次成功读到的正文。`
  }

  const section = {
    name: sectionName,
    order,
    interpolate: false,
    text,
    ...(complete ? { complete: true } : {}),
  }

  try {
    // 与 `@deepseek-ai/dsh-persona` 同款：直接在自己的 ctx 上注册
    // （→ 落在**挂载本行的作用域**，即预设层），并用 ctx.effect 让它随 fiber 回收。
    // ⚠ 别改成 `ctx.inject(['systemPrompt'], scope => scope.systemPrompt.section(...))`：
    // 实测那样会注册进全局层、漏进所有预设（见 export const inject 的注释）。
    ctx.effect(() => ctx.systemPrompt.section(section), 'prompt-inject-scoped.section()')
    // 抑制器同样登记在**挂载层**上、随 fiber 一起回收（persona 也是这么调的，没有包 effect）。
    // complete 段不会替我们清掉动态快照（assemble 只裁 sections），要「整份换掉」就得设这个。
    if (suppressRuntimeContext) ctx.systemPrompt.suppressRuntimeContext()
    ctx.logger?.info?.(
      `${TAG} 段落已注册：${file}（${probe.length} 字符，order ${order}` +
        `${complete ? '，complete=true（接管整份系统提示词）' : ''}` +
        `${suppressRuntimeContext ? '，运行时快照已抑制' : ''}）`,
    )
  } catch (reason) {
    const message = String(reason?.message ?? reason)
    // HMR 重放同一条 row 时会撞名；那不是错误。其余只记日志、不向外抛：
    // 预设里一行抛错会让**整个预设**挂载失败（见文件头）。
    if (!message.includes('already registered')) {
      ctx.logger?.error?.(`${TAG} 段落注册失败：${message}`)
    }
  }
}
