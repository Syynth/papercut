import { describe, expect, it } from 'vitest'

import { DEFAULT_LIMIT_BYTES, oversizedChunks, parseLimit } from './check-bundle-size.mjs'

// The exact regression this exists for (#57): a chunk regrows past the
// ceiling and nothing in the gate goes red. Sizes are written relative to
// DEFAULT_LIMIT_BYTES rather than as literals, so raising the ceiling does not
// silently turn these into tests of nothing. This exercises the pure decision
// function directly rather than a real `vite build`, so it stays fast and does
// not need a checked-in oversized fixture bundle.
describe('oversizedChunks', () => {
  it('flags a chunk over the ceiling', () => {
    const sizes = [{ file: 'vendor-three-abcd1234.js', bytes: DEFAULT_LIMIT_BYTES + 1 }]

    expect(oversizedChunks(sizes)).toEqual(sizes)
  })

  it('passes chunks at or under the ceiling', () => {
    const sizes = [{ file: 'index-abcd1234.js', bytes: DEFAULT_LIMIT_BYTES }]

    expect(oversizedChunks(sizes)).toEqual([])
  })

  it('reports only the offenders out of a mixed build', () => {
    const small = { file: 'index-abcd1234.js', bytes: 89_000 }
    const big = { file: 'vendor-three-abcd1234.js', bytes: DEFAULT_LIMIT_BYTES * 2 }

    expect(oversizedChunks([small, big])).toEqual([big])
  })
})

describe('parseLimit', () => {
  it('falls back to the default when no CLI argument is given', () => {
    expect(parseLimit(undefined)).toBe(DEFAULT_LIMIT_BYTES)
  })

  it('accepts a valid numeric argument', () => {
    expect(parseLimit('123456')).toBe(123456)
  })

  // The exact regression this exists for: `Number('500kB')` is `NaN`, and
  // `bytes > NaN` is always false in `oversizedChunks`, so a malformed limit
  // used to make the whole check exit 0 silently instead of failing loud.
  it('rejects a non-numeric argument instead of silently disabling the check', () => {
    expect(() => parseLimit('500kB')).toThrow(/invalid limit-bytes argument/)
  })

  it('rejects a non-positive argument', () => {
    expect(() => parseLimit('0')).toThrow(/invalid limit-bytes argument/)
    expect(() => parseLimit('-5')).toThrow(/invalid limit-bytes argument/)
  })
})
