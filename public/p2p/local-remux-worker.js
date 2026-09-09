import { Input, CustomSource, ALL_FORMATS, EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, Output, Mp4OutputFormat, AppendOnlyStreamTarget } from './mediabunny.min.mjs'
import { flacHeaderWriter } from './flac-mp4-header.js'

// This worker never fetches media or encodes frames. All reads pass through the
// viewer's verified torrent store; all output is bounded, transient fMP4.
let serial = 0
const pending = new Map()
function request (type, data = {}, transfer = []) {
  const id = ++serial
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); postMessage({ type, id, ...data }, transfer) })
}
function inputFor (fileIndex, length) {
  return new Input({ formats: ALL_FORMATS, source: new CustomSource({
    getSize: () => length, maxCacheSize: 4 * 1024 ** 2, prefetchProfile: 'none',
    read: (start, end) => new ReadableStream({
      async pull (controller) {
        try {
          if (start >= end) { controller.close(); return }
          const stop = Math.min(end, start + 256 * 1024)
          const bytes = await request('read', { fileIndex, start, end: stop })
          start = stop; controller.enqueue(bytes)
        } catch (e) { controller.error(e) }
      }
    }, { highWaterMark: 0 })
  }) })
}
async function run (options) {
  const inputs = [], input = inputFor(options.fileIndex, options.length); inputs.push(input)
  let output
  try {
    const all = await input.getTracks(), video = await input.getPrimaryVideoTrack()
    if (!video) throw new Error('В файле не найдена видеодорожка')
    const tracks = []
    for (let i = 0; i < all.length; i++) if (all[i].type === 'audio') tracks.push({
      id: `local:${i}`, index: i, title: await all[i].getName() || `Дорожка ${i + 1}`,
      language: await all[i].getLanguageCode(), codec: await all[i].getCodec(), channels: await all[i].getNumberOfChannels()
    })
    const base = await video.getFirstTimestamp()
    const endTime = await input.getDurationFromMetadata()
    const duration = endTime != null ? endTime - base : options.duration
    if (!(duration > 0 && Number.isFinite(duration))) throw new Error('В MKV нет длительности. Сначала получите метаданные через режим моста.')
    const selection = await request('metadata', { tracks, duration })
    if (selection) Object.assign(options, selection)
    let audio
    if (options.audioFile != null) {
      const external = inputFor(options.audioFile, options.audioLength); inputs.push(external)
      audio = (await external.getAudioTracks())[0]
      if (!audio) throw new Error('Во внешнем файле не найдена озвучка')
    } else audio = options.audioIndex != null ? all[options.audioIndex] : all.find(t => t.type === 'audio')
    if (audio && audio.type !== 'audio') throw new Error('Выбранная дорожка не является аудио')
    if (options.audioOnly) {
      if (!audio) throw new Error('Озвучка не найдена')
      const codec = await audio.getCodec(), config = await audio.getDecoderConfig()
      const raw = codec === 'mp3'
      const format = new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 })
      if (!raw && !format.getSupportedAudioCodecs().includes(codec)) throw new Error('Этот звук требует режима совместимости на мосте')
      const position = Math.max(0, Math.min(options.position || 0, duration - 0.01))
      const shift = Math.max(0, base - await audio.getFirstTimestamp())
      await request('configure', { mime: raw ? 'audio/mpeg' : `audio/mp4; codecs="${await audio.getCodecParameterString()}"`, duration, position, timestampOffset: -shift })
      const sink = new EncodedPacketSink(audio)
      let packet = await sink.getPacket(Math.max(0, position + base - 0.15)) || await sink.getFirstPacket()
      let source
      if (!raw) {
        source = new EncodedAudioPacketSource(codec)
        output = new Output({ format, target: new AppendOnlyStreamTarget(new WritableStream({ write: flacHeaderWriter(async bytes => {
          const copy = bytes.slice(); await request('append', { bytes: copy }, [copy.buffer])
        }) })) })
        output.addAudioTrack(source); await output.start()
      }
      while (packet) {
        await request('pace', { timestamp: packet.timestamp - base })
        if (raw) {
          const bytes = packet.data.slice()
          await request('append', { bytes, timestamp: packet.timestamp - base }, [bytes.buffer])
        } else await source.add(packet.clone({ timestamp: packet.timestamp - base + shift }), { decoderConfig: config })
        packet = await sink.getNextPacket(packet)
      }
      if (output) { source.close(); await output.finalize() }
      await request('end'); return
    }
    const selected = [video, ...(audio ? [audio] : [])]
    const configs = await Promise.all(selected.map(t => t.getDecoderConfig()))
    if (configs.some(c => !c)) throw new Error('Не удалось прочитать параметры кодека')
    // WebCodecs calls MPEG Layer III "mp3", but MP4/MSE requires its
    // RFC 6381 object-type identifier. Packet data stays unchanged.
    const codecs = await Promise.all(selected.map(async t => (await t.getCodec()) === 'mp3' ? 'mp4a.6B' : t.getCodecParameterString()))
    const format = new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 })
    const videoCodec = await video.getCodec(), audioCodec = audio && await audio.getCodec()
    const separateMp3 = audioCodec === 'mp3'
    if (!format.getSupportedVideoCodecs().includes(videoCodec) || (audio && !format.getSupportedAudioCodecs().includes(audioCodec))) throw new Error('Эти кодеки нельзя перепаковать в MP4 без перекодирования')
    const position = Math.max(0, Math.min(options.position || 0, duration - 0.01))
    const sinks = selected.map(t => new EncodedPacketSink(t))
    const first = await sinks[0].getKeyPacket(position + base, { verifyKeyPackets: true }) || await sinks[0].getFirstKeyPacket({ verifyKeyPackets: true })
    if (!first) throw new Error('В MKV не найден ключевой кадр')
    const packets = [first]
    if (audio) packets.push(await sinks[1].getPacket(first.timestamp) || await sinks[1].getFirstPacket())
    const earliest = Math.min(...await Promise.all(selected.map(t => t.getFirstTimestamp())))
    const shift = Math.max(0, base - earliest)
    await request('configure', { mime: `video/mp4; codecs="${(separateMp3 ? codecs.slice(0, 1) : codecs).join(',')}"`, audioMime: separateMp3 ? 'audio/mpeg' : null, duration, position, timestampOffset: -shift })
    const sources = [new EncodedVideoPacketSource(videoCodec), ...(audio ? [separateMp3 ? null : new EncodedAudioPacketSource(audioCodec)] : [])]
    let heldBytes = 0
    output = new Output({ format, target: new AppendOnlyStreamTarget(new WritableStream({
      write: flacHeaderWriter(async bytes => {
        // Transfer a copy: the muxer may retain its own views.
        const copy = bytes.slice()
        await request('append', { bytes: copy }, [copy.buffer]); heldBytes = 0
      })
    })) })
    output.addVideoTrack(sources[0], { rotation: await video.getRotation() })
    if (audio && !separateMp3) output.addAudioTrack(sources[1])
    await output.start()
    for (let i = 0; i < packets.length; i++) if (!packets[i]) sources[i]?.close()
    let nextPace = -Infinity
    while (packets.some(Boolean)) {
      let index = -1
      for (let i = 0; i < packets.length; i++) if (packets[i] && (index < 0 || packets[i].timestamp < packets[index].timestamp)) index = i
      const packet = packets[index]
      if (packet.timestamp >= nextPace) { await request('pace', { timestamp: packet.timestamp - base }); nextPace = packet.timestamp + 0.25 }
      heldBytes += packet.byteLength
      if (heldBytes > 64 * 1024 ** 2) throw new Error('Слишком большой фрагмент без ключевого кадра (более 64 МиБ)')
      // Keep each track's decode order and the shared presentation clock.
      // Do not independently reset external audio timestamps to zero.
      if (separateMp3 && index === 1) {
        const bytes = packet.data.slice()
        await request('appendAudio', { bytes, timestamp: packet.timestamp - base }, [bytes.buffer])
      } else await sources[index].add(packet.clone({ timestamp: packet.timestamp - base + shift }), { decoderConfig: configs[index] })
      packets[index] = await sinks[index].getNextPacket(packet)
      if (!packets[index]) sources[index]?.close()
    }
    await output.finalize(); await request('end')
  } finally { for (const input of inputs) input.dispose(); if (output && output.state !== 'finalized') await output.cancel() }
}
onmessage = event => {
  const message = event.data
  if (message.type === 'reply') {
    const item = pending.get(message.id); if (!item) return
    pending.delete(message.id); message.error ? item.reject(new Error(message.error)) : item.resolve(message.value)
  } else if (message.type === 'start') run(message).catch(error => postMessage({ type: 'error', message: error.message }))
}
