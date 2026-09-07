import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

test('failed audio discovery retries without touching video and retains selected dub on refresh', async () => {
  const app = readFileSync(new URL('../public/p2p/app.js', import.meta.url), 'utf8')
  const source = app.slice(app.indexOf('async function refreshTracks'), app.indexOf("if ($('#audio-refresh'))"))
  const elements = new Map()
  const $ = selector => {
    assert.notEqual(selector, 'video', 'refresh must not touch playback')
    if (!elements.has(selector)) elements.set(selector, { value: '', children: [], replaceChildren () { this.children = [] }, append (c) { this.children.push(c) } })
    return elements.get(selector)
  }
  let attempts = 0, retry
  const file = {}
  const context = vm.createContext({ $, bridge: true, selectedFile: file, torrent: { files: [file], infoHash: 'hash' }, disposed: false, trackScan: 0, audioMedia: null, audioActive: false, trackRetry: null,
    document: { createElement: () => ({}) }, clearTimeout () {}, setTimeout (fn) { retry = fn },
    mediaJson: async () => { if (++attempts === 1) throw new Error('timeout'); return { duration: 100, tracks: [{ index: 0, codec: 'flac' }], externalTracks: [{ fileIndex: 4, title: 'AniDub', external: true }] } },
    renderTimeline () {}, supportsAudio: () => true, applyAudio: () => { throw new Error('Refresh switched the source') }
  })
  const refresh = vm.runInContext(source + '\nrefreshTracks', context)
  await refresh()
  assert.equal($('#audio-panel').hidden, false)
  assert.match($('#audio-mode').textContent, /Повторю/)
  await retry()
  assert.equal($('#audio-track').children.length, 2)
  $('#audio-track').value = 'file:4'
  await refresh()
  assert.equal($('#audio-track').value, 'file:4')
  assert.equal($('#audio-track').disabled, false)
})
