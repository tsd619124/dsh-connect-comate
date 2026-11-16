/**
 * Getting a picture into a Comate turn.
 *
 * `zulu serve` accepts `attachImages`, but only as a list of **already-uploaded
 * ids**: the array is resolved by `Xr()`, which short-circuits to
 * `{id, name: 'image-<id>', type: 'IMAGE'}` when the string matches `/^\d+$/`
 * and otherwise treats the entry as a local path and uploads it itself.
 *
 * That path-based upload is broken inside `serve`, and only inside `serve`. The
 * upload helper reads the login name as
 *
 *     const auth = pr().getAuthInfo()
 *     const loginName = auth?.authType === 'license' ? auth.license : auth.username
 *
 * and in a `serve` process `getAuthInfo()` reports an auth type that is not
 * `'license'` with an empty `username`, so the `login-name` header goes out
 * empty and the host answers `401 {"code":401,"message":"license为空"}`. The
 * same upload from the plugin — or from `zulu run` — succeeds, because those
 * paths did validate the licence and populate the auth context.
 *
 * So the split is: this module uploads with the licence in the header and
 * returns the numeric id; the request body then hands `serve` a plain number,
 * which it accepts without touching its own uploader.
 *
 * @module dsh-connect-comate/images
 */

/** Upload path on the Comate host; relative so the platform host stays in one place. */
const UPLOAD_PATH = '/api/aidevops/autocomate/rest/autowork/v1/file/upload'

/** How long one upload may take; pictures are small but the host can be slow. */
const UPLOAD_TIMEOUT_MS = 30_000

/** The largest picture this module will forward, in bytes. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * Whether a value is already an id `zulu serve` will accept verbatim.
 *
 * Mirrors the server's own test (`/^\d+$/` after `String(...).trim()`), because
 * the point is to hand it exactly the shape it short-circuits on.
 *
 * @param value - candidate id.
 * @returns `true` when the server would treat it as an id.
 */
export function isUploadedImageId(value) {
  return /^\d+$/.test(String(value).trim())
}

/**
 * Upload one picture and return the id the server accepts.
 *
 * @param options - the bytes, their media type, an optional file name, the
 *   credential, the host to call, and cancellation.
 * @returns the numeric id, as the string the request body carries.
 * @throws when the host rejects the upload or answers without an id.
 */
export async function uploadImage(options) {
  const { data, mediaType, credential, host, signal } = options
  if (credential === undefined) throw new Error('上传图片需要先登录 Comate')
  if (credential.kind !== 'license') {
    // The header this endpoint reads is the licence itself. An internal-edition
    // access token is not that value, so there is nothing honest to send.
    throw new Error('内部版（token 登录）暂不支持图片：Comate 的图片上传端点只认 license')
  }

  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data ?? [])
  if (bytes.length === 0) throw new Error('图片内容为空')
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片 ${String(bytes.length)} 字节，超过 ${String(MAX_IMAGE_BYTES)} 字节上限`)
  }

  const mime = typeof mediaType === 'string' && mediaType !== '' ? mediaType : 'image/png'
  const name = typeof options.name === 'string' && options.name.trim() !== ''
    ? options.name.trim()
    : `dsh-${Date.now()}.${extensionFor(mime)}`

  const body = {
    fileName: name,
    contentType: mime,
    // `Composer` is what the CLI sends for a chat attachment; `Chat` is also
    // accepted, so this is not load-bearing — it just matches the CLI.
    scene: 'Composer',
    fileData: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
    width: 0,
    height: 0,
  }

  const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
  const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(`${host}${UPLOAD_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Both spellings: the gateway reads either, and the CLI sends both.
      'login-name': credential.value,
      'Uuap-login-name': credential.value,
      ...(options.userAgent === undefined ? {} : { 'user-agent': options.userAgent }),
    },
    body: JSON.stringify(body),
    signal: composed,
  })

  if (!response.ok) {
    throw new Error(`图片上传失败：Comate 返回 HTTP ${String(response.status)}`)
  }
  const payload = await response.json().catch(() => undefined)
  const id = payload?.data?.id
  if (id === undefined || id === null || String(id).trim() === '') {
    const message = typeof payload?.message === 'string' && payload.message !== ''
      ? payload.message
      : `图片上传失败：Comate 没有返回图片 id（code ${String(payload?.code ?? 'unknown')}）`
    throw new Error(message)
  }
  return String(id).trim()
}

/**
 * A file extension matching a media type, used only to name the upload.
 *
 * @param mediaType - an `image/*` media type.
 * @returns a bare extension without the dot.
 */
function extensionFor(mediaType) {
  const subtype = mediaType.split('/')[1] ?? 'png'
  if (subtype === 'jpeg') return 'jpg'
  return subtype.replace(/[^a-z0-9]/gi, '') || 'png'
}
