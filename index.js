/**
 * dsh-tweaks —— 宿主半（host half）。
 *
 * 这是一个**小改动登记处**：每个改动单独开关。目的是跨机同步 ——
 * 开关集合集中在一个 YAML 配置块里，于是「我开了哪些小开关」
 * 随 profile 一起走，而不是散落在十来个文件里靠记忆维持。
 *
 * 设计规则（对齐 dsh 架构说明）：
 *
 *  1. **配置是数据，不是代码。** 每个改动只有 `enabled: bool` 加少量参数。
 *     加一个改动 = `TWEAKS` 里加一行；启用它 = `cordis.patch.yml` 里加一行。
 *     不给任何改动做专属接线。
 *
 *  2. **改动落到 Loader 的条目上。** 一个改动的效果就是把目标条目的
 *     `disabled` 置为 true；这里用的是 Loader 自己提供的 `loader` 服务，
 *     不伸手进任何插件包的内部。关闭或卸载时把原值还原。
 *
 *  3. **幂等且可逆。** 重复应用不会叠加；`ctx.effect` 的清理回调负责还原。
 *
 *  4. **绝不阻塞启动。** 某个改动应用失败只记进状态路由然后跳过 ——
 *     应用照常启动。
 *
 *  5. **如实汇报。** `GET /dsh-tweaks/status` 对每个改动同时给出
 *     「是否启用」「是否应用成功」「目标条目此刻是否真的 disabled」，
 *     让「我开了但没反应」可查，而不是变成玄学。
 *
 * 路由（loopback，与 GUI 同源）：
 *   GET  /dsh-tweaks/status  —— 所有已知改动 + 配置 + 生效状态
 */

import z from '@deepseek-ai/schemastery'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-tweaks'

/** 路由前缀；所有路由都收在同一命名空间下，便于 grep。 */
export const ROUTE_PREFIX = '/dsh-tweaks'

/**
 * The tweak registry.
 *
 * `id`     — stable key used in `config.<id>.enabled`. Never rename casually:
 *            it is what a user's saved config refers to.
 * `title`  — human label (Chinese first, since the user-facing docs are Chinese).
 * `why`    — one-line rationale, shown by `/dsh-tweaks/status` so a future
 *            reader understands *why* this tweak exists before deleting it.
 * `target` — the Loader entry id this tweak disables. Omitted = nothing to
 *            disable (the client half renders something instead).
 */
export const TWEAKS = Object.freeze([
  {
    id: 'hideSettingsModels',
    title: '隐藏设置里的「模型清单」页，只留「账号与余额」',
    why:
      '模型清单是 dsh-tap 网关返回的上游目录，设置里那一页只是它的只读展示；' +
      '日常用不到却占一个设置分区。禁用它不影响 /model 下拉与模型选择。',
    target: 'ui-settings-models',
  },
  {
    id: 'hideBuiltinDeepseek',
    title: '隐藏内置 DeepSeek 供应商，只保留「DeepSeek 账号」',
    why:
      '内置 llm-deepseek 是 API key 路由，和「DeepSeek 账号」（llm-deepseek-account）' +
      '在设置与模型下拉里并列出两组同名模型。只用账号登录时，把内置那组关掉，' +
      '列表里就只剩「DeepSeek 账号」。',
    target: 'llm-deepseek',
  },
  {
    id: 'hideUnroutableModels',
    title: '模型清单里剔掉不可路由的死模型',
    why:
      '网关目录（/v3/config）里在列、但 /v2/chat/completions 恒 11102 service info not found 的条目' +
      '（glm-4.6v / kimi-k2-thinking / minimax-m2.5 / hy4-preview-x）在 dsh-tap 里只是置灰，' +
      '仍占着设置卡列表与对话模型选择器——选中必失败。本开关把它们从选择器里摘掉、' +
      '设置卡里的行连空分组标题一起隐去：停用走 dsh-tap 自己的 /dsh-tap/settings 路由' +
      '（modelSetEnabled=false，与卡片勾选同一条路径，顺带重铺宿主镜像），不写它的文件；' +
      '开之前处于启用状态的 id 记在 ~/.dsh/.cache/dsh-tweaks/hide-unroutable.json，' +
      '关闭时按这份清单勾回去。只在启动/开关时执行一次（不做周期对账）——' +
      '在 dsh-tap 卡里手动勾回的条目，下次启动会被再剔一次。',
    menu: true,
    apply: applyHideUnroutable,
    restore: restoreHideUnroutable,
  },
  {
    id: 'restartButton',
    title: '一键重启 DSH 的菜单项',
    why:
      '改完插件/配置后需要重启宿主；手动关托盘再开太绕。' +
      '注意：本项只登记意图与状态，真正的重启按钮由浏览器半渲染，' +
      '点击后调用 POST /dsh-tweaks/restart。',
  },
])

export const Config = z.object({
  /** 每个改动的开关。键 = 改动 id；未知键直接忽略（向前兼容）。 */
  tweaks: z.dict(z.object({
    enabled: z.boolean().default(false),
  })).default(() => ({})),
  /** 是否暴露状态路由（默认开；它只读且在 loopback 上）。 */
  statusRoute: z.boolean().default(true),
  /** 是否允许 POST /dsh-tweaks/restart 真的重启（默认关：危险）。 */
  allowRestart: z.boolean().default(false),
})

/** 从扁平的配置对象里解出某个改动的实际启用状态。 */
export function isEnabled(config, id) {
  const entry = config?.tweaks?.[id]
  return entry?.enabled === true
}

/** 所有已知改动及其开关状态快照，供状态路由使用。 */
export function describeTweaks(config, applied) {
  return TWEAKS.map((t) => ({
    id: t.id,
    title: t.title,
    why: t.why,
    target: t.target ?? null,
    enabled: isEnabled(config, t.id),
    applied: applied.has(t.id),
    error: applied.get(t.id)?.error ?? null,
  }))
}

/**
 * Verify a tweak's declared `target` entry actually exists in the live config
 * tree. Pure helper so the test harness can cover it without a ctx.
 *
 * Returns `{ ok, present, reason }`. When there is no tree to inspect (bundle
 * config not reachable from this plugin) we return `{ ok: true, present: null }`
 * and say so — an unverifiable target must not be reported as a failure, or
 * every status call would look broken.
 */
export function checkTarget(target, tree) {
  if (!target) return { ok: true, present: null, reason: 'no target declared' }
  if (!Array.isArray(tree)) return { ok: true, present: null, reason: 'config tree not visible from plugin' }
  const hit = tree.find((e) => e && (e.id === target || e.name === target))
  return hit
    ? { ok: true, present: true, reason: `found ${target}` }
    : { ok: false, present: false, reason: `target ${target} is not in the config tree` }
}

/**
 * 在 `cordis.patch.yml` 文本里把某个 tweak 的 `enabled` 改成目标值。
 * 纯函数，便于单测；格式对不上就原样返回（调用方据此报错，不会写坏文件）。
 */
export function setTweakEnabledInText(text, id, enabled) {
  const lines = String(text).split(/\r?\n/)
  const start = lines.findIndex((l) => /^\s*-\s*id:\s*['\"]?dsh-tweaks['\"]?\s*$/.test(l))
  if (start < 0) return text
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-\s*id:\s*/.test(lines[i])) { end = i; break }
  }
  const indentOf = (l) => (l.match(/^\s*/) || [''])[0].length
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, function (c) { return '\\' + c })
  // 键、值都允许行尾注释（YAML 合法，配置里也确实这么写）——只替换布尔值，
  // 行尾注释原样留着，否则「开关写回」会在带注释的行上失效。
  const keyRe = new RegExp('^(\\s+)' + escaped + ':\\s*(?:#.*)?$')
  for (let i = start; i < end; i++) {
    const m = lines[i].match(keyRe)
    if (!m) continue
    const keyIndent = m[1].length
    for (let j = i + 1; j < end; j++) {
      if (indentOf(lines[j]) <= keyIndent && lines[j].trim()) break
      const em = lines[j].match(/^(\s+)enabled:\s*(true|false)(\s*(?:#.*)?)$/)
      if (em) {
        lines[j] = em[1] + 'enabled: ' + (enabled === true ? 'true' : 'false') + em[3]
        return lines.join('\n')
      }
    }
    return text
  }
  return text
}
/** 取 Loader 服务（Cordis Loader 以 `loader` 名注册）。取不到返回 undefined。 */
export function loaderOf(ctx) {
  try {
    return ctx?.get ? ctx.get('loader') : undefined
  } catch {
    return undefined
  }
}

function dshHomePath() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

// ── 数据类改动（hideUnroutableModels）的支撑 ──────────────────────────────
// 这类开关的效果不在 Loader 条目上（为了剔几个模型把 dsh-tap 整条禁掉是不行的），
// 而是调目标插件自己的设置路由。所以它只在 apply/restore 里做事，状态照样进
// /dsh-tweaks/status。

/** dsh-tap 设置卡自己的路由（GET 视图 / POST 动作共用同一个入口）。 */
export const TAP_SETTINGS_ROUTE = '/dsh-tap/settings'

/** 「开之前是启用的」id 清单落盘位置（.cache 不进同步盘，属本机一次性状态）。 */
function hideUnroutableStatePath() {
  return join(dshHomePath(), '.cache', 'dsh-tweaks', 'hide-unroutable.json')
}

/**
 * 从 dsh-tap 的 model-list 视图里取出「目录在列、但 /v2 恒 11102」的模型 id。
 * 纯函数（便于单测）。目录里已经消失的历史 id 不算——上游删了就没必要再动它。
 */
export function unroutableIds(view) {
  const models = view && view.catalog && Array.isArray(view.catalog.models) ? view.catalog.models : []
  const present = new Set()
  for (const m of models) if (m && typeof m.id === 'string' && m.id) present.add(m.id)
  const table = view && view.unroutable && typeof view.unroutable === 'object' ? view.unroutable : {}
  return Object.keys(table).filter((id) => present.has(id))
}

function readRestoreIds(file) {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(doc && doc.ids) ? doc.ids.filter((id) => typeof id === 'string' && id) : []
  } catch {
    return []
  }
}

function writeRestoreIds(file, ids) {
  if (!ids.length) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ids }, null, 2), 'utf8')
}

function clearRestoreIds(file) {
  try { rmSync(file, { force: true }) } catch {}
}

/**
 * POST 到 dsh-tap 的设置路由。宿主发起 = 没有 Origin 头，正好落在它
 * 「壳转发/非浏览器放行」的语义里（它的 localGuardFailure 只要求回环 Host）。
 * 任何非 200 / 非 JSON / ok:false 都抛错，由调用方记进状态。
 */
async function tapPost(origin, body) {
  if (!origin) throw new Error('取不到本机 webServer origin')
  const url = String(origin).replace(/\/+$/, '') + TAP_SETTINGS_ROUTE
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let doc = null
  try { doc = JSON.parse(text) } catch { doc = null }
  if (!response.ok) {
    throw new Error(`dsh-tap ${response.status}${doc && doc.error ? '：' + doc.error : ''}`)
  }
  if (!doc) throw new Error('dsh-tap 返回的不是 JSON（路由可能还没注册）')
  if (doc.ok === false) throw new Error(String(doc.error || 'dsh-tap 拒绝了请求'))
  return doc
}

/**
 * hideUnroutableModels 的「开」：把目录里已知不可路由的模型逐个停用。
 * 停用走 dsh-tap 自己的 modelSetEnabled（与卡片勾选同一条路径，它会顺带
 * 重铺宿主镜像，选择器立刻跟上），不写它的文件。开之前处于启用状态的 id
 * 记进还原清单，供关闭时勾回。
 */
export async function applyHideUnroutable({ origin, stateFile }) {
  const view = await tapPost(origin, { action: 'model-list' })
  const ids = unroutableIds(view)
  const effective = new Set(Array.isArray(view.effectiveIds) ? view.effectiveIds : [])
  const live = ids.filter((id) => effective.has(id))
  if (live.length) {
    const keep = readRestoreIds(stateFile)
    for (const id of live) if (!keep.includes(id)) keep.push(id)
    writeRestoreIds(stateFile, keep)
    for (const id of live) {
      await tapPost(origin, { patch: { modelSetEnabled: { id, enabled: false } } })
    }
  }
  const models = view.catalog && Array.isArray(view.catalog.models) ? view.catalog.models : []
  return { ids, disabledNow: live, catalogCount: models.length }
}

/** hideUnroutableModels 的「关」：按还原清单把当初启用的模型勾回去。 */
export async function restoreHideUnroutable({ origin, stateFile }) {
  const ids = readRestoreIds(stateFile)
  if (!ids.length) return { restored: [], failed: [] }
  const restored = []
  const failed = []
  for (const id of ids) {
    try {
      await tapPost(origin, { patch: { modelSetEnabled: { id, enabled: true } } })
      restored.push(id)
    } catch (error) {
      // 目录里已经消失、且不在静态清单里的 id 会在这里失败（dsh-tap 要 profile
      // 才能启用新增模型）——记下来继续，别让一个死 id 挡住其它还原。
      failed.push({ id, error: String((error && error.message) || error) })
    }
  }
  if (!failed.length) clearRestoreIds(stateFile)
  return { restored, failed }
}

/** 数据类改动的结果 → 状态路由里一句人话（null = 不写）。 */
function describeDataResult(enabled, result) {
  if (!enabled) {
    const restored = Array.isArray(result && result.restored) ? result.restored : []
    const failed = Array.isArray(result && result.failed) ? result.failed : []
    if (!restored.length && !failed.length) return '没有需要还原的条目'
    return `还原 ${restored.length} 个${failed.length ? `（${failed.length} 个失败）` : ''}`
  }
  const ids = Array.isArray(result && result.disabledNow) ? result.disabledNow : []
  return ids.length ? `已从选择器移除 ${ids.length} 个：${ids.join(', ')}` : '没有需要移除的条目'
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => resolve(body))
    req.on('error', () => resolve(''))
  })
}

/** 在 Loader 的条目树里按 id 找条目（含 group 里的嵌套条目）。 */
export function findEntry(loader, id) {
  if (!loader || !id) return undefined
  const direct = loader.store && loader.store[id]
  if (direct) return direct
  if (typeof loader.entries === 'function') {
    for (const entry of loader.entries()) {
      if (entry && entry.options && entry.options.id === id) return entry
    }
  }
  return undefined
}

/**
 * 把条目收敛到「禁用」。返回 `{ before, changed }` 供回滚。
 * 已经禁用时不动它，避免每次启动都重复 update。
 */
export function disableEntry(entry) {
  const before = entry?.options ? entry.options.disabled : undefined
  if (!entry || entry.disabled === true) return { before, changed: false }
  const task = entry.update({ ...entry.options, disabled: true })
  if (task && typeof task.catch === 'function') task.catch(() => {})
  return { before, changed: true }
}

/** 回滚 `disableEntry`：把 `disabled` 还原成应用前的值。 */
export function restoreEntry(entry, before) {
  if (!entry || !entry.options || entry.options.disabled !== true) return
  const next = { ...entry.options }
  if (before === undefined) delete next.disabled
  else next.disabled = before
  const task = entry.update(next)
  if (task && typeof task.catch === 'function') task.catch(() => {})
}

export function apply(ctx, config = {}) {
  /** 改动 id -> { ok, error }。`applied` 表示「enable 跑过且没抛错」。 */
  const applied = new Map()

  /**
   * 数据类改动：效果不在 Loader 条目上，而是调目标插件自己的设置路由。
   * 要等 webServer 起来、且兄弟插件的路由注册完，失败就短暂重试；
   * 重试耗尽也只记状态，绝不阻塞启动（规则 4）。
   */
  function runDataTweak(tweak, enabled) {
    ctx.inject(['webServer'], (wsctx) => {
      wsctx.effect(() => {
        let cancelled = false
        const timers = new Set()
        const origin = () => {
          try { return wsctx.webServer.getOrigin() } catch { return undefined }
        }
        const attempt = async (left) => {
          if (cancelled) return
          try {
            const result = enabled
              ? await tweak.apply({ origin: origin(), stateFile: hideUnroutableStatePath() })
              : await tweak.restore({ origin: origin(), stateFile: hideUnroutableStatePath() })
            applied.set(tweak.id, { ok: true, error: null, note: describeDataResult(enabled, result) })
          } catch (error) {
            const message = String((error && error.message) || error)
            if (left > 1) {
              const timer = setTimeout(() => { timers.delete(timer); attempt(left - 1) }, 2000)
              timers.add(timer)
              return
            }
            applied.set(tweak.id, { ok: false, error: message })
          }
        }
        attempt(8)
        return () => {
          cancelled = true
          for (const timer of timers) clearTimeout(timer)
          timers.clear()
        }
      }, `dsh-tweaks:${tweak.id}:data`)
    })
  }

  function runTweak(tweak) {
    const enabled = isEnabled(config, tweak.id)
    if (!enabled) {
      applied.delete(tweak.id)
      // 数据类改动在关闭时也要跑一次：把开之前启用的条目还回去。
      if (typeof tweak.restore === 'function') runDataTweak(tweak, false)
      return
    }
    if (typeof tweak.apply === 'function') {
      applied.set(tweak.id, { ok: false, error: '尚未应用（等待 dsh-tap 路由）' })
      runDataTweak(tweak, true)
      return
    }
    if (!tweak.target) {
      applied.set(tweak.id, { ok: true, error: null })
      return
    }
    try {
      // ctx.effect 注册的是可逆副作用：cordis 在卸载/禁用时会调用清理回调，
      // 这正是它能在运行时安全开关的原因。
      ctx.effect(() => {
        let cancelled = false
        let reasserts = 0
        let touched = false
        const tick = () => {
          if (cancelled) return
          const live = findEntry(loaderOf(ctx), tweak.target)
          if (!live) {
            applied.set(tweak.id, { ok: false, error: `target ${tweak.target} is not in the loader tree`, reasserts })
            return
          }
          if (live.disabled === true) {
            applied.set(tweak.id, { ok: true, error: null, reasserts })
            return
          }
          if (reasserts >= 10) {
            applied.set(tweak.id, { ok: false, error: 'target flips back after disable', reasserts })
            return
          }
          const result = disableEntry(live)
          if (result.changed) {
            reasserts += 1
            touched = true
          }
          applied.set(tweak.id, { ok: true, error: null, reasserts })
        }
        // 应用发生在启动过程中：先让 Loader 跑完这一轮，再动兄弟条目；
        // 之后每 3 秒对账一次，覆盖 Loader 重建条目（配置热应用/安装插件）的情形。
        const first = setTimeout(tick, 0)
        const interval = setInterval(tick, 3000)
        return () => {
          cancelled = true
          clearTimeout(first)
          clearInterval(interval)
          if (touched) restoreEntry(findEntry(loaderOf(ctx), tweak.target), undefined)
        }
      }, `dsh-tweaks:${tweak.id}`)
      applied.set(tweak.id, { ok: true, error: null })
    } catch (error) {
      // 规则 4：绝不阻塞启动。记录下来继续。
      applied.set(tweak.id, { ok: false, error: String(error?.message ?? error) })
    }
  }

  function applyAll() {
    for (const tweak of TWEAKS) runTweak(tweak)
  }

  /** 每个改动：配置值 / 是否应用成功 / 目标条目此刻是否真的禁用。 */
  function status() {
    const loader = loaderOf(ctx)
    return {
      plugin: name,
      routePrefix: ROUTE_PREFIX,
      tweaks: TWEAKS.map((tweak) => {
        const entry = tweak.target ? findEntry(loader, tweak.target) : undefined
        const state = applied.get(tweak.id)
        return {
          id: tweak.id,
          title: tweak.title,
          target: tweak.target ?? null,
          // 菜单里要不要给这一行：带 target 的改动天然有行；数据类改动显式声明。
          menu: tweak.menu === true || Boolean(tweak.target),
          enabled: isEnabled(config, tweak.id),
          applied: Boolean(state && state.ok),
          present: Boolean(entry),
          effective: entry ? entry.disabled === true : null,
          reasserts: (state && state.reasserts) || 0,
          note: (state && state.note) || null,
          error: (state && state.error) || null,
        }
      }),
    }
  }

  applyAll()

  if (config.statusRoute !== false) {
    ctx.inject(['webServer'], (wsctx) => {
      wsctx.effect(() => wsctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/status`,
        handler: async (_request, response) => {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          response.end(JSON.stringify(status()))
        },
      }), 'dsh-tweaks:status-route')
      // 界面开关：把 enabled 写回 ③ 的 dsh-tweaks 段。
      // 写 ③ 而不是 ②：③ 是覆盖层，配置放在 ③ 才不会被覆盖。
      wsctx.effect(() => wsctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/toggle`,
        handler: async (request, response) => {
          try {
            const raw = await readRequestBody(request)
            const body = JSON.parse(raw || '{}')
            if (!TWEAKS.some((t) => t.id === body.id)) throw new Error('unknown tweak: ' + body.id)
            const file = join(dshHomePath(), 'cordis.patch.yml')
            const before = readFileSync(file, 'utf8')
            const after = setTweakEnabledInText(before, body.id, body.enabled === true)
            if (after === before) throw new Error('tweak ' + body.id + ' 不在 ' + file + ' 的 dsh-tweaks 段里')
            writeFileSync(file, after, 'utf8')
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify({ ok: true, id: body.id, enabled: body.enabled === true, file }))
          } catch (error) {
            response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
          }
        },
      }), 'dsh-tweaks:toggle-route')
    })
  }
}
