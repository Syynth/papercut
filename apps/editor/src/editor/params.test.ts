import { describe, expect, it } from 'vitest'

import { SELECT_DEFAULTS } from '@papercut/editor-host'

import { mergeParams } from './params'

describe('mergeParams', () => {
  it('carries every host field, not a named few: a panel reading one the merge forgot would show nothing selected', () => {
    const merged = mergeParams({ tool: 'select', spriteName: 'rock', snap: 'half', ...SELECT_DEFAULTS, features: { sketch: { sketchSnap: 'free' } } })
    expect(merged.tool).toBe('select')
    expect(merged.spriteName).toBe('rock')
    expect(merged.snap).toBe('half')
    expect(merged.sketchSnap).toBe('free')
    expect(merged.features).toEqual({ sketch: { sketchSnap: 'free' } })
  })

  it('lets a feature slice sit beside the host fields without shadowing them', () => {
    const merged = mergeParams({ tool: 'terrain', spriteName: 'tree', snap: 'grid', ...SELECT_DEFAULTS, features: { rogue: { tool: 'nope', snap: 'free' } } })
    expect(merged.tool).toBe('terrain')
    expect(merged.snap).toBe('grid')
  })
})
