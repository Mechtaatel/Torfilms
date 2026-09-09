import test from 'node:test'
import assert from 'node:assert/strict'
import { createCatalogDatabase } from '../lib/catalog-db.js'

test('database catalog creates schema, preserves JSON and uses optimistic revisions', async () => {
  const tables = new Map(); let schema = 0
  const sql = { async query (text, params = []) {
    const query = text.trim()
    if (query.startsWith('CREATE TABLE')) { schema++; return [] }
    if (query.startsWith('SELECT payload')) return [...tables.values()].sort((a, b) => a.updated - b.updated).map(row => ({ payload: row.payload }))
    if (query.startsWith('SELECT COUNT')) return [{ count: tables.size }]
    if (query.startsWith('SELECT 1')) return tables.has(params[0]) ? [{}] : []
    if (query.startsWith('INSERT')) {
      const [id, encoded, revision, expected] = params, old = tables.get(id)
      if (old && old.revision !== expected) return []
      const payload = JSON.parse(encoded); tables.set(id, { payload, revision, updated: Date.now() }); return [{ payload }]
    }
    throw new Error(`unexpected SQL: ${query}`)
  } }
  const db = createCatalogDatabase(sql)
  const first = await db.save({ id: 'tt1234567', title: 'Test', revision: 1 }, 0)
  assert.equal(first.title, 'Test'); assert.equal(schema, 1)
  await assert.rejects(() => db.save({ id: first.id, title: 'stale', revision: 2 }, 0), /изменена/)
  assert.deepEqual((await db.all())[0], first)
})
