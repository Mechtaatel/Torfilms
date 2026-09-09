import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { RetainedRamPool } from '../public/p2p/retained-ram.js'
import { createPlayerStats } from '../public/p2p/player-stats.js'

test('inline player has one video, no embedded page, and keeps engine control IDs', () => {
  const compact = readFileSync(new URL('../public/p2p/compact-player.js', import.meta.url), 'utf8')
  const catalog = readFileSync(new URL('../public/p2p/catalog-app.js', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../public/p2p/app.js', import.meta.url), 'utf8')
  assert.equal((compact.match(/<video\b/g) || []).length, 1)
  assert.match(compact, /<video controls playsinline/)
  assert.doesNotMatch(compact, /Позиция фильма|player-fullscreen|full-timeline/)
  const css = readFileSync(new URL('../public/p2p/compact-player.css', import.meta.url), 'utf8')
  assert.doesNotMatch(css, /::-webkit-media-controls/)
  assert.doesNotMatch(compact + catalog, /<iframe|node\('iframe'\)/)
  assert.match(compact, /<details class="player-settings">/)
  assert.doesNotMatch(compact, /id="audio-apply"/)
  assert.doesNotMatch(catalog, /Качество фильма/)
  assert.match(app, /\$\('#audio-track'\)\.onchange = .*rememberAudio\(\); applyAudio\(\)/)
  assert.doesNotMatch(compact, /Файлы и статистика|id="files"/)
  for (const id of ['join', 'magnet', 'ram', 'upload', 'audio-panel', 'audio-track', 'audio-seek', 'audio-time', 'stats', 'seed', 'stop']) assert.match(compact, new RegExp(`id="${id}"`))
  assert.match(app, /new URL\('\.\/sw.min.js', import.meta.url\)/)
  assert.match(app, /scope: new URL\('\.\/', import.meta.url\).pathname/)
})

test('mounted player scopes DOM access, leaves film heading intact and disposes timers', async () => {
  let source = readFileSync(new URL('../public/p2p/app.js', import.meta.url), 'utf8')
  source = source.replace(/^import .*$/gm, '').replace('export function mountPlayer', 'function mountPlayer').replaceAll('import.meta.url', '"https://localhost/app.js"')
  const intervals = new Set()
  const elements = new Map()
  function element () { return { textContent: '', hidden: false, value: '', children: [], append (child) { this.children.push(child) }, insertBefore (child) { this.children.push(child) }, addEventListener () {}, replaceChildren () { this.children = [] }, pause () { this.paused = true }, load () {}, removeAttribute () {} } }
  const root = { querySelector (s) { if (!elements.has(s)) elements.set(s, element()); return elements.get(s) } }
  root.querySelector('h1').textContent = 'Название фильма'
  const context = vm.createContext({
    RetainedRamPool, createPlayerStats, readRamSetting: () => 500, readProcessing: () => 'browser', publicTrackers: [],
    document: { createElement: element, querySelector () { throw new Error('Global DOM access') } },
    crypto: { getRandomValues: bytes => bytes }, location: { search: '' }, isSecureContext: true,
    fetch: async () => ({ json: async () => ({ enabled: true }) }), URLSearchParams, URL,
    backendFetch: async () => ({ json: async () => ({ enabled: true }) }),
    setInterval: fn => { intervals.add(fn); return fn }, clearInterval: id => intervals.delete(id),
    setTimeout, clearTimeout
  })
  const mount = vm.runInContext(source + '\nmountPlayer', context)
  const controller = mount(root, { compact: true, movie: { id: 'tt0120915', title: 'Fixture', sources: [] } })
  await new Promise(r => setImmediate(r))
  assert.equal(root.querySelector('h1').textContent, 'Название фильма')
  assert.equal(root.querySelector('#quality-slot').children.length, 1)
  assert.equal(intervals.size, 1)
  await controller.destroy()
  assert.equal(intervals.size, 0)
  assert.equal(root.querySelector('video').paused, true)
  // A removed player must not initialize later when its metadata promise resolves.
  const another = mount(root, { compact: true, movie: { id: 'tt0120915', sources: [] } })
  const count = root.querySelector('#quality-slot').children.length
  await another.destroy()
  await new Promise(r => setImmediate(r))
  assert.equal(root.querySelector('#quality-slot').children.length, count)
})
