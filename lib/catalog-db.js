const TABLE = 'torfilms_catalog'
const MAX_ITEMS = 200
const MAX_BYTES = 64 * 1024 * 1024

export function createCatalogDatabase (sql) {
  let ready
  const ensure = () => {
    ready ||= sql.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
    return ready
  }
  return {
    async all () {
      await ensure()
      const rows = await sql.query(`SELECT payload FROM ${TABLE} ORDER BY updated_at DESC, id ASC`)
      return rows.map(row => typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload)
    },
    async save (payload, expectedRevision) {
      const encoded = JSON.stringify(payload)
      if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error('Каталог превышает 64 МБ')
      await ensure()
      if (expectedRevision === 0) {
        const count = await sql.query(`SELECT COUNT(*)::int AS count FROM ${TABLE}`)
        if (Number(count[0]?.count || 0) >= MAX_ITEMS && !(await sql.query(`SELECT 1 FROM ${TABLE} WHERE id = $1`, [payload.id])).length) throw new Error('Лимит домашнего каталога: 200 карточек')
      }
      const rows = await sql.query(`
        INSERT INTO ${TABLE} (id, payload, revision, updated_at)
        VALUES ($1, $2::jsonb, $3, NOW())
        ON CONFLICT (id) DO UPDATE SET
          payload = EXCLUDED.payload,
          revision = EXCLUDED.revision,
          updated_at = NOW()
        WHERE ${TABLE}.revision = $4
        RETURNING payload
      `, [payload.id, encoded, payload.revision, expectedRevision])
      if (!rows.length) throw new Error('Карточка уже изменена. Откройте её заново перед сохранением.')
      return typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload
    }
  }
}

export async function catalogDatabaseFromEnv (env = process.env) {
  if (!env.DATABASE_URL) return null
  const { neon } = await import('@neondatabase/serverless')
  return createCatalogDatabase(neon(env.DATABASE_URL))
}
