// Isolated native TCP/uTP source for process-pool integration tests.
import WebTorrent from 'webtorrent'
import MemoryStore from 'memory-chunk-store'
const seed = new WebTorrent({ tracker: false, dht: false, lsd: false, natTraversal: false })
seed.on('error', e => console.error(e.message))
const torrents = await Promise.all([19, 87].map((byte, i) => {
  const payload = Buffer.alloc(256 * 1024, byte); payload.name = `fixture-${i}.bin`
  return new Promise(resolve => seed.seed(payload, { announce: [], store: MemoryStore }, resolve))
}))
process.send({ port: seed.address().port, torrents: torrents.map(t => ({ infoHash: t.infoHash, torrentBase64: Buffer.from(t.torrentFile).toString('base64') })) })
let closing = false
function shutdown () { if (closing) return; closing = true; seed.destroy(() => process.exit()); setTimeout(() => process.exit(), 2000).unref() }
process.on('disconnect', shutdown)
process.on('message', shutdown)
