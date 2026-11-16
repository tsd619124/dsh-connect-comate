/**
 * Network guard for the test run.
 *
 * Two tests used to reach the real Comate hosts because the developer running
 * the suite is, correctly, signed in: `resolveModel` would call the model
 * roster, and the credential test would spawn `zulu serve`. That made the suite
 * slow and machine-dependent, and once a valid licence landed on disk one of
 * them hung outright.
 *
 * The guard blocks every non-loopback request. Loopback stays open on purpose:
 * the turn tests stand up a throwaway `http.createServer` and point the adapter
 * at it, which is the only way to exercise the SSE translation without Comate.
 *
 * @module dsh-connect-comate/test/setup
 */

const native = globalThis.fetch

/** Whether a URL points at this machine. */
function isLoopback(input) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
  if (typeof url !== 'string') return false
  try {
    const { hostname } = new URL(url)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

globalThis.fetch = async (input, init) => {
  if (!isLoopback(input)) {
    throw new Error(
      `dsh-connect-comate tests must not reach the network; blocked ${String(typeof input === 'string' ? input : input?.url ?? input)}`,
    )
  }
  return native(input, init)
}
