import { neon } from '@neondatabase/serverless'
import parseTorrent from 'parse-torrent'
const hash = process.argv[2]?.toLowerCase()
if (!/^[a-f0-9]{40}$/.test(hash || '') || !process.env.DATABASE_URL) throw new Error('Supply approved infohash and server DATABASE_URL')
const sql = neon(process.env.DATABASE_URL)
for (const { payload, revision } of await sql.query('SELECT payload,revision FROM public.torfilms_catalog')) {
  let changed = false
  for (const source of payload.sources || []) {
    const parsed = await parseTorrent(source.torrentBase64 ? Buffer.from(source.torrentBase64, 'base64') : source.magnet)
    if (parsed.infoHash !== hash) continue
    if (parsed.private === true) throw new Error('Private torrent cannot be announced to public trackers')
    console.log(JSON.stringify({ movie: payload.id, quality: source.id, infoHash: hash, private: parsed.private === true }))
    source.publicPlayback = { infoHash: hash }; changed = true
  }
  if (changed && process.argv.includes('--apply')) {
    payload.revision = revision + 1; payload.updatedAt = new Date().toISOString()
    const result = await sql.query('UPDATE public.torfilms_catalog SET payload=$1::jsonb,revision=$2,updated_at=NOW() WHERE id=$3 AND revision=$4 RETURNING id', [JSON.stringify(payload), payload.revision, payload.id, revision])
    if (!result.length) throw new Error('Concurrent catalog change; retry after review')
    console.log('Public infohash enabled; tracker URLs remain private')
  }
}
