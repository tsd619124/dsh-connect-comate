/**
 * Guards for the plugin's HTTP routes.
 *
 * The routes are read-only, but they still answer questions a browser page has
 * no business asking: whether the user is signed in, under which account, and
 * how much of the daily allowance is left. A page served from any origin can
 * issue a cross-origin `fetch` to `127.0.0.1`; the browser withholds the
 * *response* only if the server says so, and DNS rebinding defeats the usual
 * "it is on loopback so it must be fine" reasoning entirely.
 *
 * So the routes check the two headers a browser must send honestly:
 *
 * - `Host` must name this machine. A rebound domain (`evil.example` resolving to
 *   `127.0.0.1`) arrives with its own name in `Host`, so this is what catches it.
 * - `Origin`, when present at all, must name this machine too.
 *
 * A request with no `Origin` passes: that is the shape of a non-browser client —
 * the plugin's own fetch, `curl`, the test suite — and refusing it would break
 * the legitimate callers while stopping no attacker, who controls their headers
 * anyway. This mirrors the rule the sibling provider plugins use.
 *
 * @module dsh-connect-comate/guards
 */

import { isIP } from 'node:net'

/** Hostnames that always mean "this machine". */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * Strip the port from a `Host` header value.
 *
 * @param host - the header value, possibly `host:port`.
 * @returns the hostname portion.
 */
function hostnameOfHost(host) {
  const trimmed = host.trim()
  if (trimmed.startsWith('[')) {
    const closing = trimmed.indexOf(']')
    return closing < 0 ? trimmed : trimmed.slice(0, closing + 1)
  }
  const colon = trimmed.indexOf(':')
  return colon < 0 ? trimmed : trimmed.slice(0, colon)
}

/**
 * Whether a hostname names the local machine.
 *
 * @param hostname - a bare hostname, possibly bracketed for IPv6.
 * @returns `true` when it is loopback.
 */
function isLocalHostname(hostname) {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase())
}

/**
 * Whether a `Host` header is consistent with the socket it arrived on.
 *
 * @param host - the `Host` header, if any.
 * @param localAddress - the address the socket is bound to.
 * @returns `true` when the request may proceed.
 */
function hostMatchesListener(host, localAddress) {
  if (host === undefined || host.trim() === '') return false
  const hostname = hostnameOfHost(host)
  if (isLocalHostname(hostname)) return true
  // A wildcard bind is reachable from the network, so a loopback-looking name is
  // not enough to trust it.
  if (hostname === '0.0.0.0' || hostname === '[::]') return false
  if (localAddress === undefined || localAddress.trim() === '') return false

  const local = localAddress.trim().toLowerCase()
  if (isIP(local) === 0 && isIP(`[${local}]`) === 0) return false

  // Compare bare addresses so `::1` and `[::1]` are the same machine.
  const bare = (value) => (value.startsWith('[') && value.endsWith(']') && isIP(value.slice(1, -1)) === 6
    ? value.slice(1, -1)
    : value)
  return bare(hostname) === bare(local)
}

/**
 * Whether a browser-sent `Origin` may drive this route.
 *
 * @param origin - the `Origin` header, if any.
 * @param localAddress - the address the socket is bound to.
 * @returns `true` when the request may proceed.
 */
function originIsLoopback(origin, localAddress) {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    if (isLocalHostname(hostname)) return true
    return hostMatchesListener(hostname, localAddress)
  } catch {
    return false
  }
}

/**
 * Reject a request that did not come from this machine.
 *
 * Writes the refusal itself, so a caller only has to branch on the result.
 *
 * @param req - the incoming request.
 * @param res - the response to refuse on.
 * @returns `true` when the request may proceed.
 */
export function requireLoopback(req, res) {
  if (!hostMatchesListener(req.headers.host, req.socket?.localAddress)) {
    sendJson(res, { error: 'host-not-trusted' }, 403)
    return false
  }
  if (!originIsLoopback(req.headers.origin, req.socket?.localAddress)) {
    sendJson(res, { error: 'origin-not-trusted' }, 403)
    return false
  }
  return true
}

/**
 * Reject any method but the one a route declares.
 *
 * @param req - the incoming request.
 * @param res - the response to refuse on.
 * @param allowed - the method this route answers.
 * @returns `true` when the method matches.
 */
export function requireMethod(req, res, allowed) {
  if (req.method === allowed) return true
  res.setHeader('allow', allowed)
  sendJson(res, { error: 'method not allowed' }, 405)
  return false
}

/**
 * Write one JSON response.
 *
 * @param res - the response to complete.
 * @param value - JSON-serializable body.
 * @param status - HTTP status, 200 by default.
 */
export function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
