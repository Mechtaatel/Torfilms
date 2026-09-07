import { setTimeout as delay } from 'node:timers/promises'

// WebTorrent's FileIterator selects its entire range, including bytes the
// HTTP client may never read. Own just one piece while satisfying demand.
export async function * readRange (file, torrent, start, end, signal) {
  let position = start
  while (position <= end) {
    signal.throwIfAborted()
    const absolute = file.offset + position
    const index = Math.floor(absolute / torrent.pieceLength)
    const offset = absolute % torrent.pieceLength
    const length = Math.min(end - position + 1, torrent.pieceLength - offset)
    torrent._select(index, index, 30, null, true)
    try {
      let data
      while (!data) {
        signal.throwIfAborted()
        if (torrent.destroyed) throw new Error('Torrent stopped')
        if (torrent.bitfield.get(index)) {
          try {
            data = await new Promise((resolve, reject) => {
              torrent.store.get(index, { offset, length }, (error, value) => error ? reject(error) : resolve(value))
            })
          } catch (error) {
            if (!error.notFound) throw error
          }
        }
        if (!data) await delay(50, undefined, { signal })
      }
      signal.throwIfAborted()
      if (data.length !== length) throw new Error('Incomplete RAM piece')
      yield data
      position += length
    } finally {
      if (!torrent.destroyed) torrent._deselect(index, index, true)
    }
  }
}
