export function tagsOf (movie) {
  return [...new Set((movie.tags?.length ? movie.tags : String(movie.genre || '').split(',')).map(t => t.trim().toLowerCase()).filter(Boolean))]
}
export function seasonsOf (movie) {
  if (!movie.isSeries && movie.kind !== 'Сериал' && !movie.seasons?.length) return []
  const seasons = new Map((movie.seasons || []).map(s => [s.number, { ...s }]))
  for (const source of movie.sources || []) {
    const number = source.season ?? 1
    if (!seasons.has(number)) seasons.set(number, { number, title: `Сезон ${number}`, poster: '' })
  }
  return [...seasons.values()].sort((a, b) => a.number - b.number)
}
export function sourcesFor (movie, season) {
  return season == null ? movie.sources : movie.sources.filter(s => (s.season ?? 1) === season)
}
export function videoFiles (files, overrides = []) {
  const settings = new Map(overrides.map(e => [e.index, e]))
  return files.map((file, index) => ({ file, index, title: settings.get(index)?.title || file.name })).filter(({ file, index }) => !settings.get(index)?.excluded && /\.(mp4|webm|m4v|ogg|ogv|mkv|mov|avi|ts|m2ts)$/i.test(file.name)).sort((a, b) => a.file.name.localeCompare(b.file.name, 'ru', { numeric: true }))
}
