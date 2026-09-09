import test from 'node:test'
import assert from 'node:assert/strict'
import { streamMediaSource } from '../public/p2p/media-source-player.js'

test('native MediaSource uses full duration and requests unbuffered seeks', async () => {
  const old = { MediaSource: globalThis.MediaSource, fetch: globalThis.fetch, create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  let media, seek, stopped = false
  const ranges = { length: 1, start: () => 0, end: () => 10 }
  class Buffer extends EventTarget {
    buffered = ranges
    appendBuffer () { queueMicrotask(() => this.dispatchEvent(new Event('updateend'))) }
  }
  class Source extends EventTarget {
    readyState = 'open'
    static isTypeSupported (mime) { return mime.includes('avc1') && mime.includes('mp4a') }
    constructor () { super(); media = this; queueMicrotask(() => this.dispatchEvent(new Event('sourceopen'))) }
    addSourceBuffer () { return new Buffer() }
  }
  const video = Object.assign(new EventTarget(), { buffered: ranges, currentTime: 0, load () {} })
  try {
    globalThis.MediaSource = Source; URL.createObjectURL = () => 'blob:fixture'; URL.revokeObjectURL = () => {}
    globalThis.fetch = async (url, { signal }) => { signal.addEventListener('abort', () => { stopped = true }); let first = true; return { ok: true, body: { getReader: () => ({ read: () => first ? (first = false, Promise.resolve({ value: new Uint8Array([1]), done: false })) : new Promise(() => {}) }) } } }
    const controller = streamMediaSource(video, { url: '/fixture', duration: 1427, origin: 0, position: 0, onSeek: time => { seek = time }, onError: error => { throw error } })
    await new Promise(r => setImmediate(r))
    assert.equal(media.duration, 1427)
    assert.equal(controller.receivedBytes, 1)
    video.currentTime = 5; video.dispatchEvent(new Event('seeking')); assert.equal(seek, undefined)
    video.currentTime = 900; video.dispatchEvent(new Event('seeking')); assert.equal(seek, 900)
    controller.destroy(); assert.equal(stopped, true)
  } finally { globalThis.MediaSource = old.MediaSource; globalThis.fetch = old.fetch; URL.createObjectURL = old.create; URL.revokeObjectURL = old.revoke }
})
