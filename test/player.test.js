import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
function player () {
  const elements = new Map()
  const timers = new Map()
  let next = 0
  const document = {
    hidden: false,
    querySelector (selector) {
      if (!elements.has(selector)) elements.set(selector, {
        value: '1024', min: '128', max: '16384', style: {}, dataset: {},
        classList: { remove () {}, add () {}, toggle () {} },
        addEventListener () {}, querySelectorAll: () => [],
        currentTime: 0, paused: true, readyState: 4, volume: 1,
        buffered: { length: 1, start: () => 0, end: () => 0.2 },
        playCalls: 0, play () { this.playCalls++; return Promise.resolve() }
      })
      return elements.get(selector)
    },
    addEventListener () {}
  }
  const context = vm.createContext({
    document, window: { addEventListener () {} }, console,
    fetch: () => new Promise(() => {}),
    setInterval: () => 0,
    setTimeout: fn => { const id = ++next; timers.set(id, () => { timers.delete(id); fn() }); return id },
    clearTimeout: id => timers.delete(id)
  })
  vm.runInContext(source, context)
  return { context, elements, timers, run: code => vm.runInContext(code, context) }
}

test('HAVE_ENOUGH_DATA does not bypass the actual three-second buffer', () => {
  const p = player()
  p.run('playWhenReady(playbackRequest)')
  const video = p.elements.get('#video')
  assert.equal(video.playCalls, 0)
  video.buffered.end = () => 4
  for (const fn of [...p.timers.values()]) fn()
  assert.equal(video.playCalls, 1)
})

test('old seek callback cannot start a newer source', () => {
  const p = player()
  p.run('playWhenReady(playbackRequest)')
  p.run('playbackRequest++')
  p.elements.get('#video').buffered.end = () => 10
  for (const fn of [...p.timers.values()]) fn()
  assert.equal(p.elements.get('#video').playCalls, 0)
})

test('buffer readout does not count a disconnected future interval', () => {
  const p = player()
  const video = p.elements.get('#video')
  video.currentTime = 5
  video.buffered = { length: 1, start: () => 100, end: () => 110 }
  assert.equal(p.run('bufferedAheadSeconds()'), 0)
})

test('manual playback cancels pending automatic start', () => {
  const p = player()
  p.run('playWhenReady(playbackRequest)')
  assert.equal(p.timers.size, 1)
  p.run('cancelBufferWait()')
  assert.equal(p.timers.size, 0)
})

test('seek skips the shared keyframe preroll before starting playback', () => {
  const p = player()
  const video = p.elements.get('#video')
  p.run('playWhenReady(playbackRequest, 2.5)')
  assert.equal(video.playCalls, 0)
  video.buffered.end = () => 4
  for (const fn of [...p.timers.values()]) fn()
  assert.equal(video.currentTime, 2.5)
  assert.equal(video.playCalls, 0, 'buffer must be measured after the target, not before it')
  video.buffered.end = () => 6
  for (const fn of [...p.timers.values()]) fn()
  assert.equal(video.playCalls, 1)
})

test('pending seek holds the requested timeline while old media time changes', () => {
  const p = player()
  p.run('pendingSeek = { target: 3472.3, resume: true }; updateMediaControls()')
  p.elements.get('#video').currentTime = 0.042
  p.run('updateMediaControls()')
  assert.equal(Number(p.elements.get('#timeline').value), 3472.3)
})

test('dragging keeps both the slider and preview label stable', () => {
  const p = player()
  p.elements.get('#timeline').value = '500'
  p.elements.get('#time-current').textContent = '08:20'
  p.run('timelineDragging = true; updateMediaControls()')
  assert.equal(p.elements.get('#timeline').value, '500')
  assert.equal(p.elements.get('#time-current').textContent, '08:20')
})

test('paused seek displays the requested frame without starting playback', () => {
  const p = player()
  const video = p.elements.get('#video')
  video.readyState = 2
  video.buffered.end = () => 1
  p.run('pendingSeek = { target: 500, resume: false }; playWhenReady(playbackRequest, 0.5)')
  assert.equal(video.currentTime, 0.5)
  assert.equal(video.playCalls, 0)
  assert.equal(p.run('pendingSeek'), null)
})

test('short paused fragment cannot deadlock autoplay forever', () => {
  const p = player()
  const video = p.elements.get('#video')
  video.buffered.end = () => 2.282667
  p.run('pendingSeek = { target: 3472.3, resume: true }; playWhenReady(playbackRequest, 0.64)')
  for (let i = 0; i < 12; i++) for (const fn of [...p.timers.values()]) fn()
  assert.equal(video.playCalls, 1)
})

test('Play during seek changes user intent instead of being blocked', () => {
  const p = player()
  p.run('pendingSeek = { target: 500, resume: false }; togglePlayback()')
  assert.equal(p.run('pendingSeek.resume'), true)
  p.run('togglePlayback()')
  assert.equal(p.run('pendingSeek.resume'), false)
})
