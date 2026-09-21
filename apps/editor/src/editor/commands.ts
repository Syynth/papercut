/**
 * Dispatching from the UI: every region's buttons and fields go through the
 * host's `dispatch`, and these are the two things each of them needs around
 * it — reading a refusal, and routing a parameter change to the actor that
 * owns the parameter.
 */

import type { Host } from '@papercut/editor-host'

import type { EditorParams } from './params'

/** What a refusal says, flattened to one line; `null` when there was none. */
export function refusal(result: ReturnType<Host['dispatch']>): string | null {
  if (result.ok) return null
  return result.kind === 'invalid-args' ? result.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') : result.reason
}

/**
 * `dispatch` never throws (#8) — it answers with a result — so a refusal has
 * to be looked at or it is swallowed. Every call routed through here is the
 * app dispatching its own declared command with arguments it built, so a
 * refusal is a bug here rather than anything a user did; the one refusal a
 * user CAN cause, a malformed map file, is read off the result instead and
 * shown to them.
 */
export function run(host: Host, id: string, args?: unknown): void {
  const why = refusal(host.dispatch(id, args))
  if (why !== null) console.warn(`[editor] ${id} refused: ${why}`)
}

/** The one write verb the panels get, routed to the actor that owns the parameters: the host owns the tool, the sprite and the snap; the rest is the terrain feature's. */
export function setParams(host: Host, changes: Partial<EditorParams>): void {
  const { tool, spriteName, snap, selectMode, selectVerb, selectElement, selectFootprint, selectSize, selectDepth, selectCombine, selectFollowSlopes, selectMatch, selectEverywhere, selectStep, selectBand, selectAnyLayer, ...rest } = changes
  // The host's own fields, Select's among them; whatever was not set is left out, since the command's schema takes no `undefined`.
  const own = Object.fromEntries(Object.entries({ tool, spriteName, snap, selectMode, selectVerb, selectElement, selectFootprint, selectSize, selectDepth, selectCombine, selectFollowSlopes, selectMatch, selectEverywhere, selectStep, selectBand, selectAnyLayer }).filter(([, value]) => value !== undefined))
  if (Object.keys(own).length > 0) run(host, 'tools.set', own)
  if (Object.keys(rest).length > 0) run(host, 'terrain.params', rest)
}
