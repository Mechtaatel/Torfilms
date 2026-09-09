import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
const empty = () => ({ users: [], sessions: [], requests: [], audit: [] })
export function accountsStore (directory, env = process.env) {
  let queue = Promise.resolve(), connection
  const sql = async () => {
    if (!env.DATABASE_URL) return null
    connection ||= import('@neondatabase/serverless').then(async ({ neon }) => {
      const db = neon(env.DATABASE_URL)
      await db.query('CREATE TABLE IF NOT EXISTS torfilms_accounts (id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL, payload JSONB NOT NULL)')
      await db.query('INSERT INTO torfilms_accounts VALUES (1,0,$1::jsonb) ON CONFLICT DO NOTHING', [JSON.stringify(empty())])
      return db
    })
    return connection
  }
  async function snapshot () {
    const db = await sql()
    if (db) { const [row] = await db.query('SELECT revision,payload FROM torfilms_accounts WHERE id=1'); return { db, revision: row.revision, state: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload } }
    try { return { state: JSON.parse(await readFile(path.join(directory, 'accounts.json'), 'utf8')) } } catch (e) { if (e.code === 'ENOENT') return { state: empty() }; throw e }
  }
  return {
    async read () { await queue; return (await snapshot()).state },
    change (fn) {
      const operation = queue.then(async () => {
        for (let retry = 0; retry < 8; retry++) {
          const { db, state, revision } = await snapshot()
          const result = fn(state) // Pure synchronous mutation; safe to retry CAS.
          const data = JSON.stringify(state)
          if (Buffer.byteLength(data) > 64 * 1024 ** 2) throw new Error('Хранилище аккаунтов и заявок заполнено')
          if (db) {
            const rows = await db.query('UPDATE torfilms_accounts SET payload=$1::jsonb,revision=revision+1 WHERE id=1 AND revision=$2 RETURNING id', [data, revision])
            if (!rows.length) continue
          } else {
            await mkdir(directory, { recursive: true }); const file = path.join(directory, 'accounts.json')
            await writeFile(file + '.tmp', data, { mode: 0o600 }); await rename(file + '.tmp', file)
          }
          return result
        }
        throw new Error('Данные одновременно изменены. Повторите запрос.')
      })
      queue = operation.catch(() => {}); return operation
    }
  }
}
