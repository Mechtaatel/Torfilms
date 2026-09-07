import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

test('isolated server serves UI and validates RAM settings', { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, TORFILMS_PORT: '0' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  const exited = once(child, 'exit')
  try {
    const base = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => reject(new Error(output)))
      child.stdout.on('data', chunk => {
        output += chunk
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/)
        if (match) resolve(match[0])
      })
      child.stderr.on('data', chunk => { output += chunk })
    })
    const html = await fetch(base)
    assert.match(await html.text(), /preload="auto"/)
    const css = await fetch(base + '/styles.css')
    assert.match(css.headers.get('content-type'), /text\/css/)
    assert.match(await css.text(), /cursor: none/)
    const post = memoryMb => fetch(base + '/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memoryMb })
    })
    assert.equal((await post('Infinity')).status, 400)
    assert.equal((await post(2048)).status, 200)
    const state = await (await fetch(base + '/api/state')).json()
    assert.equal(state.memoryMb, 2048)
    assert.deepEqual(state.torrents, [])
  } finally {
    child.kill()
    await exited
  }
})
