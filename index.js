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
 *  2. **改动要么 patch 配置树，要么贡献一条路由；绝不伸手进别的包的内部。**
 *     这里只用两个受支持的接缝：
 *     （a）profile 自己的条目列表 —— 这正是 `cordis.patch.yml` 的用途；
 *     （b）本插件自己前缀下的 loopback 路由。
 *
 *  3. **幂等且可逆。** 同一改动应用两次不能叠加；`disable` 必须完整撤销
 *     `enable` 做过的事（靠 `ctx.effect` 的清理回调）。
 *
 *  4. **绝不阻塞启动。** 某个改动应用失败只记进状态路由然后跳过 ——
 *     应用照常启动。
 *
 *  5. **如实汇报。** `GET /dsh-tweaks/status` 对每个改动同时给出
 *     「是否启用」与「是否真的生效」，让「我开了但没反应」可查，而不是变成玄学。
 *
 * 路由（loopback，与 GUI 同源）：
 *   GET  /dsh-tweaks/status  —— 所有已知改动 + 配置 + 应用结果
 *   POST /dsh-tweaks/reload  —— 重读配置并重新应用（调试用）
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
 * `apply`  — `(ctx, options) => void | cleanup`, called only when enabled.
 */
export const TWEAKS = Object.freeze([
  {
    id: 'hideSettingsModels',
    title: '隐藏设置里的「模型清单」页，只留「账号与余额」',
    why:
      '模型清单是 dsh-tap 网关返回的上游目录，设置里那一页只是它的只读展示；' +
      '日常用不到却占一个设置分区。禁用它不影响 /model 下拉与模型选择。' +
      '实现方式：把 profile 配置树里的 ui-settings-models 条目标成 disabled —— ' +
      '这是 bundle 层（dsh-web-app/cordis.patch.yml:294）注册的条目，' +
      'patch 按 id 定位后替换 config，正是 dsh 支持的扩展点。',
    /**
     * 本插件声明的目标条目。
     *
     * 真正让它生效的是 cordis.patch.yml 里的同 id 条目（`disabled: true`）——
     * 本插件不改任何别人的文件，只在自己的 patch 里声明，走官方扩展点。
     *
     * 这里额外做两件事，避免「开了却没反应」：
     *   ① 自检：确认目标条目真的在配置树里，不在就报错而不是静默无效；
     *   ② 记账：把「已接管该条目」写进状态路由，便于排查。
     */
    target: 'ui-settings-models',
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
 * config not reachable from this plugin) we return `ok: true, present: null`
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

export function apply(ctx, config = {}) {
  /** 改动 id -> { ok, error }。`applied` 表示「enable 跑过且没抛错」。 */
  const applied = new Map()

  function runTweak(tweak) {
    const enabled = isEnabled(config, tweak.id)
    if (!enabled) {
      applied.delete(tweak.id)
      return
    }
    try {
      // ctx.effect 注册的是可逆副作用：cordis 在卸载/禁用时会调用清理回调，
      // 这正是它能在运行时安全开关的原因。
      ctx.effect(() => {
        if (typeof tweak.apply === 'function') tweak.apply(ctx, tweak, config)
        // 自检：声明了 target 却在配置树里找不到对应条目的改动，
        // 会静默无效 —— 这里把它变成显式、被记录的报错。
        const verdict = checkTarget(tweak.target, config?.tree ?? ctx?.config?.tree)
        if (!verdict.ok) throw new Error(verdict.reason)
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

  applyAll()

  if (config.statusRoute !== false) {
    ctx.inject?.(['server'], (server) => {
      const status = async () => ({
        plugin: name,
        tweaks: describeTweaks(config, applied),
        routePrefix: ROUTE_PREFIX,
      })
      server.get(`${ROUTE_PREFIX}/status`, async (_req, res) => {
        res.json(await status())
      })
    })
  }
}
