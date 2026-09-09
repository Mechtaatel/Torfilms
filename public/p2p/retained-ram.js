// One bounded pool for this page lifetime. Closing a torrent detaches it but
// retains its pieces until newer pieces evict them; no browser disk storage.
export class RetainedRamPool {
  constructor (limit = 500 * 1024 ** 2) { this.limit = limit; this.used = 0; this.buckets = new Map(); this.order = new Map() }
  configure (limit) { this.limit = limit; this.trim() }
  attach (store) {
    const hash = store.torrent.infoHash
    let bucket = this.buckets.get(hash)
    if (!bucket) { bucket = { hash, entries: new Map(), used: 0, owners: new Set() }; this.buckets.set(hash, bucket) }
    bucket.owners.add(store); return bucket
  }
  put (bucket, index, value) {
    const key = `${bucket.hash}:${index}`, bytes = new Uint8Array(value)
    const old = bucket.entries.get(index)?.length || 0
    bucket.entries.set(index, bytes); bucket.used += bytes.length - old; this.used += bytes.length - old
    this.order.delete(key); this.order.set(key, { bucket, index }); this.trim()
  }
  trim () {
    while (this.used > this.limit && this.order.size) {
      const [key, { bucket, index }] = this.order.entries().next().value
      const size = bucket.entries.get(index).length
      bucket.entries.delete(index); bucket.used -= size; this.used -= size; this.order.delete(key)
      for (const owner of bucket.owners) if (!owner.closed && !owner.torrent.destroyed) {
        owner.torrent._markUnverified(index)
        for (const wire of owner.torrent.wires) wire.lt_donthave?.donthave(index)
      }
      if (!bucket.entries.size && !bucket.owners.size) this.buckets.delete(bucket.hash)
    }
  }
}
