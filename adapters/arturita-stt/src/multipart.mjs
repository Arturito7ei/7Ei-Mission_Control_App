// Arturita STT bridge — minimal, zero-dep multipart/form-data parser.
//
// The browser posts captured mic audio as multipart/form-data (a `file` part,
// plus optional text fields like `model`/`language`). We only need to pull the
// first file part out, so this is a small boundary splitter — NOT a general RFC
// 7578 implementation, but correct for the shapes MediaRecorder + fetch produce.
// Pure (Buffer in → parsed parts out); unit-tested.

/** Extract the boundary token from a Content-Type header. Returns '' if absent. */
export function boundaryOf(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''))
  return m ? (m[1] || m[2] || '').trim() : ''
}

/** Index of `needle` in `buf` at or after `from`, or -1. */
function indexOf(buf, needle, from = 0) {
  return buf.indexOf(needle, from)
}

/**
 * Parse a multipart/form-data body. Returns `{ fields, files }` where each file
 * is `{ name, filename, contentType, data: Buffer }`. Throws on a missing/blank
 * boundary or a body with no parts. Pure.
 */
export function parseMultipart(body, contentType) {
  const boundary = boundaryOf(contentType)
  if (!boundary) throw new Error('missing multipart boundary')
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const delim = Buffer.from(`--${boundary}`)
  const fields = {}
  const files = []

  let pos = indexOf(buf, delim, 0)
  if (pos < 0) throw new Error('no multipart parts found')
  pos += delim.length

  while (pos < buf.length) {
    // After a delimiter: either "--" (final) or CRLF then the part.
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break // closing "--"
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2 // skip CRLF

    // Headers end at the first blank line (CRLF CRLF).
    const headEnd = indexOf(buf, Buffer.from('\r\n\r\n'), pos)
    if (headEnd < 0) break
    const rawHeaders = buf.slice(pos, headEnd).toString('utf8')
    const bodyStart = headEnd + 4

    // Next delimiter marks the end of this part's content (minus the trailing CRLF).
    const next = indexOf(buf, delim, bodyStart)
    if (next < 0) break
    let contentEnd = next
    if (buf[contentEnd - 2] === 0x0d && buf[contentEnd - 1] === 0x0a) contentEnd -= 2
    const data = buf.slice(bodyStart, contentEnd)

    const disp = /content-disposition:[^\r\n]*/i.exec(rawHeaders)?.[0] || ''
    const name = /name="([^"]*)"/i.exec(disp)?.[1] || ''
    const filename = /filename="([^"]*)"/i.exec(disp)?.[1]
    const ctype = /content-type:\s*([^\r\n]+)/i.exec(rawHeaders)?.[1]?.trim() || 'application/octet-stream'

    if (filename !== undefined) {
      files.push({ name, filename, contentType: ctype, data })
    } else {
      fields[name] = data.toString('utf8')
    }
    pos = next + delim.length
  }
  return { fields, files }
}
