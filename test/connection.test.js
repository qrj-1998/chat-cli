'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { ChatCli } = require('../cli.js')

function createClient(t) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-chat-cli-test-'))
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }))
  const sockets = []
  const cli = new ChatCli({
    serverUrl: 'http://localhost:3000',
    configDir,
    fingerprintOverride: 'test-device',
    webSocketFactory() {
      const socket = {
        readyState: 0,
        sent: [],
        send(data) { this.sent.push(JSON.parse(data)) },
        close() {
          if (this.readyState === 3) return
          this.readyState = 3
          queueMicrotask(() => this.onclose())
        },
        open() {
          this.readyState = 1
          this.onopen()
        },
        welcome() {
          this.onmessage({ data: JSON.stringify({
            type: 'welcome', known: true, user: { id: 1, nickname: 'Tester' },
            recent: [], latestMessageId: 0
          }) })
        }
      }
      sockets.push(socket)
      return socket
    }
  })
  return { cli, sockets }
}

test('握手失败通过 connect Promise 返回，关闭事件不会重复上报', async (t) => {
  const { cli, sockets } = createClient(t)
  let closed = 0
  cli.on('closed', () => { closed += 1 })

  const connecting = cli.connect()
  sockets[0].onerror()
  await assert.rejects(connecting, /WebSocket 连接失败/)
  await Promise.resolve()

  assert.equal(cli.state, 'closed')
  assert.equal(closed, 0)
})

test('已连接的 socket 出错后可重新连接，旧 socket 事件被忽略', async (t) => {
  const { cli, sockets } = createClient(t)
  let closed = 0
  cli.on('closed', () => { closed += 1 })

  const first = cli.connect()
  sockets[0].open()
  sockets[0].welcome()
  await first

  sockets[0].onerror()
  await Promise.resolve()
  assert.equal(closed, 1)
  assert.equal(cli.state, 'closed')
  assert.equal(cli.say('offline'), null)

  const second = cli.connect()
  sockets[1].open()
  sockets[1].welcome()
  await second
  sockets[0].onerror()

  assert.equal(cli.state, 'chatting')
  assert.equal(closed, 1)
  cli.close()
  await Promise.resolve()
  assert.equal(closed, 1)
})

test('握手超时会关闭 socket 并清理连接状态', async (t) => {
  const { cli, sockets } = createClient(t)
  await assert.rejects(cli.connect({ timeoutMs: 1 }), /握手超时/)
  await Promise.resolve()
  assert.equal(sockets[0].readyState, 3)
  assert.equal(cli.state, 'closed')
})
