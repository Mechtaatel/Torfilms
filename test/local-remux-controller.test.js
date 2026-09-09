import test from 'node:test'
import assert from 'node:assert/strict'
import { startLocalRemux } from '../public/p2p/local-remux.js'

test('local MSE controller respects paused seeks, stops reads and finalizes without writing duration after EOS', async () => {
  const old = { Worker: globalThis.Worker, MediaSource: globalThis.MediaSource, create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  let worker, media, returned = 0, plays = 0, errors = [], seek
  const ranges = { length: 0, start: () => 0, end: () => 40 }
  class Buffer extends EventTarget {
    buffered = ranges
    appendBuffer () { ranges.length = 1; queueMicrotask(() => this.dispatchEvent(new Event('updateend'))) }
  }
  class Media extends EventTarget {
    readyState = 'closed'
    static isTypeSupported () { return true }
    constructor () { super(); media = this; queueMicrotask(() => { this.readyState = 'open'; this.dispatchEvent(new Event('sourceopen')) }) }
    set duration (n) { if (this.readyState !== 'open') throw new Error('duration after EOS'); this.time = n }
    get duration () { return this.time }
    addSourceBuffer () { return new Buffer() }
    endOfStream () { this.readyState = 'ended' }
  }
  class FakeWorker {
    constructor () { worker = this }
    postMessage () {}
    terminate () { this.terminated = true }
    async send (message) { await this.onmessage({ data: { id: 1, ...message } }) }
  }
  const video = Object.assign(new EventTarget(), { currentTime: 0, buffered: ranges, pause () {}, load () {}, play () { plays++; return Promise.resolve() } })
  const file = { length: 4, [Symbol.asyncIterator] () { return { next: () => new Promise(() => {}), return: async () => { returned++; return { done: true } }, [Symbol.asyncIterator] () { return this } } } }
  try {
    globalThis.Worker = FakeWorker; globalThis.MediaSource = Media; URL.createObjectURL = () => 'blob:fixture'; URL.revokeObjectURL = () => {}
    const controller = startLocalRemux(video, { torrent: { files: [file] }, fileIndex: 0, duration: 40, position: 23, resume: true, onMetadata () {}, onSeek: t => { seek = t }, onReady () {}, onError: e => errors.push(e) })
    await worker.send({ type: 'configure', mime: 'video/mp4', position: 23 })
    video.dispatchEvent(new Event('pause'))
    await worker.send({ type: 'append', bytes: new Uint8Array([0]) })
    assert.equal(plays, 0, 'pause while buffering must not be overridden')
    video.currentTime = 99; video.dispatchEvent(new Event('seeking')); assert.equal(seek, 99)
    await worker.send({ type: 'end' }); assert.equal(media.readyState, 'ended'); assert.deepEqual(errors, [])
    void worker.send({ type: 'read', fileIndex: 0, start: 0, end: 4 })
    controller.destroy(); await new Promise(r => setImmediate(r))
    assert.equal(worker.terminated, true); assert.equal(returned, 1)
  } finally { globalThis.Worker = old.Worker; globalThis.MediaSource = old.MediaSource; URL.createObjectURL = old.create; URL.revokeObjectURL = old.revoke }
})
