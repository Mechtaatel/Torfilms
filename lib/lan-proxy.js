import http from 'node:http'
import https from 'node:https'
import { backendAccess, allowedOrigin } from './backend-access.js'

export function createLanProxy (upstreamPort, { tls, websocket = false } = {}) {
  const headers = req => ({ ...req.headers, host: `127.0.0.1:${upstreamPort}`, ...(req.headers.origin ? { origin: `http://127.0.0.1:${upstreamPort}` } : {}) })
  const handler = (req, res) => {
    const fail = (code, error) => {
      if (res.headersSent) return res.destroy()
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error }))
    }
    if (!req.url.startsWith('/') || req.url.startsWith('//')) return fail(400, 'Invalid path')
    // No remote launches of native applications on the host computer.
    if (req.url.startsWith('/api/player/')) return fail(403, 'VLC запускается только с компьютера-сервера. Используйте браузер.')
    if (!backendAccess(req, res)) return
    const upstream = http.request({
      hostname: '127.0.0.1', port: upstreamPort, path: req.url,
      method: req.method, headers: { ...headers(req), connection: 'close' }
    }, response => {
      res.writeHead(response.statusCode, { ...response.headers, ...(req.headers.origin ? { 'access-control-allow-origin': req.headers.origin, vary: 'Origin' } : {}) })
      response.on('error', () => res.destroy())
      response.pipe(res)
    })
    upstream.on('error', () => fail(502, 'Запустите Torfilms на компьютере-сервере.'))
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  }
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler)
  server.on('upgrade', (req, socket, head) => {
    if (!websocket || !/^\/tracker(?:\/[a-f0-9]{40})?$/.test(req.url) || !allowedOrigin(req)) return socket.destroy()
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, headers: headers(req) })
    let remote
    const close = () => { upstream.destroy(); remote?.destroy() }
    socket.on('error', close); socket.on('close', close)
    upstream.on('error', () => socket.destroy())
    upstream.on('response', () => socket.destroy())
    upstream.on('upgrade', (response, peer, peerHead) => {
      remote = peer
      peer.on('error', () => socket.destroy())
      peer.on('close', () => socket.destroy())
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
      if (head.length) peer.write(head)
      if (peerHead.length) socket.write(peerHead)
      socket.pipe(peer).pipe(socket)
    })
    upstream.end()
  })
  return server
}
