import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ramLimitBytes } from '../public/p2p/ram-limits.js'

test('browser RAM accepts only integer MB from 500 through 2048', () => {
  for (const value of [500, '500', 501, 1024, 2048, '2048']) assert.equal(ramLimitBytes(value), Number(value) * 1024 ** 2)
  for (const value of ['', null, undefined, NaN, Infinity, -1, 0, 128, 499, 500.5, 2049, 5000, '2048abc']) assert.throws(() => ramLimitBytes(value), /500.*2048/)
})

test('embedded player exposes a constrained range instead of unrestricted numeric entry', () => {
  for (const file of ['compact-player.js']) {
    const source = readFileSync(new URL(`../public/p2p/${file}`, import.meta.url), 'utf8')
    assert.match(source, /id="ram" type="range" min="500" max="2048" step="1" value="500"/)
  }
  const app = readFileSync(new URL('../public/p2p/app.js', import.meta.url), 'utf8')
  assert.match(app, /async function prepare \(\) \{[\s\S]*?ramLimitBytes\(\$\('#ram'\)\.value\)[\s\S]*?await stop\(\)/)
})
