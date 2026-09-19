import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { accounts } from '../lib/accounts.js'
import { backendAccess } from '../lib/backend-access.js'

test('public site accepts only signed-in proposals, never staff mutations or other users requests', async () => {
  let state = { users: [], sessions: [], requests: [], audit: [] }
  const store = { read: async () => structuredClone(state), change: async fn => { const next = structuredClone(state); const result = fn(next); state = next; return result } }
  const previous = { id: 'tt6424454', revision: 9, sources: [{ id: 'quality', magnet: 'magnet:original', torrentBase64: 'private-bytes', audioLabels: { 'file:1': 'Dub' } }] }
  const auth = accounts(store, { all: async () => [previous], save: () => assert.fail('Public site cannot save catalog') }, { publicOnly: true })
  const server = http.createServer(async (req, res) => {
    if (backendAccess(req, res, {})) await auth.handle(req, res, new URL(req.url, 'http://localhost'))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const call = async (route, token, data) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
    return { status: res.status, body: await res.json() }
  }
  try {
    const proposal = { kind: 'description', draft: { id: previous.id, title: 'Proposal', sources: [{ id: 'quality', label: '1080p', magnet: '' }] } }
    assert.equal((await call('/requests', null, proposal)).status, 401)
    const first = (await call('/auth/register', null, { email: 'one@example.com', password: 'long-password-123', role: 'admin' })).body
    assert.equal(first.user.role, 'user')
    assert.equal((await call('/auth/me', first.token)).status, 200)
    const sent = await call('/requests', first.token, proposal)
    assert.equal(sent.status, 201); assert.equal(sent.body.draft, undefined)
    assert.equal(state.requests[0].draft.revision, 9)
    assert.equal(state.requests[0].draft.sources[0].torrentBase64, 'private-bytes')
    const second = (await call('/auth/register', null, { email: 'two@example.com', password: 'long-password-456' })).body
    state.users[1].role = 'admin'
    assert.deepEqual((await call('/requests', second.token)).body, [])
    for (const route of ['/catalog/movies', '/admin/users', `/requests/${sent.body.id}/review`]) assert.equal((await call(route, second.token, { action: 'approve' })).status, 403)
    const list = (await call('/requests', first.token)).body
    assert.equal(list.length, 1); assert.equal(list[0].draft.sources, undefined)
    await call('/auth/logout', first.token, {})
    assert.equal((await call('/requests', first.token, proposal)).status, 401)
  } finally { server.close(); server.closeAllConnections() }
})
