import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

test('season buttons switch in-place, keep IMDb URL and do nothing on current season', () => {
  const source = readFileSync(new URL('../public/p2p/catalog-app.js', import.meta.url), 'utf8')
  const loop = source.slice(source.indexOf('for (const item of seasons) {'), source.indexOf("content.append(node('h2', 'Сезоны'), strip)"))
  const buttons = [], calls = [], changes = []
  const context = {
    seasons: [{ number: 0, title: 'Bonus' }, { number: '1.2', title: 'Season' }], season: { number: 0 }, movie: { id: 'tt6424454' }, id: 'tt6424454', activePlayer: {},
    seasonKey: String, filmUrl: id => `/Torfilms/${id}`, cover: () => ({}),
    node: () => ({ setAttribute () {}, append () {} }), strip: { append: button => buttons.push(button) },
    history: { state: {}, replaceState: (state, _, url) => changes.push({ state, url }) }, render: options => calls.push(options)
  }
  vm.runInNewContext(loop, context)
  buttons[0].onclick(); assert.equal(calls.length, 0)
  buttons[1].onclick()
  assert.equal(changes[0].url, '/Torfilms/tt6424454')
  assert.equal(changes[0].state.season, '1.2')
  assert.equal(calls[0].autoplay, true)
  assert.equal(buttons[1].type, 'button')
  assert.equal(buttons[1].href, undefined)
})
