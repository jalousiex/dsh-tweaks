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

/** 取 Loader 服务（Cordis Loader 以 `loader` 名注册）。取不到返回 undefined。 */
export function loaderOf(ctx) {
  try {
    return ctx?.get ? ctx.get('loader') : undefined
  } catch {
    return undefined
  }
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

  function runTweak(tweak) {
    const enabled = isEnabled(config, tweak.id)
    if (!enabled) {
      applied.delete(tweak.id)
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
          enabled: isEnabled(config, tweak.id),
          applied: Boolean(state && state.ok),
          present: Boolean(entry),
          effective: entry ? entry.disabled === true : null,
          reasserts: (state && state.reasserts) || 0,
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
    })
  }
}
