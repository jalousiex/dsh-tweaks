/**
 * Standalone checks for dsh-tweaks (no deps; runs outside a dsh profile).
 *
 *   node test/run.mjs
 *
 * Two harnesses mirroring dsh-model-info's tests:
 *   - host half: index.js evaluated in a vm with schemastery stubbed, so the
 *     pure helpers (isEnabled / describeTweaks / TWEAKS) run as-is;
 *   - browser half: lib/client.js evaluated against a fake __ModuleLoader__.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const require_ = createRequire(import.meta.url)
function loadSchemastery() {
  const candidates = [
    join(root, 'node_modules', '@deepseek-ai', 'schemastery'),
    join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'schemastery'),
  ]
  for (const spec of candidates) {
    try { return require_(spec) } catch {}
  }
  return null
}
// 有真 schemastery 就用它（宿主半能按真 schema 构造），没有就退回空桩：
// 纯函数断言照样能跑，只有依赖 schema 求值的部分会退化。
const Schemastery = loadSchemastery()

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`)
  }
}
function ok(name, cond) {
  check(name, cond === true, true)
}

// ── host half ────────────────────────────────────────────────────────────
const hostSource = readFileSync(join(root, 'index.js'), 'utf8')
  .replace(
    /^import z from '@deepseek-ai\/schemastery'$/m,
    Schemastery ? 'const z = hostZ;' : 'const z = new Proxy(function () {}, { get: () => z, apply: () => z })',
  )
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')

const hostCtx = {
  console,
  process,
  Buffer,
  setTimeout,
  clearTimeout,
  join,
  dirname,
  homedir,
  mkdirSync,
  renameSync,
  rmSync,
  readFileSync,
  writeFileSync,
  hostZ: Schemastery ? Schemastery.default || Schemastery : undefined,
  Promise,
  Symbol,
  Intl,
}
vm.createContext(hostCtx)
vm.runInContext(hostSource + '\n;globalThis.__host = { TWEAKS, isEnabled, describeTweaks, checkTarget, findEntry, disableEntry, restoreEntry, describeSubject, Config, statePath, readState, writeState };', hostCtx)
const { TWEAKS, isEnabled, describeTweaks, checkTarget, findEntry, disableEntry, restoreEntry, describeSubject, Config, statePath, readState, writeState } = hostCtx.__host

console.log('TWEAKS registry:')
ok('is a non-empty frozen list', Array.isArray(TWEAKS) && TWEAKS.length > 0 && Object.isFrozen(TWEAKS))
ok('every tweak has id/title/why', TWEAKS.every((t) => t.id && t.title && t.why))
ok(
  'ids are unique',
  new Set(TWEAKS.map((t) => t.id)).size === TWEAKS.length,
)
ok('hideBuiltinDeepseek is registered', TWEAKS.some((t) => t.id === 'hideBuiltinDeepseek'))
ok('hideUnroutableModels is gone', !TWEAKS.some((t) => t.id === 'hideUnroutableModels'))
ok('fixTapWebPin is gone', !TWEAKS.some((t) => t.id === 'fixTapWebPin'))
ok('sidebarBalance is gone', !TWEAKS.some((t) => t.id === 'sidebarBalance'))

console.log('tweaks targets:')
check('hideBuiltinDeepseek targets the built-in provider', TWEAKS.find((t) => t.id === 'hideBuiltinDeepseek').target, 'llm-deepseek')
check('no tweak targets the settings models entry', TWEAKS.some((t) => t.target === 'ui-settings-models'), false)
ok('every tweak declares a loader target', TWEAKS.every((t) => typeof t.target === 'string' && t.target))
ok('no tweak carries apply/restore (only entry-disabling tweaks remain)', TWEAKS.every((t) => typeof t.apply !== 'function' && typeof t.restore !== 'function'))

console.log('Config schema (基础设施参数；开关不进 Config):')
ok('Config is defined', typeof Config !== 'undefined')
// 关键：开关**不能**在 Config 里 —— 否则 settings.update 会触发条目热重载，
// 客户端分区被销毁重建（「点一下开关，内容消失」的根因）。
for (const t of TWEAKS) {
  ok(t.id + ' is NOT a Config field', !Config.dict?.[t.id])
}
// 基础设施参数仍在 Config，且都不带 volatile（避免被投影成第二个写入者）。
ok('statusRoute exists', Boolean(Config.dict?.statusRoute))
ok('statusRoute is not volatile', Config.dict?.statusRoute?.meta?.volatile !== true)
ok('no volatile fields in Config at all', !Object.values(Config.dict || {}).some((f) => f?.meta?.volatile === true))
ok('no dataRetry (数据类改动已剥离)', !Config.dict?.dataRetry)
ok('no nested tweaks dict', !/tweaks:\s*z\.dict/.test(hostSource))

console.log('开关状态文件（切换不碰 Config/patch）:')
ok('statePath points into .cache', /statePath/.test(hostSource) && /\.cache['"],\s*'dsh-tweaks'/.test(hostSource))
ok('readState exists', /function readState/.test(hostSource))
ok('writeState exists', /function writeState/.test(hostSource))
ok('writeState uses atomic rename', /renameSync\(tmp, file\)/.test(hostSource))
// toggle 必须写状态文件 + 就地重跑，绝不调 settings.update。
ok('toggle writes the state file', /writeState\(undefined, next\)/.test(hostSource))
ok('toggle reconciles in place', /reconcileAll\(\)/.test(hostSource))
ok('toggle does NOT call settings.update', !/svc\.update\(name/.test(hostSource))
ok('toggle does NOT write cordis.patch.yml', !/writeFileSync\(file, after/.test(hostSource))
ok('reconcileAll disposes old effects first', /disposeTweak\(tweak\.id\)/.test(hostSource))

console.log('Config tunables (官方：无硬编码可调参数):')
ok('reassertLimit declared with default 10', /reassertLimit:\s*z\.number\(\)\.default\(10\)/.test(hostSource))
ok('fallbackReconcileMs defaults to 0 (event-driven, no polling)', /fallbackReconcileMs:\s*z\.number\(\)\.default\(0\)/.test(hostSource))
ok('statusRefreshMs declared with default', /statusRefreshMs:\s*z\.number\(\)\.default\(600000\)/.test(hostSource))
ok('statusRoute still defaults on', /statusRoute:\s*z\.boolean\(\)\.default\(true\)/.test(hostSource))
ok('apply() re-arms reassert/refresh from config, not literals', /positiveInt\(config\?\.reassertLimit, 10\)/.test(hostSource) && /nonNegativeInt\(config\?\.fallbackReconcileMs, 0\)/.test(hostSource))

console.log('event-driven reconcile (no polling):')
ok('reconcile listens to app-boot/config-reload', hostSource.includes("ctx.on('app-boot/config-reload'"))
ok('reconcile listens to plugin-manager/changed', hostSource.includes("ctx.on('plugin-manager/changed'"))
ok('no unconditional 3s polling', !/setInterval\(tick,\s*3000\)/.test(hostSource))
ok('fallback interval is opt-in via config', /fallbackMs > 0 \? setInterval/.test(hostSource))
ok('no hardcoded reassert ceiling', !/reasserts >= 10/.test(hostSource))

console.log('toggle route（写状态文件 + 就地重跑，不触发条目重载）:')
ok('toggle route exists', hostSource.includes('${ROUTE_PREFIX}/toggle'))
ok('no YAML import', !/^import YAML/m.test(hostSource))
ok('no settings dependency for toggling', !/ctx\.inject\(\['settings'\]/.test(hostSource))
ok('no /balance route (sidebarBalance 已剥离)', !hostSource.includes('${ROUTE_PREFIX}/balance'))
ok('no deepseekAccount usage', !/deepseekAccount/.test(hostSource))
ok('no dsh-tap references', !/dsh-tap/.test(hostSource))
ok('no webPin patch leftovers', !/TAP_WEBPIN/.test(hostSource) && !/patchTapWebPin/.test(hostSource))

console.log('loader reconciliation:')
const fakeEntry = {
  options: { id: 'llm-deepseek' },
  disabled: false,
  update(next) {
    this.options = next
    this.disabled = next.disabled === true
    return Promise.resolve()
  },
}
const fakeLoader = { store: { 'llm-deepseek': fakeEntry }, *entries() { yield fakeEntry } }
ok('findEntry resolves by store id', findEntry(fakeLoader, 'llm-deepseek') === fakeEntry)
check('findEntry returns undefined for unknown id', findEntry(fakeLoader, 'nope'), undefined)
const plan = disableEntry(fakeEntry)
check('disableEntry remembers the previous value', plan.before, undefined)
ok('disableEntry actually disables the entry', fakeEntry.disabled === true)
restoreEntry(fakeEntry, plan.before)
ok('restoreEntry re-enables the entry', fakeEntry.disabled !== true)
const again = disableEntry(fakeEntry)
ok('disableEntry is idempotent', again.changed === true && disableEntry(fakeEntry).changed === false)
ok('status route injects webServer, not a phantom server service', hostSource.includes("ctx.inject(['webServer']") && !hostSource.includes("['server']"))

console.log('registry metadata (每条都要说清「生效对象」):')
ok(
  'every tweak declares subject.kind',
  TWEAKS.every((t) => t.subject && typeof t.subject.kind === 'string' && t.subject.kind),
)
ok(
  'every tweak declares subject.label',
  TWEAKS.every((t) => t.subject && typeof t.subject.label === 'string' && t.subject.label),
)
ok(
  'every tweak declares what (一句话描述)',
  TWEAKS.every((t) => typeof t.what === 'string' && t.what),
)
ok(
  'every tweak declares effect + appliesWhen',
  TWEAKS.every((t) => typeof t.effect === 'string' && t.effect && typeof t.appliesWhen === 'string' && t.appliesWhen),
)
ok(
  'subject kinds are from the known set',
  TWEAKS.every((t) => ['entry', 'plugin', 'file', 'host'].includes(t.subject.kind)),
)
check('hideBuiltinDeepseek acts on a loader entry', TWEAKS.find((t) => t.id === 'hideBuiltinDeepseek').subject.kind, 'entry')

console.log('describeSubject (对象状态):')
const entryTweak = TWEAKS.find((t) => t.id === 'hideBuiltinDeepseek')
check('disabled entry -> disabled', describeSubject(entryTweak, { disabled: true }, true, { ok: true }).status, 'disabled')
check('present entry not yet disabled -> pending', describeSubject(entryTweak, { disabled: false }, true, { ok: true }).status, 'pending')
check('absent entry -> missing', describeSubject(entryTweak, undefined, true, { ok: true }).status, 'missing')
check('switch off -> idle', describeSubject(entryTweak, { disabled: true }, false, undefined).status, 'idle')
check('apply error -> mismatch', describeSubject(entryTweak, { disabled: true }, true, { ok: false, error: 'boom' }).status, 'mismatch')
ok('missing carries a human reason', describeSubject(entryTweak, undefined, true, { ok: true }).label.includes('Loader'))

console.log('isEnabled (state[ id ] === true):')
check('unknown state -> false', isEnabled({}, 'hideBuiltinDeepseek'), false)
check('explicit false -> false', isEnabled({ hideBuiltinDeepseek: false }, 'hideBuiltinDeepseek'), false)
check('explicit true -> true', isEnabled({ hideBuiltinDeepseek: true }, 'hideBuiltinDeepseek'), true)
check('truthy non-boolean is not enough', isEnabled({ hideBuiltinDeepseek: 'yes' }, 'hideBuiltinDeepseek'), false)
check('null state -> false', isEnabled(null, 'hideBuiltinDeepseek'), false)

console.log('readState / writeState（状态文件读写）:')
{
  const tmpHome = join(root, 'test', 'tmp-state-home')
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  check('missing file -> all false', readState(tmpHome), Object.fromEntries(TWEAKS.map((t) => [t.id, false])))
  const next = { ...Object.fromEntries(TWEAKS.map((t) => [t.id, false])), hideBuiltinDeepseek: true }
  ok('writeState succeeds', writeState(tmpHome, next) === true)
  check('readState round-trips', readState(tmpHome), next)
  ok('state file is under .cache/dsh-tweaks', readFileSync(statePath(tmpHome), 'utf8').includes('hideBuiltinDeepseek'))
  // 损坏文件不抛、当全关
  writeFileSync(statePath(tmpHome), 'not json', 'utf8')
  check('corrupt file -> all false (no throw)', readState(tmpHome), Object.fromEntries(TWEAKS.map((t) => [t.id, false])))
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
}

console.log('describeTweaks:')
const described = describeTweaks({ hideBuiltinDeepseek: true }, new Map())
check('one row per tweak', described.length, TWEAKS.length)
const row = described.find((r) => r.id === 'hideBuiltinDeepseek')
ok('reflects enabled flag', row.enabled === true)
ok('reports applied=false when not applied', row.applied === false)
const withError = describeTweaks({}, new Map([['hideBuiltinDeepseek', { ok: false, error: 'boom' }]]))
ok('surfaces apply error', withError.find((r) => r.id === 'hideBuiltinDeepseek').error === 'boom')

console.log('checkTarget:')
check('no target -> ok', checkTarget(null, []).ok, true)
check('no target -> present null', checkTarget(null, []).present, null)
check('no tree -> ok (unverifiable is not a failure)', checkTarget('x', null).ok, true)
check('no tree -> present null', checkTarget('x', null).present, null)
check('target found by id', checkTarget('llm-deepseek', [{ id: 'llm-deepseek' }]).present, true)
check('target found by name', checkTarget('pkg', [{ name: 'pkg' }]).present, true)
check('target missing -> not ok', checkTarget('gone', [{ id: 'other' }]).ok, false)
check('target missing -> present false', checkTarget('gone', [{ id: 'other' }]).present, false)
ok('target missing -> reason names the target', checkTarget('gone', []).reason.includes('gone'))

// ── browser half ─────────────────────────────────────────────────────────
const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
let def = null
// fetch 桩：让 toggle() 能在测试里真的跑一遍（抓未定义常量这类运行时错）。
const fetchCalls = []
const clientCtx = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: (url, opts) => {
    fetchCalls.push({ url: String(url), method: opts && opts.method, body: opts && opts.body })
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ ok: true, id: 'hideBuiltinDeepseek', enabled: false })),
      json: () => Promise.resolve({ tweaks: [{ id: 'hideBuiltinDeepseek', target: 'llm-deepseek', enabled: false }] }),
    })
  },
  window: {
    __ModuleLoader__: {
      load(d) {
        def = d
      },
    },
  },
}
vm.createContext(clientCtx)
vm.runInContext(clientSource, clientCtx)
ok('client called ModuleLoader.load', def !== null)
ok('loader contract uses factory (not exports fn)', typeof def.factory === 'function')
// client 现在用 slots（React）渲染插件页开关列表——测试里给一个最小的 React 桩。
const fakeReact = { createElement: () => { throw new Error('no render in tests') }, useState: () => [{}, () => {}], useEffect: () => {} }
const client = def.factory(function (name) {
  if (name === 'react') return fakeReact
  throw new Error('client must not require modules besides react')
})
const api = client.__internals
ok('client declares the slots service', Array.isArray(client.inject) && client.inject.includes('slots'))

console.log('client:')
check('readTweaks with no doc -> no rows', api.readTweaks(null).rows.length, 0)
check(
  'readTweaks lists tweaks that have a target',
  api.readTweaks({ tweaks: [{ id: 'hideBuiltinDeepseek', target: 'llm-deepseek', enabled: true }] }).rows.length,
  1,
)
check(
  'readTweaks ignores unknown ids',
  api.readTweaks({ tweaks: [{ id: 'nope', target: null, enabled: true }] }).rows.length,
  0,
)

console.log('卡片字段（启用状态/描述/生效对象/对象状态/生效条件）:')
const cardRow = api.readTweaks({
  tweaks: [{
    id: 'hideBuiltinDeepseek',
    target: 'llm-deepseek',
    enabled: true,
    title: '隐藏内置供应商',
    what: '模型列表里只留「DeepSeek 账号」',
    why: '为什么',
    subjectKind: 'entry',
    subjectLabel: '内置 DeepSeek 供应商',
    subjectStatus: 'disabled',
    subjectStatusLabel: '条目在位，已被本开关禁用',
    effect: '禁用该条目',
    appliesWhen: '该条目在当前 profile 里存在',
  }],
}).rows[0]
check('carries title', cardRow.title, '隐藏内置供应商')
check('carries what (描述)', cardRow.what, '模型列表里只留「DeepSeek 账号」')
check('carries subjectKind (生效对象类型)', cardRow.subjectKind, 'entry')
check('carries subjectLabel (生效对象)', cardRow.subjectLabel, '内置 DeepSeek 供应商')
check('carries subjectStatus (对象状态)', cardRow.subjectStatus, 'disabled')
ok('carries subjectStatusLabel', cardRow.subjectStatusLabel.includes('已被本开关禁用'))
check('carries appliesWhen (生效条件)', cardRow.appliesWhen, '该条目在当前 profile 里存在')
ok('carries enabled (启用状态)', cardRow.enabled === true)
const bareRow = api.readTweaks({ tweaks: [{ id: 'x', target: 'y', enabled: false }] }).rows[0]
check('missing fields degrade safely', [bareRow.what, bareRow.subjectKind, bareRow.subjectLabel], ['', '', ''])
check('unknown subject status degrades safely', bareRow.subjectStatus, 'unknown')

console.log('入口划分（补丁开关在 settings.section，插件页只读）:')
ok('registers settings.section', /slots\.inject\("settings\.section"/.test(clientSource))
ok('section id is a short slug', /id: SECTION_ID/.test(clientSource) && /SECTION_ID = "tweaks"/.test(clientSource))
ok('section label is 增强补丁', /label: function \(\) \{ return "增强补丁"; \}/.test(clientSource))
ok('TweakCard keeps an interactive checkbox', /type: "checkbox"/.test(clientSource))
ok('checkbox toggles the tweak', /onChange: function \(e\) \{ toggle\(row\.id, e\.target\.checked\); \}/.test(clientSource))
ok('registers plugins.bundle.config with read-only info', /slots\.inject\("plugins\.bundle\.config"/.test(clientSource) && /\}, PluginInfo\);/.test(clientSource))
ok('PluginInfo explains why switches moved', /改开关会触发插件重载/.test(clientSource))
// 回归：toggle() 必须真的能跑通。
{
  let threw = null
  try {
    await api.toggle('hideBuiltinDeepseek', false)
  } catch (e) {
    threw = e
  }
  ok('toggle() runs without throwing', threw === null)
  const first = fetchCalls[0]
  ok('toggle() POSTs to /dsh-tweaks/toggle', first && first.method === 'POST' && first.url === '/dsh-tweaks/toggle')
  check('toggle() body carries id + enabled', first && JSON.parse(first.body), { id: 'hideBuiltinDeepseek', enabled: false })
  ok('toggle() polls /dsh-tweaks/status afterwards', fetchCalls.some((c) => c.url === '/dsh-tweaks/status'))
}

console.log('侧边栏入口（已撤销，记录原因）:')
ok('no longer registers sidebar.footer.action', !clientSource.includes('ctx.slots.inject("sidebar.footer.action"'))
ok('no dead sidebar component or slot id', !clientSource.includes('SidebarRestart') && !clientSource.includes('RESTART_SLOT_ID'))
ok('header records why the sidebar entry was dropped', clientSource.includes('那一行与 dsh-tap-quota 的余额卡片共用'))
ok('header records that the avatar menu has no item slot', clientSource.includes('没有任何菜单项 slot'))

console.log('卡片精简（详情进悬浮，不平铺）:')
ok('tooltip carries the full rationale', clientSource.includes('"依据：" + row.why') && clientSource.includes('"生效条件：" + row.appliesWhen') && clientSource.includes('"生效方式：" + row.effect'))
ok('tooltip carries enabled + subject + status', clientSource.includes('"当前：已启用"') && clientSource.includes('"对象状态：" + row.subjectStatusLabel'))
ok('card body renders only title + what', clientSource.includes('className: "dtw-title"') && clientSource.includes('className: "dtw-what"'))
ok('card meta shows only subject + status chips', clientSource.includes('dtw-meta'))
ok('errors still surface as a line', clientSource.includes('dtw-note-error'))

console.log('client static discipline (no dsh-tap DOM probing):')
ok('no MutationObserver (no in-place row to install)', !/new MutationObserver/.test(clientSource))
ok('no dsh-tap anchor selectors', !/cbc-group-title/.test(clientSource) && !/cbc-unroutable/.test(clientSource))
ok('no hide-unroutable CSS', !/cbc-listrow/.test(clientSource))
ok('no balance widget', !/installBalanceWidget/.test(clientSource) && !/BALANCE_CSS/.test(clientSource))
ok('no group subgroup machinery', !/groupByField/.test(clientSource) && !/SUBGROUP_LABEL/.test(clientSource))

console.log('client no dead requests / no hardcoded refresh:')
ok('refresh interval comes from the host status route', /state\.refreshMs/.test(clientSource) && /config\.statusRefreshMs/.test(clientSource))
ok('client still declares the slots service', clientSource.includes('inject = ["slots"]'))

console.log('回归：点开关后列表不能消失（transient /status 失败必须保留旧数据）:')
ok('transient failure keeps rows (no rows: [])', !/\.catch\(function \(\) \{\s*\n\s*state = \{ rows: \[\]/.test(clientSource))
ok('transient failure marks stale instead', /stale: true/.test(clientSource) && /rows: state\.rows \|\| \[\]/.test(clientSource))
ok('toggle failure keeps the list', /lastError: String/.test(clientSource) && /rows: state\.rows \|\| \[\]/.test(clientSource))
ok('page shows a stale banner', clientSource.includes('宿主正在重载'))
ok('page shows the last operation error', clientSource.includes('上一次操作失败'))

console.log('回归：按归属对象分组（owner）:')
ok('groups by owner', clientSource.includes('function groupRows(rows)') && /r\.ownerName \|\| "other"/.test(clientSource))
ok('owner order puts DSH first', /OWNER_ORDER = \["dsh"\]/.test(clientSource))
ok('renders a group header', clientSource.includes('function GroupHeader'))
ok('group header summarises enabled count', clientSource.includes('已启用'))
ok('group header flags abnormal objects', clientSource.includes('项异常'))
ok('groups wrap the cards', /React\.createElement\(GroupHeader/.test(clientSource))

console.log('回归：标题文案:')
check('hideBuiltinDeepseek title', TWEAKS.find((t) => t.id === 'hideBuiltinDeepseek').title, '隐藏内置供应商')

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
