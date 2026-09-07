export function openSeriesEditor (movie, onSave) {
  const draft = structuredClone(movie), dialog = document.createElement('dialog'), form = document.createElement('form')
  const node = (tag, text) => { const e = document.createElement(tag); if (text) e.textContent = text; return e }
  const field = (parent, title, value, type, change) => { const label = node('label', title), input = node('input'); input.type = type; if (type === 'checkbox') input.checked = value; else input.value = value; if (type === 'number') { input.min = 0; input.max = 999; input.required = true } if (type === 'text') input.maxLength = 200; input.oninput = () => change(type === 'checkbox' ? input.checked : input.value); label.append(input); parent.append(label) }
  form.append(node('h2', 'Редактор серий/озвучек'))
  const close = node('button', 'Закрыть'); close.type = 'button'; close.onclick = () => dialog.close(); form.append(close)
  for (const source of draft.sources) {
    const group = node('fieldset'); group.append(node('legend', source.label))
    source.audioLabels ||= {}
    if (!source.episodes?.length) group.append(node('p', 'Список файлов пока неизвестен. Подключите раздачу и откройте редактор заново.'))
    const audio = new Map()
    for (const episode of source.episodes || []) {
      const row = node('fieldset'); row.append(node('legend', episode.filename || `Файл ${episode.index}`))
      field(row, 'Название серии', episode.title, 'text', value => { episode.title = value })
      field(row, 'Сезон (0 — спецвыпуски)', episode.season ?? source.season ?? 1, 'number', value => { episode.season = Number(value) })
      field(row, 'Показывать серию', !episode.excluded, 'checkbox', value => { episode.excluded = !value })
      group.append(row)
      const media = source.audioMetadata?.[episode.index]
      for (const t of media?.tracks || []) audio.set(`${episode.index}:${t.index}`, `${episode.title} · ${t.title || t.language || 'Дорожка'} ${t.index}`)
      for (const t of media?.externalTracks || []) audio.set(`file:${t.fileIndex}`, t.title)
    }
    if (audio.size) group.append(node('h3', 'Названия озвучек'))
    for (const [key, title] of audio) field(group, title, source.audioLabels[key] || title, 'text', value => { source.audioLabels[key] = value })
    form.append(group)
  }
  const message = node('p'), save = node('button', 'Сохранить'); save.type = 'submit'; form.append(message, save)
  form.onsubmit = async event => {
    event.preventDefault(); save.disabled = true
    try { await onSave(draft); dialog.close() } catch (e) { message.textContent = e.message } finally { save.disabled = false }
  }
  dialog.append(form); document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal()
}
