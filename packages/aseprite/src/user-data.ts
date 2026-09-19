/**
 * The User Data chunk (0x2020): text, a colour, and typed property maps.
 */

import { AsepriteError, type Reader } from './reader'
import type { PropertyMap, PropertyValue, UserData } from './types'

const HAS_TEXT = 1
const HAS_COLOR = 2
const HAS_PROPERTIES = 4

/** The spec caps nesting of vectors and maps at 128 levels. */
const MAX_DEPTH = 128

/** `warn` hears about property data this reader could not interpret; what came before it is kept. */
export function readUserData(r: Reader, warn: (message: string) => void): UserData {
  const flags = r.dword()
  const text = flags & HAS_TEXT ? r.string() : null
  const color = flags & HAS_COLOR ? { r: r.byte(), g: r.byte(), b: r.byte(), a: r.byte() } : null
  const properties = new Map<number, PropertyMap>()
  if (flags & HAS_PROPERTIES) {
    const start = r.offset
    const size = r.dword()
    const end = start + size
    if (size < 8 || end > r.limit) throw new AsepriteError(`User data properties claim ${size} bytes`, start)
    const limit = r.limit
    r.limit = end
    try {
      const count = r.dword()
      for (let i = 0; i < count; i++) {
        const key = r.dword()
        properties.set(key, readPropertyMap(r, 0))
      }
    } catch (error) {
      if (!(error instanceof AsepriteError)) throw error
      warn(`Some user data properties were skipped: ${error.message}`)
    }
    // Trust the declared size over what was parsed, so an unknown property
    // type in a newer file cannot desynchronise the chunks that follow.
    r.limit = limit
    r.offset = end
  }
  return { text, color, properties }
}

function readPropertyMap(r: Reader, depth: number): PropertyMap {
  if (depth > MAX_DEPTH) throw new AsepriteError('User data properties nest deeper than 128 levels', r.offset)
  const map: PropertyMap = new Map()
  const count = r.dword()
  for (let i = 0; i < count; i++) {
    const name = r.string()
    const type = r.word()
    map.set(name, readValue(r, type, depth))
  }
  return map
}

function readValue(r: Reader, type: number, depth: number): PropertyValue {
  switch (type) {
    case 0x01:
      return { type: 'bool', value: r.byte() !== 0 }
    case 0x02: {
      const v = r.byte()
      return { type: 'int8', value: v > 127 ? v - 256 : v }
    }
    case 0x03:
      return { type: 'uint8', value: r.byte() }
    case 0x04:
      return { type: 'int16', value: r.short() }
    case 0x05:
      return { type: 'uint16', value: r.word() }
    case 0x06:
      return { type: 'int32', value: r.long() }
    case 0x07:
      return { type: 'uint32', value: r.dword() }
    case 0x08:
      return { type: 'int64', value: r.long64() }
    case 0x09:
      return { type: 'uint64', value: r.qword() }
    case 0x0a:
      return { type: 'fixed', value: r.fixed() }
    case 0x0b:
      return { type: 'float', value: r.float() }
    case 0x0c:
      return { type: 'double', value: r.double() }
    case 0x0d:
      return { type: 'string', value: r.string() }
    case 0x0e:
      return { type: 'point', value: { x: r.long(), y: r.long() } }
    case 0x0f:
      return { type: 'size', value: { width: r.long(), height: r.long() } }
    case 0x10:
      return { type: 'rect', value: { x: r.long(), y: r.long(), width: r.long(), height: r.long() } }
    case 0x11: {
      if (depth + 1 > MAX_DEPTH) throw new AsepriteError('User data properties nest deeper than 128 levels', r.offset)
      const count = r.dword()
      const elementType = r.word()
      const value: PropertyValue[] = []
      for (let i = 0; i < count; i++) value.push(readValue(r, elementType === 0 ? r.word() : elementType, depth + 1))
      return { type: 'vector', value }
    }
    case 0x12:
      return { type: 'map', value: readPropertyMap(r, depth + 1) }
    case 0x13:
      return { type: 'uuid', value: r.bytesOf(16) }
    default:
      throw new AsepriteError(`Unknown user data property type 0x${type.toString(16)}`, r.offset - 2)
  }
}
