import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createLanProxy } from '../lib/lan-proxy.js'

test('LAN forwards streaming ranges and rejects remote native launch / cross-origin writes', async () => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.range, 'bytes=2-4')
    res.writeHead(206, { 'Content-Range': 'bytes 2-4/6' })
    res.end('cde')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const proxy = createLanProxy(upstream.address().port)
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const base = `http://127.0.0.1:${proxy.address().port}`
  try {
    const result = await fetch(base + '/stream/x/0', { headers: { Range: 'bytes=2-4' } })
    assert.equal(result.status, 206)
    assert.equal(result.headers.get('content-range'), 'bytes 2-4/6')
    assert.equal(await result.text(), 'cde')
    assert.equal((await fetch(base + '/api/player/x/0', { method: 'POST' })).status, 403)
    assert.equal((await fetch(base + '/api/settings', { method: 'POST', headers: { Origin: 'http://evil.example' } })).status, 403)
  } finally {
    proxy.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => upstream.close(r))])
  }
})
