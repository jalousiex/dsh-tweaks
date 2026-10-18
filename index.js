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
import YAML from 'yaml'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
    id: 'hideBuiltinDeepseek',
    title: '隐藏内置供应商',
    what: '模型列表里只留「DeepSeek 账号」，去掉重复的内置 API key 那一组。',
    why:
      '内置 llm-deepseek 是 API key 路由，和「DeepSeek 账号」（llm-deepseek-account）' +
      '在设置与模型下拉里并列出两组同名模型。只用账号登录时，把内置那组关掉，' +
      '列表里就只剩「DeepSeek 账号」。',
    // 生效对象：Loader 条目（宿主侧的插件行）。
    subject: { kind: 'entry', name: 'llm-deepseek', label: '内置 DeepSeek 供应商' },
    effect: '禁用该条目（disabled），不改任何文件。',
    appliesWhen: '该条目在当前 profile 里存在。',
    target: 'llm-deepseek',
  },
  {
    id: 'hideUnroutableModels',
    title: '剔掉用不了的模型',
    what: '把目录里在列、但一选就报错的模型从模型列表里摘掉。',
    why:
      '网关目录（/v3/config）里在列、但 /v2/chat/completions 恒 11102 service info not found 的条目' +
      '（glm-4.6v / kimi-k2-thinking / minimax-m2.5 / hy4-preview-x）在 dsh-tap 里只是置灰，' +
      '仍占着设置卡列表与对话模型选择器——选中必失败。本开关把它们从选择器里摘掉、' +
      '设置卡里的行连空分组标题一起隐去：停用走 dsh-tap 自己的 /dsh-tap/settings 路由' +
      '（modelSetEnabled=false，与卡片勾选同一条路径，顺带重铺宿主镜像），不写它的文件；' +
      '开之前处于启用状态的 id 记在 ~/.dsh/.cache/dsh-tweaks/hide-unroutable.json，' +
      '关闭时按这份清单勾回去。只在启动/开关时执行一次（不做周期对账）——' +
      '在 dsh-tap 卡里手动勾回的条目，下次启动会被再剔一次。',
    // 生效对象：另一个插件（dsh-tap）自己的数据。
    subject: { kind: 'plugin', name: 'dsh-tap', label: 'dsh-tap（CodeBuddy 网关）' },
    effect: '调它自己的设置路由停用死模型；设置卡里的行靠 CSS 隐去。',
    appliesWhen: 'dsh-tap 已装且设置路由已就绪。',
    menu: true,
    apply: applyHideUnroutable,
    restore: restoreHideUnroutable,
  },
  {
    id: 'sidebarBalance',
    title: '侧边栏 DSH 余额',
    what: '侧边栏底部显示 DSH 内置账号的余额（充值 / 赠金分开，右侧带刷新）。',
    why:
      'DSH 内置账号的余额只在「设置 → 账号」里看得到，每次都要开面板。把它挪到侧边栏，' +
      '与渠道余量卡片（dsh-tap-quota）并排，一眼能同时看到「平台余额」和「上游渠道余量」。' +
      '数据走宿主服务 deepseekAccount.getBalance（与「设置 → 账号」同源，同一种口径）；' +
      '金额是十进制字符串，**原样透传**——内置 formatBalance 用 Big 做 roundDown，' +
      '先转 Number 会把 12.34 变成 12.339999，最后一位就漂了。充值与赠金分开显示、不相加。' +
      '服务不在（未装 dsh-deepseek-account-platform）或未登录时整块不渲染，失败不阻塞启动。' +
      '注意：这里**不显示** CodeBuddy/WorkBuddy 企业套餐的额度——那个数字在网页控制台的 ' +
      'cookie 体系里，OAuth 不可达（见 dsh-tap docs/rules/quota-signals.md R-Q10，标未解）。',
    // 生效对象：宿主内置账号服务（不是插件、不是文件）。
    subject: { kind: 'host', name: 'deepseekAccount', label: 'DSH 内置账号服务' },
    effect: '读 getBalance / getState，经 /dsh-tweaks/balance 下发给浏览器半渲染。',
    appliesWhen: 'deepseekAccount 服务已组合（dsh-deepseek-account-platform 在位）。',
    menu: true,
  },
  {
    id: 'fixTapWebPin',
    title: '修复 dsh-tap 假告警',
    what: '修掉 CodeBuddy 卡里常驻的「宿主漂移」假告警（本机补丁）。',
    why:
      '**这一项不是插件该做的事，是本机维护脚本**——它改的是 dsh-tap 已安装的产物' +
      '（profiles\\<profile>\\node_modules\\dsh-tap\\index.js），属于技术债，登记在此只为可追溯与自动补回。' +
      '原理：dsh-tap 0.20.0 的 webPin 对账探测 webService.searchProviderId/fetchProviderId——' +
      '这两个实例字段在 dsh-web 的 WebRuntime 里不存在（真实值在 config volatile 字段' +
      'searchProvider.get()/fetchProvider.get()），所以 CodeBuddy 卡的「宿主漂移」是常驻假 warn。' +
      '开启 = 把那段坏探测原样替换成正确取值路径（幂等；已是修复版则跳过）。**重启 DSH 后生效**' +
      '（hmr 不监听 node_modules）。重装/升级 dsh-tap 会冲掉补丁，本开关每次启动自动补回；' +
      '若上游代码形态变了（对不上 OLD 片段），不动文件并在状态里如实报「形态不匹配」。' +
      '根治办法是把修复报给 dsh-tap 上游，而不是长期打补丁。',
    subject: { kind: 'file', name: 'dsh-tap/index.js', label: 'dsh-tap 的 index.js' },
    effect: '对该文件做幂等字符串替换。',
    appliesWhen: '本机能找到 dsh-tap；改了需重启 DSH。',
    menu: true,
    apply: applyFixTapWebPin,
    restore: restoreFixTapWebPin,
  },
])

export const Config = z.object({
  /**
   * 每个改动的开关。键 = 改动 id；未知键直接忽略（向前兼容）。
   * 注意：这一 schemastery 版本的嵌套容器默认值必须是**值**而不是函数，
   * `.default(() => ({}))` 会让「配置里没写 tweaks」直接校验失败。
   */
  tweaks: z.dict(z.object({
    enabled: z.boolean().default(false),
  })).default({}),
  /** 是否暴露状态路由（默认开；它只读且在 loopback 上）。 */
  statusRoute: z.boolean().default(true),
  /**
   * 数据类改动（调目标插件自己的路由）的重试策略。
   * 上游路由尚未注册时会失败，短间隔重试若干次后如实记状态，绝不阻塞启动。
   */
  dataRetry: z.object({
    attempts: z.number().default(8),
    intervalMs: z.number().default(2000),
  }).default({}),
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

/** 从扁平的配置对象里解出某个改动的实际启用状态。 */
export function isEnabled(config, id) {
  const entry = config?.tweaks?.[id]
  return entry?.enabled === true
}

/** 所有已知改动及其开关状态快照，供状态路由使用。 */
export function describeTweaks(config, applied, servicePresent) {
  return TWEAKS.map((t) => {
    const enabled = isEnabled(config, t.id)
    const state = applied.get(t.id)
    const subject = describeSubject(t, undefined, enabled, state, servicePresent)
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

/**
 * 校验候选的 patch 文本是不是一个能解析的 YAML 文档列表。
 * 纯函数，便于单测；不修改任何文件。返回 `{ ok, error }`。
 *
 * 为什么必须有：③ 覆盖层一旦写成不可解析的 YAML，宿主下次启动会在
 * `parsePatchList` 直接抛错、整层丢失——而这层正是本插件开关的权威落点。
 * 所以 `/toggle` 落盘前必须先过这一关：宁可拒绝写入，也绝不写出坏配置。
 */
export function validatePatchText(text) {
  try {
    const doc = YAML.parseDocument(String(text))
    if (doc.errors && doc.errors.length) {
      const first = doc.errors[0]
      const where = first && first.pos ? ` (line ${first.pos[0] + 1})` : ''
      return { ok: false, error: `YAML 解析失败${where}: ${first ? first.message : 'unknown'}` }
    }
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: `YAML 解析失败: ${String((error && error.message) || error)}` }
  }
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

// ── 数据类改动（hideUnroutableModels）的支撑 ──────────────────────────────
// 这类开关的效果不在 Loader 条目上（为了剔几个模型把 dsh-tap 整条禁掉是不行的），
// 而是调目标插件自己的设置路由。所以它只在 apply/restore 里做事，状态照样进
// /dsh-tweaks/status。

/** dsh-tap 设置卡自己的路由（GET 视图 / POST 动作共用同一个入口）。 */
export const TAP_SETTINGS_ROUTE = '/dsh-tap/settings'

// ── fixTapWebPin：给 dsh-tap 的 node_modules 副本打探测补丁 ────────────────
// 不是路由类开关，也不动 Loader 条目：效果是磁盘文件补丁（幂等）。
// 上游升级冲掉补丁时，本开关每次启动把它补回去；restore 还原上游原样。

/**
 * dsh-tap 0.20.0 的坏探测段（`dsh plugin add` 后的原始形态）。
 * 补丁按「原样字符串替换」打：片段对不上 = 形态变了 = 不动 + 如实报状态。
 */
export const TAP_WEBPIN_OLD = `  try {
    const sp = webService?.()?.searchProviderId
    const fp = webService?.()?.fetchProviderId
    if (sp !== undefined || fp !== undefined || webService?.()) {
      out.webPin = { searchProvider: sp ?? null, fetchProvider: fp ?? null, ok: sp === 'codebuddy' && fp === 'codebuddy' }
    }
  } catch { out.webPin = null }`

/** 补丁后的正确取值路径（与 dsh-web WebRuntime.search()/fetch() 同款）。 */
export const TAP_WEBPIN_NEW = `  try {
    // WebRuntime 取钉选的真实路径（search()/fetch() 同款）：config volatile 字段
    // 现取 + env 覆盖兜底（$DSH_WEB_SEARCH_PROVIDER 优先级与 search() 内一致：
    // config.get() ?? env）。实例上不存在 searchProviderId/fetchProviderId 字段。
    const readPin = (field, envName) => {
      const svc = webService?.()
      if (!svc) return undefined
      const getter = svc?.config?.[field]?.get
      const configured = typeof getter === 'function' ? (() => { try { return getter.call(svc.config[field]) } catch { return undefined } })() : undefined
      return configured ?? svc?.[field === 'searchProvider' ? 'searchProviderEnv' : 'fetchProviderEnv'] ?? process.env[envName]
    }
    const sp = readPin('searchProvider', 'DSH_WEB_SEARCH_PROVIDER')
    const fp = readPin('fetchProvider', 'DSH_WEB_FETCH_PROVIDER')
    if (sp !== undefined || fp !== undefined) {
      out.webPin = { searchProvider: sp ?? null, fetchProvider: fp ?? null, ok: sp === 'codebuddy' && fp === 'codebuddy' }
    }
  } catch { out.webPin = null }`

/**
 * dsh-tap 的 node_modules 部署位置：`<DSH_HOME>\profiles\<profile>\node_modules\dsh-tap\index.js`。
 * profile 目录名不硬编码——扫描 profiles\ 下带 node_modules\dsh-tap 的那个。
 */
export function tapIndexPath(dshHome) {
  const home = dshHome || dshHomePath()
  const profilesDir = join(home, 'profiles')
  let candidates = []
  try {
    candidates = readdirSync(profilesDir).filter((name) => {
      try { return statSync(join(profilesDir, name)).isDirectory() } catch { return false }
    })
  } catch {
    return null
  }
  for (const name of candidates) {
    const hit = join(profilesDir, name, 'node_modules', 'dsh-tap', 'index.js')
    try {
      if (statSync(hit).isFile()) return hit
    } catch {}
  }
  return null
}

/**
 * 纯函数（便于单测）：对 dsh-tap index.js 文本打/撤 webPin 补丁。
 * 返回 `{ text, state }`；state ∈ 'patched'（已打上）| 'upstream'（已还原）| 'unknown'（形态对不上，原样返回）。
 */
export function patchTapWebPinText(text, apply_) {
  const hasOld = text.includes(TAP_WEBPIN_OLD)
  const hasNew = text.includes(TAP_WEBPIN_NEW)
  if (apply_) {
    if (hasNew) return { text, state: 'patched' }
    if (!hasOld) return { text, state: 'unknown' }
    return { text: text.split(TAP_WEBPIN_OLD).join(TAP_WEBPIN_NEW), state: 'patched' }
  }
  if (hasOld) return { text, state: 'upstream' }
  if (!hasNew) return { text, state: 'unknown' }
  return { text: text.split(TAP_WEBPIN_NEW).join(TAP_WEBPIN_OLD), state: 'upstream' }
}

/** fixTapWebPin 的「开」：把补丁写进 dsh-tap 的 index.js（已是修复版则不写）。 */
export async function applyFixTapWebPin({ dshHome } = {}) {
  const file = tapIndexPath(dshHome)
  if (!file) throw new Error('找不到 dsh-tap 的 node_modules 部署（profiles\\*\\node_modules\\dsh-tap\\index.js）')
  const before = readFileSync(file, 'utf8')
  const { text, state } = patchTapWebPinText(before, true)
  if (state === 'unknown') return { state, file, note: '上游代码形态变了，补丁对不上——未改动文件' }
  if (text !== before) writeFileSync(file, text, 'utf8')
  return { state, file, note: state === 'patched' && text !== before ? '已打补丁（重启 DSH 生效）' : '补丁已在位' }
}

/** fixTapWebPin 的「关」：还原 dsh-tap 上游原样（已是原样则不写）。 */
export async function restoreFixTapWebPin({ dshHome } = {}) {
  const file = tapIndexPath(dshHome)
  if (!file) throw new Error('找不到 dsh-tap 的 node_modules 部署（profiles\\*\\node_modules\\dsh-tap\\index.js）')
  const before = readFileSync(file, 'utf8')
  const { text, state } = patchTapWebPinText(before, false)
  if (state === 'unknown') return { state, file, note: '既非上游原样也非已知补丁形态——未改动文件' }
  if (text !== before) writeFileSync(file, text, 'utf8')
  return { state, file, note: state === 'upstream' && text !== before ? '已还原上游原样（重启 DSH 生效）' : '上游原样已在位' }
}

// ── sidebarBalance：把 DSH 内置账号余额搬到侧边栏 ───────────────────────
// 数据源是宿主服务 deepseekAccount（与「设置 → 账号」同源）。只读，不碰凭据：
// getBalance 只要一份 ClientMetadata（version/locale/timezoneOffsetSeconds），
// 它只被拼成 Platform 的 x-client-* 标识头，不参与鉴权。

/** Platform 只取语言主标签（zh → zh_CN），宿主用 ICU 的默认区域即可。 */
export function hostLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'
  } catch {
    return 'en-US'
  }
}

/** getBalance 的调用方标识：东八区为 +28800。与内置 accountClientMetadata 同口径。 */
export function accountClientMetadata() {
  return {
    version: process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '0.0.0',
    locale: hostLocale(),
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

/**
 * 归一化余额：`value` = 充值余额，`bonusWallets` = 赠金余额，**分开、不相加**。
 * 金额是十进制字符串，原样保留（浏览器端按同一套字符串截断规则格式化）。
 * 只收 CNY/USD；非字符串余额一律丢弃——不猜、不转 Number。
 */
export function normalizeBalance(balance) {
  if (balance === null || balance === undefined) return { ok: false, error: 'signed-out', wallets: [], bonusWallets: [] }
  if (balance.status !== 'ready') return { ok: false, error: 'read-failed', wallets: [], bonusWallets: [] }
  const pick = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((w) => w && typeof w.balance === 'string' && (w.currency === 'CNY' || w.currency === 'USD'))
      .map((w) => ({ currency: w.currency, balance: w.balance }))
  return { ok: true, wallets: pick(balance.value), bonusWallets: pick(balance.bonusWallets) }
}

/**
 * 读一次余额 + 登录态。两个读**各自**超时兜底：余额慢不该把登录态也拖没（反之亦然）。
 * 服务不在返回 null（调用方据此决定不渲染 / 报 missing）。
 */
export async function readBalance(service, timeoutMs = 6000) {
  if (!service) return null
  const TIMEOUT = Symbol('balance-timeout')
  const guarded = (promise) => {
    let timer = null
    return Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }
  const [state, balance] = await Promise.all([
    typeof service.getState === 'function' ? guarded(service.getState()).catch(() => null) : Promise.resolve(null),
    // 读失败与「未登录」是两件事：null 会被 normalizeBalance 判成 signed-out，
    // 那是误报。失败时显式给 failed，让它如实落到 read-failed。
    typeof service.getBalance === 'function'
      ? guarded(service.getBalance(accountClientMetadata())).catch(() => ({ status: 'failed' }))
      : Promise.resolve(undefined),
  ])
  return {
    signedIn: state?.status === 'credential-stored',
    // 服务没有 getBalance（undefined）= 未登录；调用过但失败 = read-failed。
    balance: balance === undefined ? normalizeBalance(null) : normalizeBalance(balance),
  }
}

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

/** 数据类改动的结果 → 状态路由里一句人话（null = 不写）。结果自带 note 时优先用它。 */
function describeDataResult(enabled, result) {
  if (result && typeof result.note === 'string') return result.note
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
 *   `ready`      就绪（对象在位、可用）
 *   `pending`    对象在位，但效果还没落上去
 *   `disabled`   对象在位但已被本开关禁用（条目类改动的稳态）
 *   `missing`    对象不在（插件没装 / 条目不在 Loader 树里）
 *   `mismatch`   对象在，但形态对不上（例如补丁片段不匹配）
 *
 * 注意：它只看「此刻的事实」，不猜。拿不准就报 missing 并把原因写进 label。
 */
export function describeSubject(tweak, entry, enabled, state, servicePresent) {
  if (!enabled) return { status: 'idle', label: '未启用' }
  if (state && state.error) return { status: 'mismatch', label: `对象在，但状态异常：${state.error}` }

  switch (tweak.subject && tweak.subject.kind) {
    case 'entry':
      if (!entry) return { status: 'missing', label: '条目不在当前 Loader 树里（插件可能被移除或改名）' }
      return entry.disabled === true
        ? { status: 'disabled', label: '条目在位，已被本开关禁用' }
        : { status: 'pending', label: '条目在位，但尚未禁用' }
    case 'plugin':
      return state && state.ok
        ? { status: 'ready', label: '插件在位，它的设置路由可用' }
        : { status: 'missing', label: '插件或其设置路由不可用（没装 / 还没起来）' }
    case 'file':
      if (!tapIndexPath()) return { status: 'missing', label: '找不到 dsh-tap 的 node_modules 部署' }
      return { status: 'ready', label: '文件在位（改完需重启 DSH 生效）' }
    case 'host':
      // 宿主内置能力（如 deepseekAccount）：由调用方把「服务在不在」传进来
      // （servicePresent 参数），保持本函数纯净可单测。
      return servicePresent === true
        ? { status: 'ready', label: '宿主服务在位' }
        : { status: 'missing', label: `取不到 ${tweak.subject?.name || '宿主服务'}（未组合或不可用）` }
    default:
      return { status: 'unknown', label: '未声明生效对象' }
  }
}

export function apply(ctx, config = {}) {
  /** 改动 id -> { ok, error }。`applied` 表示「enable 跑过且没抛错」。 */
  const applied = new Map()

  /**
   * 配置值兜底：schema 已经给了默认值，但 `apply` 也可能被裸调用（单测 /
   * 旧宿主），所以这里再兜一层，保证下面的算术不会拿到 undefined。
   */
  const retry = {
    attempts: positiveInt(config?.dataRetry?.attempts, 8),
    intervalMs: nonNegativeInt(config?.dataRetry?.intervalMs, 2000),
  }
  const reassertLimit = positiveInt(config?.reassertLimit, 10)
  const fallbackMs = nonNegativeInt(config?.fallbackReconcileMs, 0)
  const statusRefreshMs = positiveInt(config?.statusRefreshMs, 600000)

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
              const timer = setTimeout(() => { timers.delete(timer); attempt(left - 1) }, retry.intervalMs)
              timers.add(timer)
              return
            }
            applied.set(tweak.id, { ok: false, error: message })
          }
        }
        attempt(retry.attempts)
        return () => {
          cancelled = true
          for (const timer of timers) clearTimeout(timer)
          timers.clear()
        }
      }, `dsh-tweaks:${tweak.id}:data`)
    })
  }

  /** deepseekAccount 服务在不在（sidebarBalance 的生效对象）。 */
  function accountServicePresent() {
    try {
      return Boolean(ctx.get('deepseekAccount'))
    } catch {
      return false
    }
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
      // 无 target 的改动（如 sidebarBalance）没有条目可收敛，效果由它自己的
      // 路由兑现。这里只判「生效对象在不在」，把结论如实写进状态。
      if (tweak.subject?.name === 'deepseekAccount' && !accountServicePresent()) {
        applied.set(tweak.id, { ok: false, error: 'deepseekAccount 服务不在（dsh-deepseek-account-platform 未组合）' })
        return
      }
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
        const enabled = isEnabled(config, tweak.id)
        // 「对象状态」：这个改动赖以生效的对象此刻是什么状况。
        const subject = describeSubject(tweak, entry, enabled, state, accountServicePresent())
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
            // 落盘前必须过 YAML 这一关：③ 一旦写成不可解析的文档，宿主下次
            // 启动会在 parsePatchList 直接抛错、整层丢失（= 所有开关失效）。
            // 宁可不写，也绝不把坏配置写进权威层。
            const parsedBefore = validatePatchText(before)
            const parsedAfter = validatePatchText(after)
            if (!parsedBefore.ok) {
              throw new Error(file + ' 当前就不可解析，先修好它再切开关：' + parsedBefore.error)
            }
            if (!parsedAfter.ok) throw new Error('改写结果不可解析，已放弃写入：' + parsedAfter.error)
            writeFileSync(file, after, 'utf8')
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify({ ok: true, id: body.id, enabled: body.enabled === true, file }))
          } catch (error) {
            response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
          }
        },
      }), 'dsh-tweaks:toggle-route')

      /**
       * sidebarBalance 的数据源：DSH 内置账号余额。
       *
       * 实时读（带 10s 缓存吸收同一次轮询里的连点）。带 6s 硬性上限：
       * 浏览器端 fetch 超时是 8s，绝不能反过来挂住它。
       * 任何异常都转成可解析的 JSON，绝不抛进响应（否则浏览器端当成网络错误并退避）。
       */
      let balanceCache = { at: 0, value: null }
      const BALANCE_CACHE_MS = 10000
      wsctx.effect(() => wsctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/balance`,
        handler: async (request, response) => {
          const send = (payload) => {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify(payload))
          }
          try {
            const url = new URL(request.url ?? '/', 'http://127.0.0.1')
            const force = url.searchParams.get('refresh') === '1'
            if (!force && balanceCache.value && Date.now() - balanceCache.at < BALANCE_CACHE_MS) {
              return send(balanceCache.value)
            }
            const service = ctx.get('deepseekAccount')
            if (!service) {
              return send({ ok: false, at: Date.now(), signedIn: false, balance: null, reason: 'service-absent' })
            }
            const read = await readBalance(service, 6000)
            const payload = read
              ? { ok: true, at: Date.now(), signedIn: read.signedIn, balance: read.balance }
              : { ok: false, at: Date.now(), signedIn: false, balance: null, reason: 'read-failed' }
            if (payload.ok) balanceCache = { at: Date.now(), value: payload }
            send(payload)
          } catch (error) {
            send({ ok: false, at: Date.now(), signedIn: false, balance: null, reason: String((error && error.message) || error) })
          }
        },
      }), 'dsh-tweaks:balance-route')

    })
  }
}
