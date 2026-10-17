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

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
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

const hostCtx = { console, process, Buffer, setTimeout, clearTimeout }
vm.createContext(hostCtx)
vm.runInContext(hostSource + '\n;globalThis.__host = { TWEAKS, isEnabled, describeTweaks, checkTarget };', hostCtx)
const { TWEAKS, isEnabled, describeTweaks, checkTarget } = hostCtx.__host

console.log('TWEAKS registry:')
ok('is a non-empty frozen list', Array.isArray(TWEAKS) && TWEAKS.length > 0 && Object.isFrozen(TWEAKS))
ok('every tweak has id/title/why', TWEAKS.every((t) => t.id && t.title && t.why))
ok(
  'ids are unique',
  new Set(TWEAKS.map((t) => t.id)).size === TWEAKS.length,
)
ok('hideSettingsModels is registered', TWEAKS.some((t) => t.id === 'hideSettingsModels'))
ok('restartButton is registered', TWEAKS.some((t) => t.id === 'restartButton'))

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
check('readTweaks with no doc -> restart off', api.readTweaks(null).restart, false)
check(
  'readTweaks honours restartButton',
  api.readTweaks({ tweaks: [{ id: 'restartButton', enabled: true }] }).restart,
  true,
)
check(
  'readTweaks ignores restartButton:false',
  api.readTweaks({ tweaks: [{ id: 'restartButton', enabled: false }] }).restart,
  false,
)
check(
  'readTweaks ignores unknown ids',
  api.readTweaks({ tweaks: [{ id: 'nope', enabled: true }] }).restart,
  false,
)

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
