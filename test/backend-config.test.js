import test from 'node:test'
import assert from 'node:assert/strict'
import config from '../public/p2p/runtime-config.js'
import { backendUrl, trackerUrl, filmUrl, filmId } from '../public/p2p/backend.js'
import { backendAccess, allowedOrigin } from '../lib/backend-access.js'
test('backend origin resolves APIs and secure trackers without affecting local defaults', () => {
  try {
    assert.equal(backendUrl('/catalog/movies'), '/catalog/movies')
    config.backendUrl = 'https://example.onrender.com'
    assert.equal(backendUrl('/bridge/piece/hash/0'), 'https://example.onrender.com/bridge/piece/hash/0')
    assert.equal(trackerUrl('/tracker/hash'), 'wss://example.onrender.com/tracker/hash')
    assert.throws(() => backendUrl('//evil.example'))
    config.staticRouting = true
    assert.match(filmUrl('tt2359704', 'Bonus'), /\/tt2359704$/)
    assert.equal(filmId('/Torfilms/tt6424454', '', '/Torfilms/'), 'tt6424454')
    assert.equal(filmId('/Torfilms/tt6424454/', '', '/Torfilms/'), 'tt6424454')
    assert.equal(filmId('/Torfilms/', '?film=tt6424454&season=0', '/Torfilms/'), 'tt6424454')
    assert.equal(filmId('/film/tt6424454', '', '/'), 'tt6424454')
    assert.equal(filmId('/other/tt6424454', '', '/Torfilms/'), null)
  } finally { config.backendUrl = ''; config.staticRouting = false }
})
test('CORS allows exact frontend origin, range preflight and protects public catalog', () => {
  const env = { TORFILMS_ALLOWED_ORIGINS: 'https://viewer.github.io', TORFILMS_CATALOG_READONLY: '1' }
  const req = { headers: { host: 'service.onrender.com', origin: 'https://viewer.github.io' }, method: 'OPTIONS', url: '/bridge/piece/hash/0' }
  const headers = {}; const res = { setHeader: (k, v) => { headers[k] = v }, writeHead: code => { res.status = code }, end () {} }
  assert.equal(backendAccess(req, res, env), false)
  assert.equal(res.status, 204)
  assert.equal(headers['Access-Control-Allow-Origin'], req.headers.origin)
  assert.match(headers['Access-Control-Allow-Headers'], /Range/)
  req.method = 'POST'; req.url = '/catalog/movies'
  assert.equal(backendAccess(req, res, env), false); assert.equal(res.status, 403)
  req.url = '/x/../catalog/movies'; assert.equal(backendAccess(req, res, env), false)
  req.url = '/bridge/start'; assert.equal(backendAccess(req, res, env), true)
  req.headers.origin = 'https://viewer.github.io.evil.example'
  assert.equal(allowedOrigin(req, env), false)
})
