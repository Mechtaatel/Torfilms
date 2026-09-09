import test from 'node:test'
import assert from 'node:assert/strict'
import { createCatalogReader } from '../public/p2p/catalog-reader.js'
import { backendAccess } from '../lib/backend-access.js'

test('Neon catalog reads public view directly, without local account or cookies', async () => {
  const calls = []
  const read = createCatalogReader({ neonDataApiUrl: 'https://example.apirest.neon.tech/db/rest/v1', neonAnonymousTokenUrl: 'https://example.neonauth.neon.tech/db/auth/token/anonymous' }, () => assert.fail('no fallback'), async (url, options) => {
    calls.push({ url: String(url), options })
    return new Response(JSON.stringify(String(url).includes('/token/') ? { token: 'guest-token' } : [{ movie: { id: 'tt6424454' } }]))
  })
  assert.deepEqual(await read(), [{ id: 'tt6424454' }])
  assert.match(calls[1].url, /rest\/v1\/movies\?select=movie/)
  assert.equal(calls[1].options.headers['Accept-Profile'], 'catalog')
  assert.equal(calls[1].options.headers.Authorization, 'Bearer guest-token')
  assert.ok(calls.every(c => c.options.credentials === 'omit'))
})
test('Neon errors do not silently switch to backend and credentials in URL are rejected', async () => {
  for (const url of ['postgresql://user:password@host/db', 'https://user:secret@host/db']) {
    await assert.rejects(createCatalogReader({ neonDataApiUrl: url }, () => assert.fail(), () => assert.fail())())
  }
  await assert.rejects(createCatalogReader({ neonDataApiUrl: 'https://example.com/rest/v1' }, () => assert.fail(), async () => new Response('{"message":"denied"}', { status: 403 }))(), /denied/)
})
test('Viewer backend denies management even without Origin, and still allows streaming', () => {
  const req = { method: 'POST', headers: { host: 'localhost' }, url: '' }
  const res = { writeHead (code) { this.status = code }, end () {} }
  for (const route of ['/catalog/movies', '/admin/users', '/requests/a/review', '/auth/login']) {
    req.url = route; assert.equal(backendAccess(req, res, {}), false); assert.equal(res.status, 403)
  }
  req.url = '/bridge/start'; assert.equal(backendAccess(req, res, {}), true)
  req.url = '/catalog/movies'; req.method = 'GET'; assert.equal(backendAccess(req, res, {}), true)
})
