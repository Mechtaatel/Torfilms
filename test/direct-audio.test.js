import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

test('external dub follows native video pause, seek, stalls and volume without replacing video source', async () => {
  class Media extends EventTarget {
    constructor () { super(); Object.assign(this, { paused: false, currentTime: 15, readyState: 4, volume: 0.4, muted: false, playbackRate: 1, src: 'original.mkv', buffered: { length: 1, start: () => 0, end: () => 100 } }) }
    pause () { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')) } }
    play () { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve() }
    removeAttribute () {}
    load () {}
  }
  const video = new Media(), audio = new Media(), starts = [], gain = { gain: { value: 1 }, connect () {} }
  let tick, disposed = 0, now = 0
  const context = vm.createContext({
    document: { createElement: () => audio },
    AudioContext: class { createMediaElementSource () { return { connect () {} } } createGain () { return gain } resume () { return Promise.resolve() } },
    setInterval: fn => { tick = fn; return 1 }, clearInterval () {},
    Date: { now: () => now },
    startLocalRemux: (_, options) => { starts.push(options); return { destroy () { disposed++ } } }
  })
  const source = readFileSync(new URL('../public/p2p/direct-audio.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace('export function', 'function')
  const start = vm.runInContext(source + '\nstartDirectAudio', context)
  const controller = start(video, { onError: assert.fail })
  assert.equal(video.paused, true, 'hold picture while dub loads')
  assert.equal(gain.gain.value, 0)
  starts[0].onReady()
  assert.equal(video.paused, false)
  assert.equal(audio.paused, false)
  assert.equal(audio.volume, 0.4)
  await new Promise(resolve => setImmediate(resolve))
  video.pause(); tick(); assert.equal(audio.paused, true)
  video.currentTime = 70
  video.dispatchEvent(new Event('seeking')); video.dispatchEvent(new Event('seeked'))
  assert.equal(starts[1].position, 70)
  starts[1].onReady()
  assert.equal(video.paused, true, 'paused seek must stay paused')
  assert.equal(audio.currentTime, 70)
  video.play()
  await new Promise(resolve => setImmediate(resolve))
  audio.buffered.end = () => video.currentTime
  audio.readyState = 2; audio.dispatchEvent(new Event('waiting'))
  assert.equal(video.paused, false, 'brief waiting must not pause native video')
  now += 401; tick()
  assert.equal(video.paused, true, 'audio starvation holds picture')
  audio.buffered.end = () => video.currentTime + 0.2
  audio.dispatchEvent(new Event('canplay'))
  assert.equal(video.paused, true, 'wait for a useful refill, not one packet')
  audio.buffered.end = () => 100
  audio.readyState = 4; audio.dispatchEvent(new Event('canplay'))
  assert.equal(video.paused, false)
  controller.destroy()
  assert.equal(gain.gain.value, 1)
  assert.equal(disposed, 2)
  assert.equal(video.src, 'original.mkv')
})

test('Android readiness flapping and small clock drift do not cause repeated pauses or seeks', async () => {
  let seeks = 0, pauses = 0, now = 0, tick, config
  class Media extends EventTarget {
    constructor () { super(); Object.assign(this, { paused: false, readyState: 4, volume: 1, muted: false, playbackRate: 1, time: 10, buffered: { length: 1, start: () => 0, end: () => 100 } }) }
    get currentTime () { return this.time }
    set currentTime (time) { seeks++; this.time = time }
    pause () { if (!this.paused) { pauses++; this.paused = true; this.dispatchEvent(new Event('pause')) } }
    play () { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve() }
    load () {} removeAttribute () {}
  }
  const video = new Media(), audio = new Media()
  const context = vm.createContext({ Date: { now: () => now }, document: { createElement: () => audio },
    AudioContext: class { createMediaElementSource () { return { connect () {} } } createGain () { return { gain: { value: 1 }, connect () {} } } resume () { return Promise.resolve() } },
    setInterval: fn => { tick = fn }, clearInterval () {}, startLocalRemux: (_, options) => { config = options; return { destroy () {} } }
  })
  const source = readFileSync(new URL('../public/p2p/direct-audio.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace('export function', 'function')
  const controller = vm.runInContext(source + '\nstartDirectAudio', context)(video, { onError: assert.fail })
  config.onReady(); await new Promise(resolve => setImmediate(resolve))
  pauses = 0; seeks = 0
  for (let i = 0; i < 60; i++) {
    now += 200; video.time += 0.2; audio.time = video.time + 0.16
    audio.readyState = video.readyState = i % 2 ? 3 : 2
    audio.dispatchEvent(new Event(i % 2 ? 'canplay' : 'waiting'))
    tick()
    assert.equal(video.paused, false)
  }
  assert.equal(pauses, 0, 'no pause/play loop with buffered media')
  assert.equal(seeks, 0, 'minor drift must not trigger repeated seeks')
  assert.ok(audio.playbackRate < video.playbackRate)
  controller.destroy()
})
