import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { accounts } from '../lib/accounts.js'

test('registration cannot grant roles; review, session revocation and last-admin checks are server enforced', async () => {
  let state = { users: [], sessions: [], requests: [], audit: [] }, saves = 0, conflict = false
  const store = { read: async () => structuredClone(state), change: async fn => { const next = structuredClone(state); const result = fn(next); state = next; return result } }
  const auth = accounts(store, { all: async () => [], save: async () => { if (conflict) throw new Error('revision conflict'); saves++ } })
  const server = http.createServer(async (req, res) => { if (!(await auth.handle(req, res, new URL(req.url, 'http://localhost')))) res.end() })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const call = async (route, token, data) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
    return { status: response.status, body: await response.json() }
  }
  try {
    const first = (await call('/auth/register', null, { email: 'user@example.com', password: 'long-password-123', role: 'admin' })).body
    assert.equal(first.user.role, 'user'); assert.equal(first.user.password, undefined)
    assert.notEqual(state.users[0].password, 'long-password-123'); assert.notEqual(state.sessions[0].hash, first.token)
    assert.equal((await call('/admin/users', first.token)).status, 403)
    assert.equal((await call('/requests')).status, 401)
    const second = (await call('/auth/register', null, { email: 'staff@example.com', password: 'long-password-456' })).body
    state.users[1].role = 'moderator'
    const request = (await call('/requests', first.token, { kind: 'audio', draft: { id: 'tt6424454', title: 'Fixture', sources: [] } })).body
    assert.equal((await call(`/requests/${request.id}/review`, first.token, { action: 'approve' })).status, 403)
    const review = await call(`/requests/${request.id}/review`, second.token, { action: 'approve' })
    assert.equal(review.status, 200); assert.equal(saves, 1)
    assert.equal((await call(`/requests/${request.id}/review`, second.token, { action: 'approve' })).status, 400); assert.equal(saves, 1)
    assert.equal((await call(`/admin/users/${first.user.id}`, second.token, { role: 'admin', disabled: false })).status, 403)
    state.users[1].role = 'admin'
    assert.equal((await call(`/admin/users/${second.user.id}`, second.token, { role: 'user', disabled: false })).status, 400)
    const pending = (await call('/requests', first.token, { kind: 'poster', draft: { id: 'tt6424454', sources: [] } })).body
    conflict = true
    assert.equal((await call(`/requests/${pending.id}/review`, second.token, { action: 'approve' })).status, 400)
    assert.equal(state.requests.find(r => r.id === pending.id).status, 'pending')
    await call(`/admin/users/${first.user.id}`, second.token, { role: 'user', disabled: true })
    assert.equal((await call('/auth/me', first.token)).status, 401)
    await call('/auth/logout', second.token, {})
    assert.equal((await call('/auth/me', second.token)).status, 401)
    assert.ok(state.audit.length > 3)
  } finally { server.close(); server.closeAllConnections() }
})
