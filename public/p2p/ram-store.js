export class RamStore {
  constructor (pieceLength, opts = {}) {
    this.torrent = opts.torrent
    this.limit = opts.limit || 128 * 1024 ** 2
    if (pieceLength > this.limit) throw new Error('Размер piece превышает лимит RAM')
    this.entries = new Map()
    this.used = 0
    this.closed = false
    opts.onStore?.(this)
  }
  put (index, value, cb = () => {}) {
    if (this.closed) return queueMicrotask(() => cb(new Error('Closed')))
    const copy = new Uint8Array(value)
    this.used -= this.entries.get(index)?.length || 0
    this.entries.delete(index)
    this.entries.set(index, copy)
    this.used += copy.length
    while (this.used > this.limit) {
      const victim = this.entries.keys().next().value
      this.used -= this.entries.get(victim).length
      this.entries.delete(victim)
      if (this.torrent && !this.torrent.destroyed) {
        this.torrent._markUnverified(victim)
        for (const wire of this.torrent.wires) wire.lt_donthave?.donthave(victim)
      }
    }
    queueMicrotask(() => cb(null))
  }
  get (index, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {} }
    const value = this.entries.get(index)
    if (!value) return queueMicrotask(() => cb(Object.assign(new Error('Piece evicted'), { notFound: true })))
    const start = opts?.offset || 0
    queueMicrotask(() => cb(null, value.subarray(start, start + (opts?.length ?? value.length - start))))
  }
  close (cb = () => {}) { this.closed = true; this.entries.clear(); this.used = 0; queueMicrotask(cb) }
  destroy (cb) { this.close(cb) }
}

// Each reader selects only a few pieces ahead, never the entire movie.
export function installReader (file, torrent, limit, demand, fallback) {
  file[Symbol.asyncIterator] = function ({ start = 0, end = file.length - 1 } = {}) {
    let cancelled = false
    const abort = new AbortController()
    const reader = (async function * () {
      for (let pos = start; pos <= end && !cancelled; ) {
        const absolute = file.offset + pos
        const piece = Math.floor(absolute / torrent.pieceLength)
        const offset = absolute % torrent.pieceLength
        const count = Math.max(1, Math.min(16, Math.floor(limit / torrent.pieceLength / 4)))
        const last = Math.min(Math.floor((file.offset + end) / torrent.pieceLength), piece + count - 1)
        torrent._select(piece, last, 20, null, true)
        let lastDemand = 0
        let lastFallback = Date.now()
        try {
          let data
          while (!cancelled && !data) {
            if (torrent.destroyed) return
            if (demand && Date.now() - lastDemand > 3000) {
              lastDemand = Date.now()
              demand(piece, last)
            }
            data = await new Promise((resolve, reject) => torrent.store.get(piece, { offset, length: Math.min(end - pos + 1, torrent.pieceLength - offset) }, (err, value) => err ? (err.notFound ? resolve(null) : reject(err)) : resolve(value)))
            if (!data && fallback && (!torrent.numPeers || Date.now() - lastFallback > 2000)) {
              lastFallback = Date.now()
              try { await fallback(piece, abort.signal) } catch (error) { if (cancelled) return; if (/SHA-1|длин|размер/.test(error.message)) throw error }
            }
            if (!data) await new Promise(r => setTimeout(r, 50))
          }
          if (cancelled) return
          yield data
          pos += data.length
        } finally {
          if (!torrent.destroyed) torrent._deselect(piece, last, true)
        }
      }
    })()
    return { next: () => reader.next(), return: () => { cancelled = true; abort.abort(); return reader.return() }, [Symbol.asyncIterator] () { return this } }
  }
}
