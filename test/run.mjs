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
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

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
    'const z = new Proxy(function () {}, { get: () => z, apply: () => z })',
  )
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')

const hostCtx = { console, process, Buffer, setTimeout, clearTimeout, join, dirname, homedir, readdirSync, statSync }
vm.createContext(hostCtx)
vm.runInContext(hostSource + '\n;globalThis.__host = { TWEAKS, isEnabled, describeTweaks, checkTarget, findEntry, disableEntry, restoreEntry, unroutableIds, TAP_SETTINGS_ROUTE, setTweakEnabledInText, patchTapWebPinText, tapIndexPath, TAP_WEBPIN_OLD, TAP_WEBPIN_NEW };', hostCtx)
const { TWEAKS, isEnabled, describeTweaks, checkTarget, findEntry, disableEntry, restoreEntry, unroutableIds, TAP_SETTINGS_ROUTE, setTweakEnabledInText, patchTapWebPinText, tapIndexPath, TAP_WEBPIN_OLD, TAP_WEBPIN_NEW } = hostCtx.__host

console.log('TWEAKS registry:')
ok('is a non-empty frozen list', Array.isArray(TWEAKS) && TWEAKS.length > 0 && Object.isFrozen(TWEAKS))
ok('every tweak has id/title/why', TWEAKS.every((t) => t.id && t.title && t.why))
ok(
  'ids are unique',
  new Set(TWEAKS.map((t) => t.id)).size === TWEAKS.length,
)
ok('hideSettingsModels is registered', TWEAKS.some((t) => t.id === 'hideSettingsModels'))
ok('restartButton is registered', TWEAKS.some((t) => t.id === 'restartButton'))
ok('hideBuiltinDeepseek is registered', TWEAKS.some((t) => t.id === 'hideBuiltinDeepseek'))
ok('hideUnroutableModels is registered', TWEAKS.some((t) => t.id === 'hideUnroutableModels'))

console.log('tweaks targets:')
check('hideSettingsModels targets the settings models page', TWEAKS.find((t) => t.id === 'hideSettingsModels').target, 'ui-settings-models')
check('hideBuiltinDeepseek targets the built-in provider', TWEAKS.find((t) => t.id === 'hideBuiltinDeepseek').target, 'llm-deepseek')
check('restartButton declares no target', TWEAKS.find((t) => t.id === 'restartButton').target, undefined)
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

console.log('isEnabled:')
check('unknown config -> false', isEnabled({}, 'hideSettingsModels'), false)
check('missing tweaks -> false', isEnabled({ tweaks: undefined }, 'x'), false)
check('explicit false -> false', isEnabled({ tweaks: { a: { enabled: false } } }, 'a'), false)
check('explicit true -> true', isEnabled({ tweaks: { a: { enabled: true } } }, 'a'), true)
check('truthy non-boolean is not enough', isEnabled({ tweaks: { a: { enabled: 'yes' } } }, 'a'), false)

console.log('describeTweaks:')
const described = describeTweaks({ tweaks: { hideSettingsModels: { enabled: true } } }, new Map())
check('one row per tweak', described.length, TWEAKS.length)
const row = described.find((r) => r.id === 'hideSettingsModels')
ok('reflects enabled flag', row.enabled === true)
ok('reports applied=false when not applied', row.applied === false)
const withError = describeTweaks({}, new Map([['restartButton', { ok: false, error: 'boom' }]]))
ok('surfaces apply error', withError.find((r) => r.id === 'restartButton').error === 'boom')

console.log('checkTarget:')
check('no target -> ok', checkTarget(null, []).ok, true)
check('no target -> present null', checkTarget(null, []).present, null)
check('no tree -> ok (unverifiable is not a failure)', checkTarget('x', null).ok, true)
check('no tree -> present null', checkTarget('x', null).present, null)
check('target found by id', checkTarget('ui-settings-models', [{ id: 'ui-settings-models' }]).present, true)
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
const client = def.factory(function () {
  throw new Error('client must not require modules')
})
const api = client.__internals

console.log('client:')
check('readTweaks with no doc -> no rows', api.readTweaks(null).rows.length, 0)
check(
  'readTweaks lists tweaks that have a target',
  api.readTweaks({ tweaks: [{ id: 'hideBuiltinDeepseek', target: 'llm-deepseek', enabled: true }] }).rows.length,
  1,
)
check(
  'readTweaks skips tweaks without a target',
  api.readTweaks({ tweaks: [{ id: 'restartButton', enabled: true }] }).rows.length,
  0,
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
ok('base CSS is always present', api.styleText().includes('.dtw-item'))

console.log('client static discipline:')
ok('does not observe class', !/attributeFilter:\s*\[\s*["']class["']/.test(clientSource))
ok('narrow attributeFilter only', /attributeFilter:\s*\[\s*"aria-expanded",\s*"aria-label"\s*\]/.test(clientSource))
const onMutationsBody = clientSource.slice(
  clientSource.indexOf('function onMutations'),
  clientSource.indexOf('fetchStatus().then'),
)
ok('mutation callback inspects no whole document', onMutationsBody.length > 0 && !/document\.querySelectorAll/.test(onMutationsBody))
ok('mutation callback collects only added subtrees', /collect\(rec\.addedNodes\[j\]\)/.test(onMutationsBody))
ok('uses rAF coalescing', /requestAnimationFrame/.test(clientSource))
ok('per-node idempotency via WeakMap', /new WeakMap\(\)/.test(clientSource))

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
