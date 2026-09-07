// HTTPS carries individual torrent pieces, not an alternative video stream.
// Verified pieces enter the same bounded RAM store and are announced to RTC peers.
export function createPieceFallback (torrent, limit, onTransfer = () => {}) {
  return async (index, signal) => {
    const length = index === torrent.pieces.length - 1 ? torrent.lastPieceLength : torrent.pieceLength
    if (!Number.isInteger(index) || index < 0 || index >= torrent.pieces.length || length > limit) throw new Error('Недопустимый размер куска')
    const response = await fetch(`/bridge/piece/${torrent.infoHash}/${index}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) })
    if (!response.ok) throw new Error(`Мост пока не отдаёт нужный кусок (${response.status})`)
    if (Number(response.headers.get('content-length')) !== length) throw new Error('Неверная длина куска')
    const data = new Uint8Array(await response.arrayBuffer())
    if (data.length !== length) throw new Error('Кусок получен не полностью')
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', data))
    const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
    if (hash !== torrent._hashes[index]) throw new Error('Кусок не прошёл проверку SHA-1')
    signal.throwIfAborted()
    if (torrent.destroyed) return
    await new Promise((resolve, reject) => torrent.store.put(index, data, error => error ? reject(error) : resolve()))
    if (torrent.destroyed) return
    torrent._markVerified(index)
    for (const wire of torrent.wires) wire.have(index)
    onTransfer(data.length)
  }
}
