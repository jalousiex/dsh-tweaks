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
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
 * `what`   — one short sentence: what it changes (the card body).
 * `why`    — long rationale, shown by the status route / hover.
 * `target` — the Loader entry id this tweak disables. Omitted = nothing to
 *            disable (the client half renders something instead).
 * `subject`— WHAT the tweak acts on. `kind` picks the status check
 *            (entry / plugin / file / host); `name`/`label` are for display.
 * `owner`  — WHICH thing the switch belongs to, for grouping in the UI.
 *            Deliberately separate from `subject.kind` so a single component's
 *            tweaks stay together regardless of how each is implemented.
 */
export const TWEAKS = Object.freeze([
  {
    id: 'hideBuiltinDeepseek',
    title: '隐藏内置供应商',
    what: '模型列表里只留「DeepSeek 账号」，去掉重复的内置 API key 那一组。',
    why:
      '内置 llm-deepseek 是 API key 路由，和「DeepSeek 账号」（llm-deepseek-account）' +
      '在设置与模型下拉里并列出两组同名模型。只用账号登录时，把内置那组关掉，' +
      '列表里就只剩「DeepSeek 账号」。',
    // 生效对象：Loader 条目（宿主侧的插件行）。
    subject: { kind: 'entry', name: 'llm-deepseek', label: '内置 DeepSeek 供应商' },
    // 归属：DSH 自身的内置供应商条目。
    owner: { name: 'dsh', label: 'DeepSeek Harness', kind: 'host' },
    effect: '禁用该条目（disabled），不改任何文件。',
    appliesWhen: '该条目在当前 profile 里存在。',
    target: 'llm-deepseek',
  },
])

/**
 * Config schema —— **只放不在运行时切换的参数**。
 *
 * 开关值（每个 tweak 的 enabled）**不在这里**：它们存在插件自己的状态文件
 * （`~/.dsh/.cache/dsh-tweaks/state.json`），切换走 `/dsh-tweaks/toggle`，
 * 写文件后就地重跑 apply/restore。
 *
 * 为什么不能放 Config：profile 是 `patchReload: live`，任何 `settings.update`
 * 写入都会让**本插件条目热重载**；条目一重载，客户端注册的 slot（含设置窗口的
 * 「增强补丁」分区）就随之销毁重建 —— 表现就是「点一下开关，整个界面闪一下/
 * 分区消失」。把开关移出 Config 才能让切换过程完全不碰条目生命周期。
 *
 * 注意：这里的字段都**不加** `.volatile()`，因此不会被投影成设置窗口的表单，
 * 也就没有第二个写入者。
 */
export const Config = z.object({
  /** 是否暴露状态路由（默认开；它只读且在 loopback 上）。 */
  statusRoute: z.boolean().default(true),
  /**
   * 对账型改动的重断言上限：目标条目被反复弹回启用时，放弃并如实报
   * 「target flips back after disable」，避免无休止地改写别人的条目。
   */
  reassertLimit: z.number().default(10),
  /**
   * 兜底对账间隔（毫秒）。默认 0 = 只在启动与 Loader/插件组合变化时对账
   * （事件驱动，不轮询）；>0 才额外启用这个间隔的兜底定时器。
   */
  fallbackReconcileMs: z.number().default(0),
  /** 浏览器半的状态兜底刷新间隔（毫秒），由 /dsh-tweaks/status 下发给客户端。 */
  statusRefreshMs: z.number().default(600000),
})

/** 开关状态文件位置：本机 `.cache`，不进同步盘（属一次性运行时状态）。 */
export function statePath(dshHome) {
  return join(dshHome || dshHomePath(), '.cache', 'dsh-tweaks', 'state.json')
}

/**
 * 读开关状态文件。返回 `{ <tweakId>: boolean }`。
 * 文件缺失/损坏一律当「全关」，绝不抛错（启动不能被它拖住）。
 */
export function readState(dshHome) {
  try {
    const doc = JSON.parse(readFileSync(statePath(dshHome), 'utf8'))
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {}
    const out = {}
    for (const t of TWEAKS) out[t.id] = doc[t.id] === true
    return out
  } catch {
    return Object.fromEntries(TWEAKS.map((t) => [t.id, false]))
  }
}

/** 写开关状态文件（临时文件 + rename 原子替换），失败返回 false 不抛。 */
export function writeState(dshHome, next) {
  const file = statePath(dshHome)
  const tmp = file + '.tmp'
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    try { rmSync(tmp, { force: true }) } catch {}
    return false
  }
}

/** 从状态对象里解出某个改动的实际启用状态。 */
export function isEnabled(state, id) {
  return state?.[id] === true
}

/** 所有已知改动及其开关状态快照，供状态路由使用。 */
export function describeTweaks(config, applied) {
  return TWEAKS.map((t) => {
    const enabled = isEnabled(config, t.id)
    const state = applied.get(t.id)
    const subject = describeSubject(t, undefined, enabled, state)
    return {
      id: t.id,
      title: t.title,
      what: t.what || null,
      why: t.why,
      target: t.target ?? null,
      action: t.action ?? null,
      enabled,
      applied: applied.has(t.id),
      error: state?.error ?? null,
      subject: t.subject || null,
      owner: t.owner || null,
      ownerName: t.owner?.name ?? null,
      ownerLabel: t.owner?.label ?? null,
      ownerKind: t.owner?.kind ?? null,
      group: t.group ?? null,
      subjectKind: t.subject?.kind ?? null,
      subjectLabel: t.subject?.label ?? null,
      subjectStatus: subject.status,
      subjectStatusLabel: subject.label,
      effect: t.effect || null,
      appliesWhen: t.appliesWhen || null,
    }
  })
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

function dshHomePath() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

// ── 重启宿主：已迁出到独立插件 dsh-restart ─────────────────────────────────
// 原先这里有一份 spawn + process.exit 的重启实现（restartButton 开关）。它被删掉
// 是因为：① 官方没有能重启宿主的 Host 服务，自己退进程属于越界；② 它「先拉起新
// 进程、再退旧进程」会和新进程抢监听端口；③ 入口太深（插件设置页），而 dsh-restart
// 提供 /restart 命令与 restart_harness 工具，还会记录进行中会话以便重启后续跑。
// 现在重启一律走 dsh-restart，本插件不再碰进程生命周期。

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

/** 取一个「正整数」配置值；非法或缺失时回退到 fallback。 */
function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/** 取一个「非负整数」配置值；非法或缺失时回退到 fallback（0 = 关闭该定时器）。 */
function nonNegativeInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

/**
 * 「对象状态」：这个改动赖以生效的对象此刻是什么状况。
 *
 * 返回 `{ status, label }`，status ∈
 *   `idle`       开关没开（谈不上生效对象的状态）
 *   `disabled`   条目在位且已被本开关禁用（条目类改动的稳态）
 *   `pending`    条目在位，但尚未禁用
 *   `missing`    条目不在 Loader 树里
 *   `mismatch`   条目在，但状态异常
 *
 * 注意：它只看「此刻的事实」，不猜。拿不准就报 missing 并把原因写进 label。
 */
export function describeSubject(tweak, entry, enabled, state) {
  if (!enabled) return { status: 'idle', label: '未启用' }

  if (state && state.error) return { status: 'mismatch', label: `对象在，但状态异常：${state.error}` }

  if (!entry) return { status: 'missing', label: '条目不在当前 Loader 树里（插件可能被移除或改名）' }
  return entry.disabled === true
    ? { status: 'disabled', label: '条目在位，已被本开关禁用' }
    : { status: 'pending', label: '条目在位，但尚未禁用' }
}

export function apply(ctx, config = {}) {
  /** 改动 id -> { ok, error }。`applied` 表示「enable 跑过且没抛错」。 */
  const applied = new Map()

  /**
   * 开关状态（活值）。从自己的状态文件读，切换时**原地改这个对象**，
   * 不碰 Config / profile patch —— 因此不会触发本插件条目热重载，
   * 客户端注册的 slot 也不会被销毁重建。
   */
  let switches = readState()
  /** 每个 tweak 已注册的 effect 的 disposer（切换时先撤销再按新状态重建）。 */
  const disposers = new Map()

  /**
   * 配置值兜底：schema 已经给了默认值，但 `apply` 也可能被裸调用（单测 /
   * 旧宿主），所以这里再兜一层，保证下面的算术不会拿到 undefined。
   */
  const reassertLimit = positiveInt(config?.reassertLimit, 10)
  const fallbackMs = nonNegativeInt(config?.fallbackReconcileMs, 0)
  const statusRefreshMs = positiveInt(config?.statusRefreshMs, 600000)

  /** 撤掉某个 tweak 已注册的副作用（若在），供就地重跑前清理。 */
  function disposeTweak(id) {
    const off = disposers.get(id)
    disposers.delete(id)
    if (typeof off === 'function') {
      try { off() } catch {}
    }
  }

  function runTweak(tweak) {
    const enabled = isEnabled(switches, tweak.id)
    if (!enabled) {
      applied.delete(tweak.id)
      return
    }
    try {
      // ctx.effect 注册的是可逆副作用：cordis 在卸载/禁用时会调用清理回调，
      // 这正是它能在运行时安全开关的原因。disposer 存进 disposers，
      // 供 /toggle 就地重跑时先撤销。
      const off = ctx.effect(() => {
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
          if (reasserts >= reassertLimit) {
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
        /**
         * 对账时机（事件驱动，不轮询）：
         *   · 启动一次——先让 Loader 跑完这一轮，再动兄弟条目；
         *   · `app-boot/config-reload`——配置热应用后条目被重建，正是需要重新
         *     收敛的时候（原来靠 3 秒定时器补，现在由事件精确通知）；
         *   · `plugin-manager/changed`——插件/组合变化同样会重建条目。
         * `fallbackReconcileMs > 0` 时才额外挂一个兜底间隔（默认关闭）。
         */
        const first = setTimeout(tick, 0)
        const reload = ctx.on('app-boot/config-reload', () => { tick() })
        const plugins = ctx.on('plugin-manager/changed', () => { tick() })
        const interval = fallbackMs > 0 ? setInterval(tick, fallbackMs) : null
        return () => {
          cancelled = true
          clearTimeout(first)
          reload()
          plugins()
          if (interval) clearInterval(interval)
          if (touched) restoreEntry(findEntry(loaderOf(ctx), tweak.target), undefined)
        }
      }, `dsh-tweaks:${tweak.id}`)
      if (typeof off === 'function') disposers.set(tweak.id, off)
      applied.set(tweak.id, { ok: true, error: null })
    } catch (error) {
      // 规则 4：绝不阻塞启动。记录下来继续。
      applied.set(tweak.id, { ok: false, error: String(error?.message ?? error) })
    }
  }

  function applyAll() {
    for (const tweak of TWEAKS) runTweak(tweak)
  }

  /**
   * 就地重跑全部 tweak：先撤销已注册的副作用，再按当前 `switches` 重建。
   *
   * /toggle 走这里而不是 `settings.update` —— 后者会写 profile patch 并触发
   * 本插件条目热重载（客户端 slot 随之闪断/消失）。这里只动进程内副作用，
   * 客户端完全感知不到界面被重建。
   */
  function reconcileAll() {
    for (const tweak of TWEAKS) disposeTweak(tweak.id)
    applied.clear()
    applyAll()
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
        const enabled = isEnabled(switches, tweak.id)
        // 「对象状态」：这个改动赖以生效的对象此刻是什么状况。
        const subject = describeSubject(tweak, entry, enabled, state)
        return {
          id: tweak.id,
          title: tweak.title,
          what: tweak.what || null,
          why: tweak.why || '',
          target: tweak.target ?? null,
          action: tweak.action ?? null,
          // 菜单里要不要给这一行：带 target 的改动天然有行；数据类改动显式声明。
          menu: tweak.menu === true || Boolean(tweak.target) || tweak.action === 'restart',
          enabled,
          applied: Boolean(state && state.ok),
          present: Boolean(entry),
          effective: entry ? entry.disabled === true : null,
          reasserts: (state && state.reasserts) || 0,
          note: (state && state.note) || null,
          error: (state && state.error) || null,
          // 生效对象与它的状态（界面卡片直接渲染这几项）。
          subject: tweak.subject || null,
          subjectKind: (tweak.subject && tweak.subject.kind) || null,
          subjectLabel: (tweak.subject && tweak.subject.label) || null,
          // 归属（分组用）：标识这条补丁属于哪个组件。
          owner: tweak.owner || null,
          ownerName: (tweak.owner && tweak.owner.name) || null,
          ownerLabel: (tweak.owner && tweak.owner.label) || null,
          ownerKind: (tweak.owner && tweak.owner.kind) || null,
          group: tweak.group ?? null,
          subjectStatus: subject.status,
          subjectStatusLabel: subject.label,
          effect: tweak.effect || null,
          appliesWhen: tweak.appliesWhen || null,
        }
      }),
      // 下发给浏览器半的配置（只给客户端真正用得上的值）。
      // 注：重启已迁到 dsh-restart，原先下发的 restartDelayMs 随之移除。
      config: { statusRefreshMs },
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
      /**
       * 开关切换：写插件自己的状态文件 + **就地重跑**，全程不碰 Config / patch 层。
       *
       * 为什么不用 settings.update：它写 profile patch，而 profile 是
       * `patchReload: live` —— 一次写入就让本插件条目热重载，客户端注册的
       * slot（设置窗口的「增强补丁」分区）随之销毁重建，表现就是「点一下开关，
       * 右边内容整个消失」。写自己的文件 + 进程内 reconcile 完全不触发那条链。
       */
      wsctx.effect(() => wsctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/toggle`,
        handler: async (request, response) => {
          try {
            const raw = await readRequestBody(request)
            const body = JSON.parse(raw || '{}')
            if (!TWEAKS.some((t) => t.id === body.id)) throw new Error('unknown tweak: ' + body.id)
            const enabled = body.enabled === true
            // 1) 落盘（原子写；失败要如实报，不能假装成功）
            const next = { ...switches, [body.id]: enabled }
            if (!writeState(undefined, next)) throw new Error('开关状态写入失败（检查 ~/.dsh/.cache 是否可写）')
            // 2) 更新活值并就地重跑（不触发条目重载）
            switches = next
            reconcileAll()
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify({ ok: true, id: body.id, enabled }))
          } catch (error) {
            response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
          }
        },
      }), 'dsh-tweaks:toggle-route')

    })
  }
}
