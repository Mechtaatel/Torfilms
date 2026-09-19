import { neon } from '@neondatabase/serverless'
import parseTorrent from 'parse-torrent'
const hash = process.argv[2]?.toLowerCase()
const all = hash === '--all'
if ((!all && !/^[a-f0-9]{40}$/.test(hash || '')) || !process.env.DATABASE_URL) throw new Error('Supply infohash or --all and server DATABASE_URL')
const sql = neon(process.env.DATABASE_URL)
for (const { payload, revision } of await sql.query('SELECT payload,revision FROM public.torfilms_catalog')) {
  let changed = false
  for (const source of payload.sources || []) {
    const parsed = await parseTorrent(source.torrentBase64 ? Buffer.from(source.torrentBase64, 'base64') : source.magnet)
    if (!all && parsed.infoHash !== hash) continue
    const allowed = parsed.private !== true && /^[a-f0-9]{40}$/.test(parsed.infoHash || '')
    console.log(JSON.stringify({ movie: payload.id, quality: source.id, direct: allowed, privacy: source.torrentBase64 ? (parsed.private ? 'private' : 'public') : 'magnet-unspecified', changed: allowed ? source.publicPlayback?.infoHash !== parsed.infoHash : !!source.publicPlayback }))
    if (!allowed) { if (source.publicPlayback) { delete source.publicPlayback; changed = true }; continue }
    if (source.publicPlayback?.infoHash !== parsed.infoHash) { source.publicPlayback = { infoHash: parsed.infoHash }; changed = true }
  }
  if (changed && process.argv.includes('--apply')) {
    payload.revision = revision + 1; payload.updatedAt = new Date().toISOString()
    const result = await sql.query('UPDATE public.torfilms_catalog SET payload=$1::jsonb,revision=$2,updated_at=NOW() WHERE id=$3 AND revision=$4 RETURNING id', [JSON.stringify(payload), payload.revision, payload.id, revision])
    if (!result.length) throw new Error('Concurrent catalog change; retry after review')
    console.log('Public infohash enabled; tracker URLs remain private')
  }
}
