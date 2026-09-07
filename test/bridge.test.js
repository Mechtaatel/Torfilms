import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import WebTorrent from 'webtorrent'
import MemoryStore from 'memory-chunk-store'

test('TCP/uTP source -> RAM hybrid bridge -> WebRTC-only receiver', { timeout: 45000, skip: process.env.TORFILMS_TEST_WEBRTC !== '1' }, async () => {
  const child = spawn(process.execPath, ['bridge-worker.js'], { cwd: new URL('../', import.meta.url), env: { ...process.env, TORFILMS_BRIDGE_NATIVE_RTC: '1', TORFILMS_BRIDGE_HOST: '127.0.0.1', TORFILMS_BRIDGE_PORT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const source = new WebTorrent({ tracker: false, dht: false, lsd: false, natTraversal: false })
  const receiver = new WebTorrent({ dht: false, lsd: false, natTraversal: false })
  receiver.on('error', e => console.log('receiver error', e.message))
  const abort = AbortSignal.timeout(35000)
  let logs = ''
  child.stderr.on('data', b => { logs += b })
  try {
    const base = await new Promise((resolve, reject) => {
      abort.addEventListener('abort', () => reject(new Error('Bridge test timeout ' + logs)), { once: true })
      child.stdout.on('data', b => { logs += b; const match = logs.match(/http:\/\/127.0.0.1:\d+/); if (match) resolve(match[0]) })
      child.on('error', reject)
    })
    const payload = Buffer.alloc(65536, 87)
    console.log('bridge ready', base)
    payload.name = 'bridge-fixture.bin'
    const seed = await new Promise(resolve => source.seed(payload, { store: MemoryStore, announce: [] }, resolve))
    console.log('TCP seed ready')
    const post = (route, data) => fetch(base + '/bridge/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: abort })
    const magnet = `magnet:?xt=urn:btih:${seed.infoHash}&x.pe=127.0.0.1:${source.address().port}`
    assert.equal((await post('start', { magnet })).status, 200)
    let state
    do {
      await new Promise(r => setTimeout(r, 100))
      state = await (await fetch(base + '/bridge/state', { signal: abort })).json()
    } while (!state.ready)
    console.log('bridge metadata ready', state)
    assert.equal((await post('demand', { infoHash: seed.infoHash, first: 0, last: 0, viewer: 'test' })).status, 200)
    const received = receiver.add(`magnet:?xt=urn:btih:${seed.infoHash}`, { announce: [base.replace('http:', 'ws:') + '/tracker'], store: MemoryStore })
    const types = []
    received.on('warning', e => console.log('receiver warning', e.message))
    received.on('wire', wire => types.push(wire.type))
    await once(received, 'ready', { signal: abort })
    console.log('WebRTC metadata ready', types)
    // Ask the bridge for every fixture piece, without providing video over HTTP.
    await post('demand', { infoHash: seed.infoHash, first: 0, last: received.pieces.length - 1, viewer: 'test' })
    const result = await Promise.race([received.files[0].arrayBuffer(), new Promise((resolve, reject) => abort.addEventListener('abort', () => reject(new Error('WebRTC transfer timed out ' + logs)), { once: true }))])
    assert.deepEqual(Buffer.from(result), Buffer.from(payload))
    assert.ok(types.includes('webrtc'), `Expected WebRTC, got ${types}`)
    state = await (await fetch(base + '/bridge/state', { signal: abort })).json()
    assert.ok(state.ramBytes <= state.limit)
    assert.ok(state.uploaded >= payload.length)
  } finally {
    child.kill()
    await Promise.race([Promise.all([new Promise(r => source.destroy(r)), new Promise(r => receiver.destroy(r))]), new Promise(r => setTimeout(r, 1000))])
    const { default: native } = await import('node-datachannel')
    native.cleanup()
  }
})
