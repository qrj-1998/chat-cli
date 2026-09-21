'use strict'
/**
 * 终端渲染：颜色、换行、消息排版。
 *
 * 不做全屏 TUI（那会引入一大堆终端兼容问题），走"行模式"：
 * 收到消息就打印一段，输入行交给 readline 重绘。
 * 颜色在非 TTY（管道/重定向）下自动关闭，方便 `... | grep` 之类用法。
 */

const NO_COLOR = '\u001b[0m'

function makePainter(enabled) {
  const wrap = (code) => (text) => (enabled ? `\u001b[${code}m${text}${NO_COLOR}` : String(text))
  return {
    enabled,
    dim: wrap('2'),
    bold: wrap('1'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    blue: wrap('34'),
    magenta: wrap('35'),
    cyan: wrap('36'),
    gray: wrap('90')
  }
}

/** 终端显示宽度：CJK 与常见 emoji 占 2 列，避免中文换行错位。 */
function displayWidth(text) {
  let width = 0
  for (const char of String(text)) {
    const code = char.codePointAt(0)
    if (code === 0x0a || code === 0x0d) continue
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f9ff) ||
      (code >= 0x1f000 && code <= 0x1f2ff)
    width += wide ? 2 : 1
  }
  return width
}

function truncate(text, max) {
  let width = 0
  let out = ''
  for (const char of String(text)) {
    const charWidth = displayWidth(char)
    if (width + charWidth > max) break
    out += char
    width += charWidth
  }
  return out
}

/** 按显示宽度折行（保留 \n 段落）。 */
function wrapText(text, maxWidth) {
  const lines = []
  for (const paragraph of String(text).split('\n')) {
    if (!paragraph) {
      lines.push('')
      continue
    }
    let line = ''
    for (const char of paragraph) {
      const next = line + char
      if (displayWidth(next) > maxWidth) {
        lines.push(line)
        line = char
      } else {
        line = next
      }
    }
    lines.push(line)
  }
  return lines
}

function formatTime(ts) {
  const date = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function isEmojiOnly(text) {
  if (!text) return false
  const trimmed = String(text).trim()
  if (!trimmed) return false
  return /^[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\s]+$/u.test(trimmed) && Array.from(trimmed).length <= 8
}

/**
 * 把一条服务端消息渲染成若干行文本。
 * @param {object} message 服务端消息结构
 * @param {{selfId?: string, width?: number, painter: object, baseUrl?: string}} options
 */
function renderMessage(message, options) {
  const p = options.painter
  const width = Math.max(40, Math.min(options.width || 80, 200))
  const baseUrl = (options.baseUrl || '').replace(/\/$/, '')
  const lines = []

  if (message.kind === 'system') {
    lines.push(p.gray(`              · ${message.body}`))
    return lines
  }

  const mine = options.selfId && message.userId === options.selfId
  const who = mine ? p.green(p.bold(`${message.nickname}（我）`)) : p.cyan(p.bold(message.nickname || '匿名'))
  lines.push(`  ${p.gray(formatTime(message.createdAt))} ${who}`)

  if (message.body) {
    if (isEmojiOnly(message.body)) {
      lines.push(`    ${message.body}`)
    } else {
      for (const line of wrapText(message.body, width - 6)) lines.push(`    ${line}`)
    }
  }

  if (message.imageUrl) {
    const size = message.imageWidth && message.imageHeight ? `${message.imageWidth}×${message.imageHeight}` : '尺寸未知'
    const url = `${baseUrl}${message.imageUrl}`
    lines.push(`    ${p.magenta('🖼  图片')} ${p.gray(`(${size})`)}`)
    lines.push(`    ${p.blue(url)}`)
    // 提示只在第一条图片上出现，避免刷屏（调用方通过 showImageHint 控制）
    if (options.showImageHint) lines.push(`    ${p.gray('提示：/open 可以在浏览器里打开最近一张图片')}`)
  }

  return lines
}

/** 聊天记录的分隔线（按天）。 */
function renderDaySeparator(ts) {
  const date = new Date(ts)
  return `  ── ${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ──`
}

module.exports = {
  makePainter,
  renderMessage,
  renderDaySeparator,
  displayWidth,
  wrapText,
  truncate,
  formatTime,
  isEmojiOnly
}
