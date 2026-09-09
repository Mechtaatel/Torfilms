import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { createLanProxy } from '../lib/lan-proxy.js'

test('pool concurrently transfers two torrents, routes trackers, reuses workers and enforces RAM slots', { timeout: 40000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'torfilms-pool-test-'))
  const child = fork(new URL('../bridge.js', import.meta.url), [], { env: { ...process.env, TORFILMS_ALLOWED_ORIGINS: 'https://viewer.github.io', TORFILMS_BRIDGE_PORT: '0', TORFILMS_BRIDGE_WORKERS: '2', TORFILMS_BRIDGE_RAM_MB: '32', TORFILMS_CATALOG_DIR: directory, TORFILMS_BRIDGE_DHT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const seed = fork(new URL('../test-support/seed-worker.js', import.meta.url), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const seedReady = once(seed, 'message', { signal: AbortSignal.timeout(10000) })
  child.stdout.resume(); child.stderr.on('data', b => process.stderr.write(b))
  let proxy
  try {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(10000) })
    const base = `http://127.0.0.1:${message.port}`
    const json = async route => (await fetch(base + route, { signal: AbortSignal.timeout(5000) })).json()
    const post = (route, data) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(15000) })
    const payloads = [Buffer.alloc(256 * 1024, 19), Buffer.alloc(256 * 1024, 87)]
    const [fixture] = await seedReady
    const torrents = fixture.torrents
    const magnets = torrents.map(t => `magnet:?xt=urn:btih:${t.infoHash}&x.pe=127.0.0.1:${fixture.port}`)
    const responses = await Promise.all([...magnets, magnets[0]].map(magnet => post('/bridge/start', { magnet })))
    assert.deepEqual(responses.map(r => r.status), [200, 200, 200])
    const started = await Promise.all(responses.slice(0, 2).map(r => r.json()))
    await responses[2].json()
    assert.notEqual(started[0].tracker, started[1].tracker)
    let state
    const deadline = Date.now() + 12000
    do { state = await json('/bridge/state'); if (state.workers.every(w => w.ready)) break; await new Promise(r => setTimeout(r, 100)) } while (Date.now() < deadline)
    assert.equal(state.workers.length, 2)
    assert.ok(state.workers.every(w => w.ready), JSON.stringify(state))
    const metadata = await json(`/bridge/metadata/${torrents[0].infoHash}`)
    assert.equal(metadata.ready, true)
    const { default: parseTorrent } = await import('parse-torrent')
    assert.equal((await parseTorrent(Buffer.from(metadata.torrentBase64, 'base64'))).infoHash, torrents[0].infoHash)
    const parsed = await parseTorrent(Buffer.from(metadata.torrentBase64, 'base64'))
    const piece = await fetch(`${base}/bridge/piece/${torrents[0].infoHash}/0`, { headers: { Origin: 'https://viewer.github.io' } })
    assert.equal(piece.status, 200)
    assert.equal(piece.headers.get('access-control-allow-origin'), 'https://viewer.github.io')
    assert.equal(piece.headers.get('cache-control'), 'no-store')
    assert.deepEqual(Buffer.from(await piece.arrayBuffer()), payloads[0].subarray(0, parsed.pieceLength))
    const pids = state.workers.map(w => w.pid).sort()
    const ranged = await fetch(`${base}/bridge/raw/${torrents[0].infoHash}/0`, { headers: { Origin: 'https://viewer.github.io', Range: 'bytes=10-19' } })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers.get('access-control-allow-origin'), 'https://viewer.github.io')
    assert.equal((await ranged.arrayBuffer()).byteLength, 10)
    const remoteWs = new WebSocket(base.replace('http:', 'ws:') + started[0].tracker, { origin: 'https://viewer.github.io' })
    try { await once(remoteWs, 'open', { signal: AbortSignal.timeout(4000) }) } finally { remoteWs.terminate() }
    assert.notEqual(pids[0], pids[1])
    assert.equal(state.totalCacheLimitMb, 64)
    const received = await Promise.all(torrents.map(t => fetch(`${base}/bridge/raw/${t.infoHash}/0`, { signal: AbortSignal.timeout(12000) }).then(r => r.arrayBuffer())))
    received.forEach((data, i) => assert.deepEqual(Buffer.from(data), Buffer.from(payloads[i])))
    assert.equal((await post('/bridge/start', { magnet: magnets[0] })).status, 200)
    assert.deepEqual((await json('/bridge/state')).workers.map(w => w.pid).sort(), pids)
    const overflow = await post('/bridge/start', { magnet: 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789' })
    assert.equal(overflow.status, 400)
    assert.match((await overflow.json()).error, /Лимит 2/)
    assert.equal((await json('/bridge/config')).maxWorkers, 2)
    proxy = createLanProxy(message.port, { websocket: true }); proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
    await Promise.all(started.map(async s => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.address().port}${s.tracker}`)
      try { await once(ws, 'open', { signal: AbortSignal.timeout(4000) }); assert.equal(ws.readyState, WebSocket.OPEN) } finally { ws.terminate() }
    }))
    const card = await post('/catalog/movies', { id: 'tt1727587', title: 'Fixture', sources: [{ label: 'Original', torrentBase64: torrents[0].torrentBase64 }] })
    assert.equal(card.status, 200)
    const movie = await card.json()
    assert.equal((await post('/bridge/start', { movie: movie.id, quality: movie.sources[0].id })).status, 200)
    const list = await json('/catalog/movies')
    assert.equal(list[0].sources[0].hasTorrent, true)
    assert.equal(list[0].sources[0].torrentBase64, undefined)
    const edit = await post('/catalog/movies', { ...list[0], title: 'Still has torrent' })
    assert.equal(edit.status, 200)
    assert.equal((await edit.json()).sources[0].torrentBase64, movie.sources[0].torrentBase64)
    for (const route of ['/', '/film/tt1727587', '/catalog-app.js', '/catalog.css', '/player.html']) assert.equal((await fetch(base + route)).status, 200)
    const victim = (await json('/bridge/state')).workers.find(w => w.infoHash === torrents[0].infoHash)
    process.kill(victim.pid)
    const crashDeadline = Date.now() + 4000
    while ((await json('/bridge/state')).workers.length !== 1 && Date.now() < crashDeadline) await new Promise(r => setTimeout(r, 50))
    const remaining = (await json('/bridge/state')).workers
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].infoHash, torrents[1].infoHash)
    const intact = await fetch(`${base}/bridge/raw/${torrents[1].infoHash}/0`).then(r => r.arrayBuffer())
    assert.deepEqual(Buffer.from(intact), Buffer.from(payloads[1]))
    assert.equal((await post('/bridge/start', { magnet: magnets[0] })).status, 200)
  } finally {
    proxy?.close()
    proxy?.closeAllConnections()
    const exited = once(child, 'exit')
    child.send({ type: 'shutdown' })
    await exited
    child.stdout.destroy(); child.stderr.destroy()
    const seedExited = once(seed, 'exit'); seed.send({ type: 'shutdown' }); await seedExited
    await rm(directory, { recursive: true, force: true })
  }
})
