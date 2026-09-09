import { readFile } from 'node:fs/promises'
import { Pool, neonConfig } from '@neondatabase/serverless'
import WebSocket from 'ws'
import assert from 'node:assert/strict'

neonConfig.webSocketConstructor = WebSocket
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required on server only')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
try {
  const client = await pool.connect()
  try {
    const tables = await client.query(`SELECT current_user, c.relname, c.relrowsecurity,
      pg_get_userbyid(c.relowner) AS owner FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname LIKE 'torfilms_%'`)
    console.log('Tables:', JSON.stringify(tables.rows))
    console.log('API roles:', JSON.stringify((await client.query(`SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('anonymous','authenticated')`)).rows))
    console.log('Policies:', JSON.stringify((await client.query(`SELECT schemaname,tablename,policyname,roles,cmd FROM pg_policies WHERE tablename LIKE 'torfilms_%'`)).rows))
    if (process.argv.includes('--apply')) {
      if (tables.rows.some(t => t.current_user !== t.owner)) throw new Error('Run migration as table owner')
      const migration = await readFile(new URL('../migrations/001-public-catalog.sql', import.meta.url), 'utf8')
      await client.query(migration)
      console.log('Migration applied')
    }
    console.log('Privileges:', JSON.stringify((await client.query(`SELECT r.rolname, n.nspname, c.relname,
      has_table_privilege(r.oid,c.oid,'SELECT') AS can_select,
      has_table_privilege(r.oid,c.oid,'INSERT') AS can_insert,
      has_table_privilege(r.oid,c.oid,'UPDATE') AS can_update,
      has_table_privilege(r.oid,c.oid,'DELETE') AS can_delete,
      c.relrowsecurity
      FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE r.rolname IN ('anonymous','authenticated')
      AND c.relkind IN ('r','p','v')
      AND ((n.nspname='public' AND c.relname LIKE 'torfilms_%') OR (n.nspname='catalog' AND c.relname='movies'))`)).rows))
    if (process.argv.includes('--verify')) {
      for (const role of ['anonymous', 'authenticated']) {
        await client.query('BEGIN READ ONLY')
        try {
          await client.query(`SET LOCAL ROLE ${role}`)
          const rows = (await client.query('SELECT movie FROM catalog.movies')).rows
          assert.ok(rows.length > 0, 'Expected existing catalog')
          const forbidden = new Set(['payload', 'torrentBase64', 'magnet', 'revision', 'password', 'email', 'sessions', 'audioMetadata'])
          const inspect = value => { if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { assert.ok(!forbidden.has(key), `Unexpected public field: ${key}`); inspect(child) } }
          rows.forEach(inspect)
          console.log(`${role}: SELECT view OK (${rows.length} cards); field allowlist OK`)
        } finally { await client.query('ROLLBACK') }
        const denied = [
          'SELECT payload FROM public.torfilms_catalog LIMIT 1',
          'SELECT payload FROM catalog.movies LIMIT 1',
          ...['catalog.movies', 'public.torfilms_catalog'].flatMap(table => [
            `EXPLAIN INSERT INTO ${table} (id) VALUES ('tt0000000')`,
            `EXPLAIN UPDATE ${table} SET id=id WHERE false`,
            `EXPLAIN DELETE FROM ${table} WHERE false`
          ])
        ]
        for (const query of denied) {
          await client.query('BEGIN READ ONLY')
          try {
            await client.query(`SET LOCAL ROLE ${role}`)
            let error
            try { await client.query(query) } catch (caught) { error = caught }
            assert.ok(error && ['42501', '42703', '55000'].includes(error.code), `Expected access denial: ${query}`)
          } finally { await client.query('ROLLBACK') }
        }
        console.log(`${role}: raw fields and INSERT/UPDATE/DELETE denied (EXPLAIN only, no rows modified)`)
      }
    }
  } finally { client.release() }
} catch (error) {
  // Do not log connection objects or credentials.
  console.error(error.message); process.exitCode = 1
} finally { await pool.end() }
