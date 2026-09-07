import { mountPlayer } from './app.js'

// Only static interface markup goes here; movie metadata is assigned as text.
export function createCompactPlayer (host, movie, quality) {
  host.classList.add('movie-player')
  host.innerHTML = `
    <video controls playsinline preload="auto" aria-label="Видео"></video>
    <div hidden><input id="audio-seek" type="range" min="0" max="0" step="1" value="0" disabled><span id="audio-time"></span></div>
    <div class="player-tools"><div id="quality-slot"></div><label class="episode-choice">Серия / видеофайл <select id="episode" disabled><option>Получаю список…</option></select></label><button id="stop" type="button">Остановить</button></div>
    <p id="status" role="status" aria-live="polite"></p>
    <details class="player-settings"><summary>Настройки плеера</summary>
      <section id="audio-panel" hidden>
        <div class="player-tools"><label>Озвучка <select id="audio-track"></select></label><button id="audio-refresh" type="button">Обновить озвучки</button><button id="audio-original" type="button">Исходный звук</button></div>
        <p id="audio-mode" class="muted"></p>
      </section>
      <div class="player-tools"><label>RAM-кеш (500–2048 МБ) <input id="ram" type="range" min="500" max="2048" step="1" value="500"><output id="ram-value" for="ram">500 МБ</output></label><label>Отдача, КиБ/с <input id="upload" type="number" min="1" max="10240" value="512"></label><button id="apply-settings" type="button">Применить и переподключить</button></div>
      <p class="muted">Изменение лимитов переподключает видео с начала. Кеш используется на этом устройстве; мост имеет отдельный кеш. IP-адрес виден участникам P2P.</p>
      <details><summary>Файлы и статистика</summary><div id="files"></div><pre id="stats"></pre></details>
    </details>
    <form id="join" hidden><input id="magnet" required><button type="submit">Подключить</button></form><input id="seed" type="file" hidden>
  `
  host.querySelector('#join').addEventListener('submit', event => event.preventDefault())
  const controller = mountPlayer(host, { movie, quality, compact: true })
  host.querySelector('#apply-settings').onclick = () => host.querySelector('#join').requestSubmit()
  return controller
}
