'use strict'
/**
 * 本地会话存档：令牌 + 昵称。
 *
 * 存在 `~/.config/web-chat-cli/<主机>.json`，权限 600。
 * 令牌只是"快速通道"——服务端仍以设备指纹哈希为准（跟浏览器端同一套规则），
 * 所以就算这个文件被删了，只要是同一台机器，照样是免填昵称的老用户。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const APP_DIR_NAME = 'web-chat-cli'

function defaultConfigDir(env = process.env) {
  if (env.WEB_CHAT_CLI_HOME) return env.WEB_CHAT_CLI_HOME
  // 优先用传入的 HOME：容器/测试里 os.homedir() 取的是真实用户主目录，会绕开环境隔离
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config')
  return path.join(base, APP_DIR_NAME)
}

/** 每个服务端一份存档：连不同服务器不该互相覆盖身份。 */
function sessionFile(configDir, serverUrl) {
  const key = String(serverUrl)
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(configDir, `${key || 'default'}.json`)
}

function loadSession(configDir, serverUrl) {
  const file = sessionFile(configDir, serverUrl)
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data && typeof data === 'object') return { ...data, file }
  } catch {
    /* 不存在或损坏都当作新会话 */
  }
  return { token: null, nickname: null, userId: null, file }
}

function saveSession(configDir, serverUrl, patch) {
  const file = sessionFile(configDir, serverUrl)
  const current = loadSession(configDir, serverUrl)
  const next = { ...current, ...patch, file: undefined, savedAt: new Date().toISOString() }
  delete next.file
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    // 已存在的文件不会因为 mode 参数改权限，显式补一次
    fs.chmodSync(file, 0o600)
    return file
  } catch (err) {
    // 只读 HOME（容器里常见）时降级为内存态，不影响本次使用
    return null
  }
}

function clearSession(configDir, serverUrl) {
  try {
    fs.unlinkSync(sessionFile(configDir, serverUrl))
    return true
  } catch {
    return false
  }
}

module.exports = { defaultConfigDir, sessionFile, loadSession, saveSession, clearSession }
