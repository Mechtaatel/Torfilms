import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

test('insecure phone HTTP keeps form input and cancels native navigation without randomUUID', () => {
  const handlers = {}
  const elements = {
    '#join': { dataset: {}, addEventListener: (name, fn) => { handlers[name] = fn } },
    '#status': { textContent: '' }, '#seed': { disabled: false },
    '#magnet': { value: 'magnet:?xt=urn:btih:test' }
  }
  vm.runInNewContext(readFileSync(new URL('../public/p2p/bootstrap.js', import.meta.url), 'utf8'), {
    document: { querySelector: selector => elements[selector] }, window: { isSecureContext: false }, navigator: {}, crypto: {}
  })
  let prevented = false
  handlers.submit({ preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  assert.match(elements['#status'].textContent, /HTTPS/)
  assert.equal(elements['#magnet'].value, 'magnet:?xt=urn:btih:test')
  assert.equal(elements['#seed'].disabled, true)
})
