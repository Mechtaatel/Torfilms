import { seasonsOf, seasonKey, seasonValue, seasonTitle, seasonNameKey, validateSeasonNames, removeSeason } from './catalog-model.js'
export function openSeriesEditor (movie, onSave) {
  const draft = structuredClone(movie), dialog = document.createElement('dialog'), form = document.createElement('form')
  dialog.className = 'series-editor'
  const node = (tag, text) => { const e = document.createElement(tag); if (text) e.textContent = text; return e }
  const field = (parent, title, value, type, change) => { const label = node('label', title), input = node('input'); input.type = type; if (type === 'checkbox') input.checked = value; else input.value = value ?? ''; if (type === 'text') input.maxLength = 200; input.oninput = () => change(type === 'checkbox' ? input.checked : input.value); label.append(input); parent.append(label); return input }
  const button = (parent, title, action) => { const b = node('button', title); b.type = 'button'; b.onclick = action; parent.append(b) }
  form.append(node('h2', 'Редактор серий/озвучек'))
  const close = node('button', 'Закрыть'); close.type = 'button'; close.onclick = () => dialog.close(); form.append(close)
  const message = node('p'); message.setAttribute('role', 'alert')
  draft.seasons = seasonsOf(draft)
  const episodeInputs = []
  const seasonBox = node('details'); seasonBox.open = true; seasonBox.append(node('summary', 'Сезоны и обложки'))
  const seasonRows = node('div'); seasonRows.className = 'season-editor-grid'; seasonBox.append(seasonRows)
  function addSeason (s) {
    const row = node('fieldset'); row.append(node('legend', String(s.number)))
    const preview = node('img'); preview.width = 90; preview.alt = 'Обложка сезона'; row.append(preview)
    const show = () => { const src = s.poster || draft.poster; preview.hidden = !src; if (src) preview.src = src }; show()
    field(row, 'Название на карточке', s.title, 'text', value => { s.title = value })
    field(row, 'Обложка: HTTPS-ссылка', s.poster?.startsWith('data:') ? '' : s.poster, 'url', value => { s.poster = value; if (!value || /^https:\/\//.test(value)) show() })
    const upload = field(row, 'Загрузить обложку (до 2 МБ)', '', 'file', () => {}); upload.accept = 'image/jpeg,image/png,image/webp'
    upload.onchange = () => { const file = upload.files[0]; if (!file) return; if (file.size > 2 * 1024 ** 2 || !/^image\/(jpeg|png|webp)$/.test(file.type)) { message.textContent = 'Обложка: JPEG, PNG или WebP до 2 МБ'; return }; const reader = new FileReader(); reader.onload = () => { s.poster = reader.result; show() }; reader.readAsDataURL(file) }
    button(row, 'Обложка фильма', () => { s.poster = ''; show() })
    button(row, 'Удалить сезон…', () => {
      const panel = node('div'), target = node('select')
      const empty = node('option', 'Без переноса (только пустой сезон)'); empty.value = ''; target.append(empty)
      for (const other of draft.seasons) if (other !== s) { const option = node('option', `${other.title} [${other.number}]`); option.value = seasonKey(other.number); target.append(option) }
      const label = node('label', 'Куда перенести серии и раздачи:'); label.append(target); panel.append(label)
      panel.append(node('p', 'Серии, озвучки и файлы не удаляются. Обложка удаляемого сезона не переносится. Изменения вступят в силу после сохранения.'))
      button(panel, 'Подтвердить удаление сезона', () => {
        try {
          removeSeason(draft, s.number, target.value || null)
          for (const r of episodeInputs) r.input.value = r.episode.season ?? r.source.season ?? 1
          row.remove(); message.textContent = 'Сезон удалён из черновика. Нажмите «Сохранить».'
        } catch (e) { message.textContent = e.message }
      })
      button(panel, 'Отмена', () => panel.remove())
      row.querySelector('.season-delete')?.remove(); panel.className = 'season-delete'; row.append(panel)
    })
    seasonRows.append(row)
  }
  for (const s of draft.seasons) addSeason(s)
  let newSeason = ''
  field(seasonBox, 'Новый сезон', '', 'text', value => { newSeason = value })
  function ensureSeason (value) {
    const number = seasonValue(value)
    const existing = draft.seasons.find(s => seasonKey(s.number) === seasonKey(number) || seasonNameKey(s.title) === seasonNameKey(value))
    if (existing) return existing.number
    const s = { number, title: seasonTitle(number), poster: '' }
    validateSeasonNames([...draft.seasons, s]); draft.seasons.push(s); draft.isSeries = true; addSeason(s); return number
  }
  button(seasonBox, '+ Добавить сезон', () => { try { ensureSeason(newSeason) } catch (e) { message.textContent = e.message } }); form.append(seasonBox)
  for (const source of draft.sources) {
    const group = node('fieldset'); group.append(node('legend', source.label))
    source.audioLabels ||= {}
    const rows = [], tools = node('div'); tools.className = 'editor-bulk'
    field(tools, 'Поиск файла или серии', '', 'search', value => { for (const r of rows) r.row.hidden = !`${r.e.title} ${r.e.filename}`.toLowerCase().includes(value.toLowerCase()) })
    button(tools, 'Выбрать видимые', () => { for (const r of rows) if (!r.row.hidden) r.selected.checked = true })
    button(tools, 'Снять выделение', () => { for (const r of rows) r.selected.checked = false })
    let destination = ''
    field(tools, 'Сезон для выбранных', '', 'text', value => { destination = value })
    button(tools, 'Перенести выбранные', () => { try { const value = ensureSeason(destination); for (const r of rows) if (r.selected.checked) { r.e.season = value; r.season.value = value } } catch (e) { message.textContent = e.message } })
    for (const [title, excluded] of [['Исключить выбранные', true], ['Вернуть выбранные', false]]) button(tools, title, () => { for (const r of rows) if (r.selected.checked) { r.e.excluded = excluded; r.include.checked = !excluded } })
    group.append(tools)
    if (!source.episodes?.length) group.append(node('p', 'Список файлов пока неизвестен. Подключите раздачу и откройте редактор заново.'))
    const audio = new Map()
    for (const episode of source.episodes || []) {
      const row = node('fieldset'); row.append(node('legend', episode.filename || `Файл ${episode.index}`))
      row.className = 'episode-editor-row'
      const selected = field(row, 'Выбрать', false, 'checkbox', () => {})
      field(row, 'Название серии', episode.title, 'text', value => { episode.title = value })
      const season = field(row, 'Сезон', episode.season ?? source.season ?? 1, 'text', value => { episode.season = value })
      episodeInputs.push({ input: season, episode, source })
      const include = field(row, 'Показывать серию', !episode.excluded, 'checkbox', value => { episode.excluded = !value })
      rows.push({ row, e: episode, selected, season, include })
      group.append(row)
      const media = source.audioMetadata?.[episode.index]
      for (const t of media?.tracks || []) audio.set(`${episode.index}:${t.index}`, `${episode.title} · ${t.title || t.language || 'Дорожка'} ${t.index}`)
      for (const t of media?.externalTracks || []) audio.set(`file:${t.fileIndex}`, t.title)
    }
    const dubs = node('details'); dubs.append(node('summary', `Названия озвучек (${audio.size})`))
    for (const [key, title] of audio) field(dubs, title, source.audioLabels[key] || title, 'text', value => { source.audioLabels[key] = value })
    group.append(dubs)
    form.append(group)
  }
  const save = node('button', 'Сохранить'); save.type = 'submit'; form.append(message, save)
  form.onsubmit = async event => {
    event.preventDefault(); save.disabled = true
    try {
      for (const source of draft.sources) for (const e of source.episodes || []) e.season = ensureSeason(e.season ?? source.season ?? 1)
      validateSeasonNames(draft.seasons)
      await onSave(draft); dialog.close()
    } catch (e) { message.textContent = e.message } finally { save.disabled = false }
  }
  dialog.append(form); document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal()
}
