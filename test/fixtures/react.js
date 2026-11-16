/**
 * Just enough React to render one function component in Node.
 *
 * The Client half is a browser artifact: it asks the module table for `react`
 * and calls hooks. That makes it the one file the plugin's own test suite could
 * not reach, which is exactly the file where a broken save path would hide. So
 * instead of skipping it, this fixture supplies the four things the component
 * actually uses — `createElement`, `useState`, `useEffect`, and `createContext`
 * (unused but requested by nothing) — and a renderer that drives them the way a
 * real one does: render, run effects, re-render on a state write, and repeat
 * until quiet.
 *
 * It is deliberately not a reconciler. There is no diffing, no commit phase, and
 * no DOM: `createElement` returns a plain object tree the tests walk directly.
 * Anything that needs the real thing (layout, refs, events) is not what these
 * tests assert.
 *
 * @module dsh-connect-comate/test/fixtures/react
 */

/** The instance currently rendering, or `null` outside a render. */
let rendering = null

/**
 * Build a plain element node.
 *
 * @param type - a tag name or a function component.
 * @param props - element props, or `null`.
 * @param children - variadic children.
 * @returns a node the tests can inspect.
 */
export function createElement(type, props, ...children) {
  const flat = []
  const push = (value) => {
    if (value === null || value === undefined || value === false || value === true) return
    if (Array.isArray(value)) {
      for (const entry of value) push(entry)
      return
    }
    flat.push(value)
  }
  for (const child of children) push(child)
  return { type, props: props ?? {}, children: flat }
}

/**
 * Read (and remember) one state cell.
 *
 * @param initial - the initial value, or a function producing it.
 * @returns `[value, setValue]`.
 */
export function useState(initial) {
  const instance = rendering
  if (instance === null) throw new Error('useState was called outside a render')
  const index = instance.cursor
  instance.cursor += 1
  if (!(index in instance.cells)) {
    instance.cells[index] = typeof initial === 'function' ? initial() : initial
  }
  const setValue = (next) => {
    const previous = instance.cells[index]
    const value = typeof next === 'function' ? next(previous) : next
    if (Object.is(previous, value)) return
    instance.cells[index] = value
    instance.dirty = true
  }
  return [instance.cells[index], setValue]
}

/**
 * Record an effect for after the current render.
 *
 * Dependencies are compared by serialized value, which is what these components
 * pass (`[reloads]`), and an empty dependency list runs once.
 *
 * @param fn - the effect body; a returned function is kept as its cleanup.
 * @param deps - dependency list.
 */
export function useEffect(fn, deps) {
  const instance = rendering
  if (instance === null) throw new Error('useEffect was called outside a render')
  const index = instance.cursor
  instance.cursor += 1
  const key = deps === undefined ? null : JSON.stringify(deps)
  const previous = instance.effects[index]
  if (previous !== undefined && previous.key === key) return
  instance.effects[index] = { key, fn, cleanup: previous?.cleanup }
}

/**
 * A component instance whose cells survive re-renders.
 *
 * @param Component - the function component.
 * @param props - props to pass on every render.
 * @returns a mounted, settled instance.
 */
export async function mount(Component, props) {
  const instance = {
    Component,
    props,
    cells: [],
    cursor: 0,
    effects: [],
    dirty: false,
    tree: undefined,
    renders: 0,
  }

  const run = () => {
    instance.cursor = 0
    instance.dirty = false
    rendering = instance
    try {
      instance.tree = instance.Component(instance.props)
    } finally {
      rendering = null
    }
    instance.renders += 1
  }

  const flushEffects = () => {
    const pending = []
    for (const record of instance.effects) {
      if (record === undefined || record.ran === true) continue
      record.ran = true
      const cleanup = record.fn()
      record.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      pending.push(record)
    }
    return pending
  }

  const settle = async () => {
    for (let pass = 0; pass < 20; pass += 1) {
      run()
      flushEffects()
      // Let the promises an effect started resolve before deciding whether the
      // tree is stable; a fetch answered synchronously still needs one tick.
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve()
      if (!instance.dirty) return instance
    }
    throw new Error('the component did not settle after 20 renders')
  }

  const rerender = async () => {
    return settle()
  }

  instance.settle = settle
  instance.rerender = rerender
  // A real renderer flushes passive effects itself. Doing it here means a test
  // can assert on the tree `mount` returned without knowing about `settle`.
  await settle()
  return instance
}

/**
 * Walk a node tree and collect every element matching a predicate.
 *
 * Components are called as plain functions only through `mount`; here they are
 * treated as opaque so a test can assert "the section rendered a checkbox" by
 * tag name rather than by re-rendering internals.
 *
 * @param node - the root node.
 * @param predicate - receives each element.
 * @returns every matching element, depth first.
 */
export function findAll(node, predicate) {
  const found = []
  const walk = (value) => {
    if (value === null || value === undefined || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry)
      return
    }
    if (typeof value.type === 'string' && predicate(value)) found.push(value)
    for (const child of value.children ?? []) walk(child)
  }
  walk(node)
  return found
}

/**
 * Collect the visible text of a tree.
 *
 * @param node - the root node.
 * @returns the concatenated string and number children.
 */
export function textOf(node) {
  const parts = []
  const walk = (value) => {
    if (value === null || value === undefined || typeof value === 'boolean') return
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value))
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry)
      return
    }
    for (const child of value.children ?? []) walk(child)
  }
  walk(node)
  return parts.join('')
}

export default { createElement, useState, useEffect }
