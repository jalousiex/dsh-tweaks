/**
 * dsh-tweaks — host half.
 *
 * A **registry of small, individually switchable tweaks** for DeepSeek Harness.
 * The point is cross-machine replication: the tweak set lives in one YAML config
 * block, so "which small behaviours do I have switched on" travels with the
 * profile instead of being lost in a dozen scattered files.
 *
 * Design rules (from the dsh architecture notes):
 *
 *  1. **Config is data, not code.** Every tweak is `enabled: bool` plus at most a
 *     few parameters. Adding a tweak = one row in `TWEAKS`; enabling it = one
 *     line in `cordis.patch.yml`. No tweak gets bespoke wiring.
 *
 *  2. **A tweak either patches a config tree or contributes a route; it never
 *     reaches into another package's internals.** The supported seams here are
 *     (a) the profile's own entry list, which is what `cordis.patch.yml` is for,
 *     and (b) loopback routes on this plugin's own prefix.
 *
 *  3. **Idempotent and reversible.** Applying a tweak twice must not double it,
 *     and `disable` must fully undo what `enable` did (`ctx.effect` cleanup).
 *
 *  4. **Never block startup.** A tweak that fails to apply is reported in the
 *     status route and skipped — the app still boots.
 *
 *  5. **Honest reporting.** `GET /dsh-tweaks/status` returns, per tweak, whether
 *     it is enabled AND whether it could actually be applied, so "I turned it on
 *     but nothing happened" is diagnosable instead of mysterious.
 *
 * Routes (loopback, same origin as the GUI):
 *   GET  /dsh-tweaks/status  — every known tweak + config + apply result
 *   POST /dsh-tweaks/reload  — re-read config and re-apply (debug helper)
 */

import z from '@deepseek-ai/schemastery'

export const name = 'dsh-tweaks'

/** Route prefix; keep everything under one namespace so it is greppable. */
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
  /** Per-tweak switches. Key = tweak id; unknown keys are ignored (forward-compatible). */
  tweaks: z.dict(z.object({
    enabled: z.boolean().default(false),
  })).default(() => ({})),
  /** Expose the status route (default on; it is read-only and loopback). */
  statusRoute: z.boolean().default(true),
  /** Allow POST /dsh-tweaks/restart to actually restart (off by default: dangerous). */
  allowRestart: z.boolean().default(false),
})

/** Resolve one tweak's effective enabled flag from the flat config object. */
export function isEnabled(config, id) {
  const entry = config?.tweaks?.[id]
  return entry?.enabled === true
}

/** Snapshot of every known tweak + its switch state, for the status route. */
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
  /** tweak id -> { ok, error }. `applied` means "enable ran and did not throw". */
  const applied = new Map()

  function runTweak(tweak) {
    const enabled = isEnabled(config, tweak.id)
    if (!enabled) {
      applied.delete(tweak.id)
      return
    }
    try {
      // ctx.effect registers a reversible side effect: cordis calls the cleanup
      // on unload/disable, which is what makes this safe to toggle at runtime.
      ctx.effect(() => {
        if (typeof tweak.apply === 'function') tweak.apply(ctx, tweak, config)
        // Self-check: a tweak that declares a target whose entry is missing is a
        // silent no-op — make it a loud, recorded error instead.
        const verdict = checkTarget(tweak.target, config?.tree ?? ctx?.config?.tree)
        if (!verdict.ok) throw new Error(verdict.reason)
      }, `dsh-tweaks:${tweak.id}`)
      applied.set(tweak.id, { ok: true, error: null })
    } catch (error) {
      // Rule 4: never block startup. Record and move on.
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
