/**
 * Register the test module redirection.
 *
 * Usage: `node --import ./test/register-loader.mjs --test test/*.test.mjs`
 *
 * @module dsh-connect-comate/test/register-loader
 */
import { register } from 'node:module'

register('./loader.mjs', import.meta.url)

// Block the network for the whole run so a signed-in developer's machine cannot
// make the suite slow, flaky, or dependent on live Comate state.
await import('./setup.mjs')
