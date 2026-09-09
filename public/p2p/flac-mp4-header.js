// Fix the FLAC AudioSampleEntry emitted by Mediabunny 1.55.7 without
// changing a single audio packet. STREAMINFO remains the source of truth.
// Mapping: https://github.com/xiph/flac/blob/master/doc/isoflac.txt
export function repairFlacMoov (bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = p => String.fromCharCode(...bytes.subarray(p + 4, p + 8))
  function walk (start, end, depth = 0) {
    if (depth > 10) throw new Error('Слишком глубокая структура MP4')
    for (let p = start; p + 8 <= end;) {
      const size = view.getUint32(p), name = type(p)
      if (size < 8 || p + size > end) throw new Error('Повреждённый заголовок MP4')
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(name)) walk(p + 8, p + size, depth + 1)
      else if (name === 'stsd') walk(p + 16, p + size, depth + 1)
      else if (name === 'fLaC' && size >= 36 && view.getUint16(p + 16) === 0) {
        for (let child = p + 36; child + 8 <= p + size;) {
          const length = view.getUint32(child)
          if (length < 8 || child + length > p + size) throw new Error('Повреждённый FLAC sample entry')
          if (type(child) === 'dfLa' && length >= 50 && (bytes[child + 12] & 127) === 0) {
            const rate = view.getUint32(child + 26) >>> 12
            const bits = ((view.getUint16(child + 28) >>> 4) & 31) + 1
            let headerRate = rate
            while (headerRate > 65535 && headerRate % 2 === 0) headerRate /= 2
            view.setUint16(p + 24, rate ? ((bytes[child + 28] >>> 1) & 7) + 1 : view.getUint16(p + 24))
            view.setUint16(p + 26, bits)
            view.setUint32(p + 32, Math.min(headerRate, 65535) * 65536)
          }
          child += length
        }
      }
      p += size
    }
  }
  walk(0, bytes.length); return bytes
}
export function flacHeaderWriter (write) {
  let pending = new Uint8Array(), initialized = false
  return async bytes => {
    if (initialized) return write(bytes)
    const next = new Uint8Array(pending.length + bytes.length); next.set(pending); next.set(bytes, pending.length); pending = next
    while (pending.length >= 8) {
      const size = new DataView(pending.buffer, pending.byteOffset, pending.byteLength).getUint32(0)
      if (size < 8 || size > 8 * 1024 ** 2) throw new Error('Неверный или слишком большой заголовок MP4')
      if (pending.length < size) return
      const box = pending.slice(0, size); pending = pending.slice(size)
      if (String.fromCharCode(...box.subarray(4, 8)) === 'moov') { repairFlacMoov(box); initialized = true }
      await write(box)
      if (initialized) { if (pending.length) await write(pending); pending = new Uint8Array(); return }
    }
  }
}
