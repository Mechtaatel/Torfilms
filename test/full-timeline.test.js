import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

test('timeline uses full metadata duration, not fragment duration, and preserves seek preview', () => {
  const source = readFileSync(new URL('../public/p2p/app.js', import.meta.url), 'utf8')
  const code = source.slice(source.indexOf('const clockText'), source.indexOf('const audioTypes'))
  const nodes = { video: { duration: 5, currentTime: 3 }, '#audio-seek': { value: '0' }, '#audio-time': {} }
  const context = vm.createContext({ $: key => nodes[key], audioMedia: { duration: 1427.114 }, timelineDragging: false, timelineTarget: null, audioActive: true, audioOffset: 600 })
  const render = vm.runInContext(code + '\nrenderTimeline', context)
  render()
  assert.equal(nodes['#audio-seek'].max, '1427.114')
  assert.equal(nodes['#audio-time'].textContent, '10:03 / 23:47')
  context.timelineTarget = 900; render()
  assert.equal(nodes['#audio-seek'].value, '900')
  context.timelineDragging = true; nodes['#audio-seek'].value = '1000'; render()
  assert.equal(nodes['#audio-time'].textContent, '16:40 / 23:47')
})
