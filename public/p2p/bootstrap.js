// Keep the form safe even if module loading or WebRTC initialization fails.
// No secure-context-only API may run before these handlers are installed.
const form = document.querySelector('#join')
const notice = document.querySelector('#status')
let startupMessage = 'Загружаю движок…'
form.addEventListener('submit', event => {
  event.preventDefault()
  if (!form.dataset.ready) notice.textContent = startupMessage
})
if (!window.isSecureContext || !('serviceWorker' in navigator)) {
  startupMessage = 'Подключение недоступно по HTTP на телефоне. Нужен HTTPS с доверенным сертификатом. Ваша ссылка сохранена в поле; обновлять страницу не нужно.'
  notice.textContent = startupMessage
  document.querySelector('#seed').disabled = true
} else {
  notice.textContent = startupMessage
  import('./app.js').then(({ mountPlayer }) => {
    mountPlayer(form.closest('main'))
    form.dataset.ready = 'true'
    if (notice.textContent === startupMessage) notice.textContent = 'Движок готов. Введите magnet-ссылку.'
  }).catch(error => {
    startupMessage = `Не удалось загрузить движок: ${error.message}. Ссылка остаётся в поле.`
    notice.textContent = startupMessage
  })
}
