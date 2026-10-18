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

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// `yaml` 是宿主半的真实依赖（写 ③ 前做解析校验）；vm 里必须给同一个实例。
// 独立跑测试时本包未必装了依赖，所以按「包内 → profile node_modules」顺序找。
const require_ = createRequire(import.meta.url)
function loadYaml() {
  const candidates = [
    join(root, 'node_modules', 'yaml'),
    join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'yaml'),
  ]
  for (const spec of candidates) {
    try { return require_(spec) } catch {}
  }
  throw new Error('找不到 yaml（先 pnpm i 或用 NODE_PATH 指向 profile node_modules）')
}
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
const YAML = loadYaml()
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
  .replace(
    /^import YAML from 'yaml'$/m,
    'const YAML = hostYaml;',
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
  readdirSync,
  statSync,
  hostYaml: YAML,
  hostZ: Schemastery ? Schemastery.default || Schemastery : undefined,
  // readBalance 用到 Promise / Symbol / Intl（超时竞速与本地化）
  Promise,
  Symbol,
  Intl,
}
vm.createContext(hostCtx)
vm.runInContext(hostSource + '\n;globalThis.__host = { TWEAKS, isEnabled, describeTweaks, checkTarget, findEntry, disableEntry, restoreEntry, unroutableIds, TAP_SETTINGS_ROUTE, setTweakEnabledInText, validatePatchText, describeSubject, patchTapWebPinText, tapIndexPath, TAP_WEBPIN_OLD, TAP_WEBPIN_NEW, Config, normalizeBalance, readBalance, accountClientMetadata };', hostCtx)
const { TWEAKS, isEnabled, describeTweaks, checkTarget, findEntry, disableEntry, restoreEntry, unroutableIds, TAP_SETTINGS_ROUTE, setTweakEnabledInText, validatePatchText, describeSubject, patchTapWebPinText, tapIndexPath, TAP_WEBPIN_OLD, TAP_WEBPIN_NEW, Config, normalizeBalance, readBalance, accountClientMetadata } = hostCtx.__host

console.log('TWEAKS registry:')
ok('is a non-empty frozen list', Array.isArray(TWEAKS) && TWEAKS.length > 0 && Object.isFrozen(TWEAKS))
ok('every tweak has id/title/why', TWEAKS.every((t) => t.id && t.title && t.why))
ok(
  'ids are unique',
  new Set(TWEAKS.map((t) => t.id)).size === TWEAKS.length,
)
ok('hideSettingsModels is gone (it disabled the whole 模型 settings section)', !TWEAKS.some((t) => t.id === 'hideSettingsModels'))
ok('hideUnroutableModels is registered', TWEAKS.some((t) => t.id === 'hideUnroutableModels'))
ok('fixTapWebPin is registered', TWEAKS.some((t) => t.id === 'fixTapWebPin'))

console.log('tweaks targets:')
check('hideBuiltinDeepseek targets the built-in provider', TWEAKS.find((t) => t.id === 'hideBuiltinDeepseek').target, 'llm-deepseek')
check('no tweak targets the settings models entry', TWEAKS.some((t) => t.target === 'ui-settings-models'), false)
const hideUnroutable = TWEAKS.find((t) => t.id === 'hideUnroutableModels')
check('hideUnroutableModels declares no loader target', hideUnroutable.target, undefined)
ok('hideUnroutableModels opts into the menu', hideUnroutable.menu === true)
ok('hideUnroutableModels has a host apply', typeof hideUnroutable.apply === 'function')
ok('hideUnroutableModels has a host restore', typeof hideUnroutable.restore === 'function')

console.log('unroutableIds:')
check('tweak route is dsh-tap settings', TAP_SETTINGS_ROUTE, '/dsh-tap/settings')
check('no view -> empty', unroutableIds(null), [])
check(
  'only catalog-present ids count',
  unroutableIds({
    catalog: { models: [{ id: 'glm-4.6v' }, { id: 'hy4-preview' }] },
    unroutable: { 'glm-4.6v': 'dead', 'hy4-preview-x': 'gone from catalog' },
  }),
  ['glm-4.6v'],
)
check(
  'all present ids are listed',
  unroutableIds({
    catalog: { models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    unroutable: { a: 'x', b: 'y' },
  }),
  ['a', 'b'],
)
check(
  'view without unroutable table -> empty',
  unroutableIds({ catalog: { models: [{ id: 'a' }] } }),
  [],
)

const patchText = [
  '- id: dsh-tweaks',
  '  name: "dsh-tweaks"',
  '  config:',
  '    tweaks:',
  '      hideUnroutableModels:',
  '        enabled: true        # 目录在列但不可路由',
  '      restartButton:',
  '        enabled: false',
  '- id: web',
].join('\n')
check(
  'toggle rewrites the boolean',
  setTweakEnabledInText(patchText, 'hideUnroutableModels', false).includes('        enabled: false        # 目录在列但不可路由'),
  true,
)
check(
  'toggle keeps the trailing comment of the sibling it does not touch',
  setTweakEnabledInText(patchText, 'restartButton', true).includes('        enabled: true'),
  true,
)
check(
  'toggle leaves the text alone for an unknown tweak',
  setTweakEnabledInText(patchText, 'nope', true),
  patchText,
)
check(
  'toggle leaves the text alone without a dsh-tweaks row',
  setTweakEnabledInText('- id: other\n  config: {}\n', 'hideUnroutableModels', true),
  '- id: other\n  config: {}\n',
)

console.log('validatePatchText (写 ③ 前的解析闸门):')
check('valid patch -> ok', validatePatchText('- id: a\n  config: {}\n').ok, true)
// 复刻本机 ③ 曾经出现过的真实故障：键缺冒号 → 整层不可解析。
const brokenPatch = [
  '- id: dsh-tweaks',
  '  name: "dsh-tweaks"',
  '  config:',
  '    tweaks:',
  '      hideUnroutableModels',
  '        enabled: true',
].join('\n')
check('missing colon -> not ok', validatePatchText(brokenPatch).ok, false)
ok('missing colon -> reason names YAML', validatePatchText(brokenPatch).error.includes('YAML'))
ok('missing colon -> reason carries a line number', /\(line \d+\)/.test(validatePatchText(brokenPatch).error))
check(
  'a valid toggle result still validates',
  validatePatchText(setTweakEnabledInText(patchText, 'restartButton', true)).ok,
  true,
)

console.log('Config tunables (官方：无硬编码可调参数):')
// schemastery 的 schema 读默认值的接口随版本变动，这里做稳定的静态断言：
// 每个可调参数都必须在 Config 里声明，且带默认值。
ok('dataRetry declared with defaults', /dataRetry:\s*z\.object\(\{[\s\S]*?attempts:\s*z\.number\(\)\.default\(8\)[\s\S]*?intervalMs:\s*z\.number\(\)\.default\(2000\)/.test(hostSource))
ok('reassertLimit declared with default 10', /reassertLimit:\s*z\.number\(\)\.default\(10\)/.test(hostSource))
ok('fallbackReconcileMs defaults to 0 (event-driven, no polling)', /fallbackReconcileMs:\s*z\.number\(\)\.default\(0\)/.test(hostSource))
ok('statusRefreshMs declared with default', /statusRefreshMs:\s*z\.number\(\)\.default\(600000\)/.test(hostSource))
ok('statusRoute still defaults on', /statusRoute:\s*z\.boolean\(\)\.default\(true\)/.test(hostSource))
ok('apply() re-arms the retry/interval from config, not literals', /positiveInt\(config\?\.dataRetry\?\.attempts, 8\)/.test(hostSource) && /nonNegativeInt\(config\?\.dataRetry\?\.intervalMs, 2000\)/.test(hostSource))
// 这一 schemastery 版本的嵌套容器默认值必须是「值」；写成函数会让
// 「配置里没写 tweaks / dataRetry」直接校验失败、插件起不来。
ok('tweaks default is a value, not a thunk', /tweaks:[\s\S]*?\}\)\.default\(\{\}\)/.test(hostSource) && !/tweaks:[\s\S]{0,120}\.default\(\(\) =>/.test(hostSource))
ok('dataRetry default is a value, not a thunk', /dataRetry:[\s\S]{0,200}\.default\(\{\}\)/.test(hostSource) && !/dataRetry:[\s\S]{0,200}\.default\(\(\) =>/.test(hostSource))

console.log('event-driven reconcile (no polling):')
ok('reconcile listens to app-boot/config-reload', hostSource.includes("ctx.on('app-boot/config-reload'"))
ok('reconcile listens to plugin-manager/changed', hostSource.includes("ctx.on('plugin-manager/changed'"))
ok('no unconditional 3s polling', !/setInterval\(tick,\s*3000\)/.test(hostSource))
ok('fallback interval is opt-in via config', /fallbackMs > 0 \? setInterval/.test(hostSource))
ok('no hardcoded retry literals', !/attempt\(8\)/.test(hostSource) && !/attempt\(left - 1\) \}, 2000\)/.test(hostSource))
ok('no hardcoded reassert ceiling', !/reasserts >= 10/.test(hostSource))
ok('toggle route validates before writing', /validatePatchText\(after\)/.test(hostSource))
ok('toggle route refuses to write an already-broken file', /validatePatchText\(before\)/.test(hostSource))

console.log('fixTapWebPin patch:')
ok('fixTapWebPin is registered', TWEAKS.some((t) => t.id === 'fixTapWebPin'))
const fixWebPin = TWEAKS.find((t) => t.id === 'fixTapWebPin')
check('fixTapWebPin declares no loader target', fixWebPin.target, undefined)
ok('fixTapWebPin opts into the menu', fixWebPin.menu === true)
ok('fixTapWebPin has host apply/restore', typeof fixWebPin.apply === 'function' && typeof fixWebPin.restore === 'function')
ok('OLD snippet carries the broken probe', TAP_WEBPIN_OLD.includes('searchProviderId') && TAP_WEBPIN_OLD.includes('fetchProviderId'))
ok('NEW snippet reads the volatile config getters', TAP_WEBPIN_NEW.includes("config?.[field]?.get") && TAP_WEBPIN_NEW.includes('DSH_WEB_SEARCH_PROVIDER'))
check(
  'upstream text -> patched',
  patchTapWebPinText(TAP_WEBPIN_OLD, true).state,
  'patched',
)
check('upstream -> patched replaces the segment', patchTapWebPinText(TAP_WEBPIN_OLD, true).text, TAP_WEBPIN_NEW)
check('already patched -> idempotent no-write', patchTapWebPinText(TAP_WEBPIN_NEW, true).state, 'patched')
check('already patched -> text untouched', patchTapWebPinText(TAP_WEBPIN_NEW, true).text, TAP_WEBPIN_NEW)
check('patched -> restore lands on upstream', patchTapWebPinText(TAP_WEBPIN_NEW, false).text, TAP_WEBPIN_OLD)
check('already upstream -> restore idempotent', patchTapWebPinText(TAP_WEBPIN_OLD, false).state, 'upstream')
check(
  'foreign text -> unknown, untouched',
  patchTapWebPinText('function hostReconcileView() {}\n', true),
  { text: 'function hostReconcileView() {}\n', state: 'unknown' },
)
check(
  'patch survives surrounding code (splice into a wrapper)',
  patchTapWebPinText('before\n' + TAP_WEBPIN_OLD + '\nafter', true).text,
  'before\n' + TAP_WEBPIN_NEW + '\nafter',
)
check('tapIndexPath returns null for a dshHome without profiles', tapIndexPath(join(root, 'test', 'no-such-home')), null)

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
check('hideUnroutableModels acts on a plugin', TWEAKS.find((t) => t.id === 'hideUnroutableModels').subject.kind, 'plugin')
check('fixTapWebPin acts on a file', TWEAKS.find((t) => t.id === 'fixTapWebPin').subject.kind, 'file')
check('sidebarBalance acts on the host account service', TWEAKS.find((t) => t.id === 'sidebarBalance').subject.kind, 'host')
check('sidebarBalance names deepseekAccount', TWEAKS.find((t) => t.id === 'sidebarBalance').subject.name, 'deepseekAccount')

console.log('sidebarBalance（DSH 余额卡片）:')
{
  const t = TWEAKS.find((x) => x.id === 'sidebarBalance')
  ok('已登记并在菜单里出现', t.menu === true)
  ok('why 说明数据源与迁移理由', /deepseekAccount|getBalance/.test(t.why) && /dsh-tap-quota|不同源|迁/.test(t.why))
  ok('why 明确不含企业套餐额度', /R-Q10|cookie/.test(t.why))
  // 归一化：金额是字符串，原样保留；充值与赠金分开；只收 CNY/USD。
  check('未登录 -> signed-out', normalizeBalance(null), { ok: false, error: 'signed-out', wallets: [], bonusWallets: [] })
  check('读取失败 -> read-failed', normalizeBalance({ status: 'failed' }).error, 'read-failed')
  check(
    'ready：只留 CNY/USD，金额原样（不转 Number）',
    normalizeBalance({
      status: 'ready',
      value: [{ currency: 'CNY', balance: '0.2599924800000000' }, { currency: 'JPY', balance: '9' }],
      bonusWallets: [{ currency: 'CNY', balance: '5' }],
    }),
    { ok: true, wallets: [{ currency: 'CNY', balance: '0.2599924800000000' }], bonusWallets: [{ currency: 'CNY', balance: '5' }] },
  )
  check(
    '非字符串余额被丢弃（不猜 0）',
    normalizeBalance({ status: 'ready', value: [{ currency: 'CNY', balance: 12.34 }], bonusWallets: [] }),
    { ok: true, wallets: [], bonusWallets: [] },
  )
  // 服务不在 -> readBalance 返回 null（调用方据此渲染 missing）。
  const absent = await readBalance(null)
  check('服务不在 -> null', absent, null)
  // 服务在但两个方法都缺失：不抛错，如实给出 signed-out + read-failed。
  const bare = await readBalance({})
  check('无 getBalance/getState 时不抛错', bare.balance.ok, false)
  check('无 getState 时 signedIn=false', bare.signedIn, false)
  // 正常路径（假服务）。
  const fake = {
    getState: async () => ({ status: 'credential-stored' }),
    getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [] }),
  }
  const good = await readBalance(fake)
  check('正常读取：登录态 + 余额', [good.signedIn, good.balance.wallets[0].balance], [true, '12.34'])
  // 余额抛错但登录态正常：不该把 signedIn 也拖没。
  const halfBroken = {
    getState: async () => ({ status: 'credential-stored' }),
    getBalance: async () => { throw new Error('boom') },
  }
  const partial = await readBalance(halfBroken)
  check('余额失败不影响登录态', partial.signedIn, true)
  check('余额失败如实标 read-failed', partial.balance.error, 'read-failed')
  // 宿主侧路由与配置。
  ok('balance 路由已注册', hostSource.includes('${ROUTE_PREFIX}/balance'))
  ok('路由受 statusRoute 把关', /statusRoute !== false/.test(hostSource))
  ok('读余额带硬性超时', /readBalance\(service, 6000\)/.test(hostSource))
  // 余额行的 ⟳ 与 dsh-tap-quota 角标同一出现规则：平时不可见，悬停余额行才亮。
  const balanceClient = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  ok('余额行 ⟳ 默认不可见且不可点', /\.dtw-balance-btn\{[^}]*opacity:0/.test(balanceClient) && /\.dtw-balance-btn\{[^}]*pointer-events:none/.test(balanceClient))
  ok('悬停余额行才显示 ⟳', /\.dtw-balance:hover \.dtw-balance-btn/.test(balanceClient))
  ok('⟳ 用占位而非 display:none（悬停不横跳）', /\.dtw-balance-btn\{[^}]*margin-left:auto/.test(balanceClient) && !/\.dtw-balance-btn\{[^}]*display:none/.test(balanceClient))
  // 两处刷新键统一外观：与 dsh-tap-quota 的 .qw-refresh 逐项对齐（尺寸/圆角/字号/各路 opacity）。
  const quotaClient = readFileSync(join(root, '..', 'dsh-tap-quota', 'lib', 'client.js'), 'utf8')
  const btnRule = (balanceClient.match(/\.dtw-balance-btn\{[^}]*\}/) || [''])[0]
  const quotaRule = (quotaClient.match(/\.qw-refresh\{[^}]*\}/) || [''])[0]
  const spec = (rule) => {
    const pick = (prop) => (rule.match(new RegExp(prop.replace('|', '\\|') + ':([^;}]+)')) || [])[1]
    return [pick('width'), pick('height'), pick('border-radius'), pick('font-size'), pick('color'), pick('opacity'), pick('transition')].join('|')
  }
  ok('刷新键与余量角标同一套外观规格', spec(btnRule) === spec(quotaRule) && /width:14px/.test(btnRule))
  ok('悬停/禁用/高亮态一致', /\.dtw-balance-btn:hover\{opacity:1;/.test(balanceClient) && /\[disabled\]\{opacity:\.3/.test(balanceClient) && /:focus-visible\{outline:1px solid/.test(balanceClient))
  ok('共用同一个底色自定义属性名', /REFRESH_BG = "dsh-tap-quota:refresh-bg"/.test(balanceClient) && /BG_KEY = "dsh-tap-quota:refresh-bg"/.test(quotaClient))
  ok('刷新时同样转圈', /\.dtw-balance-btn\.busy>i\{animation:/.test(balanceClient) && /className = busy \? "dtw-balance-btn busy"/.test(balanceClient))
}

console.log('describeSubject (对象状态):')
const entryTweak = TWEAKS.find((t) => t.id === 'hideBuiltinDeepseek')
check('disabled entry -> disabled', describeSubject(entryTweak, { disabled: true }, true, { ok: true }).status, 'disabled')
check('present entry not yet disabled -> pending', describeSubject(entryTweak, { disabled: false }, true, { ok: true }).status, 'pending')
check('absent entry -> missing', describeSubject(entryTweak, undefined, true, { ok: true }).status, 'missing')
check('switch off -> idle', describeSubject(entryTweak, { disabled: true }, false, undefined).status, 'idle')
check('apply error -> mismatch', describeSubject(entryTweak, { disabled: true }, true, { ok: false, error: 'boom' }).status, 'mismatch')
ok('missing carries a human reason', describeSubject(entryTweak, undefined, true, { ok: true }).label.includes('Loader'))
const fileTweak = TWEAKS.find((t) => t.id === 'fixTapWebPin')
check('file kind resolves against this machine', ['ready', 'missing'].includes(describeSubject(fileTweak, undefined, true, { ok: true }).status), true)

console.log('isEnabled:')
check('unknown config -> false', isEnabled({}, 'hideBuiltinDeepseek'), false)
check('missing tweaks -> false', isEnabled({ tweaks: undefined }, 'x'), false)
check('explicit false -> false', isEnabled({ tweaks: { a: { enabled: false } } }, 'a'), false)
check('explicit true -> true', isEnabled({ tweaks: { a: { enabled: true } } }, 'a'), true)
check('truthy non-boolean is not enough', isEnabled({ tweaks: { a: { enabled: 'yes' } } }, 'a'), false)

console.log('describeTweaks:')
const described = describeTweaks({ tweaks: { hideBuiltinDeepseek: { enabled: true } } }, new Map())
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
const clientCtx = {
  console,
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
  'readTweaks includes a tweak that only has an action',
  api.readTweaks({ tweaks: [{ id: 'sidebarBalance', menu: true, enabled: true }] }).rows.length,
  1,
)
check(
  'readTweaks ignores unknown ids',
  api.readTweaks({ tweaks: [{ id: 'nope', target: null, enabled: true }] }).rows.length,
  0,
)
check(
  'readTweaks honors the menu flag for data tweaks',
  api.readTweaks({ tweaks: [{ id: 'hideUnroutableModels', target: null, menu: true, enabled: true }] }).rows.length,
  1,
)
ok(
  'readTweaks reports the hideUnroutable state',
  api.readTweaks({ tweaks: [{ id: 'hideUnroutableModels', menu: true, enabled: true }] }).hideUnroutable === true,
)
ok(
  'readTweaks defaults hideUnroutable to false',
  api.readTweaks({ tweaks: [] }).hideUnroutable === false,
)
ok('hide CSS hides unroutable rows', api.HIDE_UNROUTABLE_CSS.includes('.cbc-listrow.cbc-unroutable{display:none!important}'))
ok('hide CSS collapses an all-dead group title', api.HIDE_UNROUTABLE_CSS.includes('p.cbc-subtitle:not(:has('))
ok('hide CSS is off while the tweak is off', !api.styleText().includes('cbc-unroutable'))
ok('card CSS is always present', api.styleText().includes('.dtw-card'))
ok('page CSS carries the tap quick-filter row', api.styleText().length > 0 && clientSource.includes('dtw-taprow'))

console.log('卡片字段（启用状态/描述/生效对象/对象状态/生效条件）:')
const cardRow = api.readTweaks({
  tweaks: [{
    id: 'hideUnroutableModels',
    menu: true,
    enabled: true,
    title: '剔掉死模型',
    what: '把路由不通的模型摘掉',
    why: '为什么',
    subjectKind: 'plugin',
    subjectLabel: 'dsh-tap（CodeBuddy 网关）',
    subjectStatus: 'ready',
    subjectStatusLabel: '插件在位，它的设置路由可用',
    effect: '调它自己的设置路由',
    appliesWhen: 'dsh-tap 已安装且设置路由已注册',
    note: '已从选择器移除 1 个',
  }],
}).rows[0]
check('carries title', cardRow.title, '剔掉死模型')
check('carries what (描述)', cardRow.what, '把路由不通的模型摘掉')
check('carries subjectKind (生效对象类型)', cardRow.subjectKind, 'plugin')
check('carries subjectLabel (生效对象)', cardRow.subjectLabel, 'dsh-tap（CodeBuddy 网关）')
check('carries subjectStatus (对象状态)', cardRow.subjectStatus, 'ready')
ok('carries subjectStatusLabel', cardRow.subjectStatusLabel.includes('设置路由'))
check('carries appliesWhen (生效条件)', cardRow.appliesWhen, 'dsh-tap 已安装且设置路由已注册')
ok('carries enabled (启用状态)', cardRow.enabled === true)
const bareRow = api.readTweaks({ tweaks: [{ id: 'x', menu: true, enabled: false }] }).rows[0]
check('missing fields degrade safely', [bareRow.what, bareRow.subjectKind, bareRow.subjectLabel], ['', '', ''])
check('unknown subject status degrades safely', bareRow.subjectStatus, 'unknown')

console.log('侧边栏入口（已撤销，记录原因）:')
ok('no longer registers sidebar.footer.action', !clientSource.includes('ctx.slots.inject("sidebar.footer.action"'))
ok('no dead sidebar component or slot id', !clientSource.includes('SidebarRestart') && !clientSource.includes('RESTART_SLOT_ID'))
ok('header records why the sidebar entry was dropped', clientSource.includes('那一行与 dsh-tap-quota 的余额卡片共用'))
ok('header records that the avatar menu has no item slot', clientSource.includes('没有任何菜单项 slot'))
ok('sidebar CSS removed', !clientSource.includes('.dtw-footbtn') && !clientSource.includes('dtw-sr'))

console.log('卡片精简（详情进悬浮，不平铺）:')
ok('tooltip carries the full rationale', clientSource.includes('"依据：" + row.why') && clientSource.includes('"生效条件：" + row.appliesWhen') && clientSource.includes('"生效方式：" + row.effect'))
ok('tooltip carries enabled + subject + status', clientSource.includes('"当前：已启用"') && clientSource.includes('"对象状态：" + row.subjectStatusLabel'))
ok('card body renders only title + what', clientSource.includes('className: "dtw-title"') && clientSource.includes('className: "dtw-what"'))
ok('card meta shows only subject + status chips', clientSource.includes('dtw-meta') && !clientSource.includes('label: "启用："'))
ok('long why is no longer a permanent block', !/className: "dtw-why"/.test(clientSource))
ok('errors still surface as a line', clientSource.includes('dtw-note-error'))

console.log('client static discipline:')
ok('does not observe class', !/attributeFilter:\s*\[\s*["']class["']/.test(clientSource))
ok('narrow attributeFilter only', /attributeFilter:\s*\[\s*"aria-expanded",\s*"aria-label"\s*\]/.test(clientSource))
const onMutationsBody = clientSource.slice(
  clientSource.indexOf('function onMutations'),
  clientSource.indexOf('function armRefresh'),
)
ok('mutation callback inspects no whole document', onMutationsBody.length > 0 && !/document\.querySelectorAll/.test(onMutationsBody))
ok('mutation callback only queues added subtrees', /schedule\(rec\.addedNodes\[j\]\)/.test(onMutationsBody))
ok('uses rAF coalescing', /requestAnimationFrame/.test(clientSource))
ok('per-node idempotency via WeakMap', /new WeakMap\(\)/.test(clientSource))

console.log('client no dead requests / no hardcoded refresh:')
ok('does not POST the unregistered /diag route', !clientSource.includes('/dsh-tweaks/diag'))
ok('does not ship diag counters', !/diag\.(sweeps|inserts|toggles)/.test(clientSource))
ok('refresh interval comes from the host status route', /state\.refreshMs/.test(clientSource) && /config\.statusRefreshMs/.test(clientSource))
ok('no hardcoded 600000 timer', !/setInterval\([^)]*,\s*REFRESH_MS\)/.test(clientSource))
ok('client still declares the slots service', clientSource.includes('inject = ["slots"]'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
