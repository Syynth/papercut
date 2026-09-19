/**
 * Aseprite's pixel blenders, ported from `src/doc/blend_funcs.cpp` and the
 * pixman macros it builds on, so a frame rendered here matches Aseprite's own
 * render to the bit — rounding, integer truncation and quirks included.
 *
 * Aseprite's `doc` library is MIT-licensed:
 *   Copyright (c) 2018-present Igara Studio S.A.
 *   Copyright (c) 2001-2018 David Capello
 * The notice is reproduced in this package's LICENSE.
 *
 * A colour is packed as Aseprite packs it: red in the low byte, then green,
 * blue, and alpha in the high byte, as an unsigned 32-bit number.
 *
 * These are the "new blend" variants (the `_n` functions), Aseprite's default
 * for rendering: blend modes other than normal fade toward normal where the
 * backdrop is transparent, instead of blending against transparent black.
 */

import type { BlendMode } from '@papercut/aseprite'

export type Color = number

export type Blender = (backdrop: Color, src: Color, opacity: number) => Color

export const getR = (c: Color): number => c & 0xff
export const getG = (c: Color): number => (c >>> 8) & 0xff
export const getB = (c: Color): number => (c >>> 16) & 0xff
export const getA = (c: Color): number => c >>> 24

export const rgba = (r: number, g: number, b: number, a: number): Color => ((r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16) | ((a & 0xff) << 24)) >>> 0

const RGB_MASK = 0x00ffffff

/** pixman's MUL_UN8: a·b/255, rounded the way pixman rounds it. `a` may be negative (as in `merge`). */
export function mul(a: number, b: number): number {
  const t = a * (b & 0xffff) + 0x80
  return ((t >> 8) + t) >> 8
}

/** pixman's DIV_UN8: a·255/b, rounded to nearest. */
function div(a: number, b: number): number {
  return Math.floor(((a & 0xffff) * 0xff + Math.floor(b / 2)) / b)
}

// Per-channel blend functions (b = backdrop, s = source), 0–255.

const multiply = (b: number, s: number): number => mul(b, s)
const screen = (b: number, s: number): number => b + s - mul(b, s)
const hardLight = (b: number, s: number): number => (s < 128 ? multiply(b, s << 1) : screen(b, (s << 1) - 255))
const overlay = (b: number, s: number): number => hardLight(s, b)
const darken = (b: number, s: number): number => Math.min(b, s)
const lighten = (b: number, s: number): number => Math.max(b, s)
const difference = (b: number, s: number): number => Math.abs(b - s)
const exclusion = (b: number, s: number): number => b + s - 2 * mul(b, s)
const addition = (b: number, s: number): number => Math.min(b + s, 255)
const subtract = (b: number, s: number): number => Math.max(b - s, 0)

function divide(b: number, s: number): number {
  if (b === 0) return 0
  if (b >= s) return 255
  return div(b, s)
}

function colorDodge(b: number, s: number): number {
  if (b === 0) return 0
  const inverse = 255 - s
  if (b >= inverse) return 255
  return div(b, inverse)
}

function colorBurn(b: number, s: number): number {
  if (b === 255) return 255
  const inverse = 255 - b
  if (inverse >= s) return 0
  return 255 - div(inverse, s)
}

function softLight(bi: number, si: number): number {
  const b = bi / 255
  const s = si / 255
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)
  const r = s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (d - b)
  return Math.trunc(r * 255 + 0.5)
}

/** Source-over, with the source's alpha scaled by `opacity`. */
export function normal(backdrop: Color, src: Color, opacity: number): Color {
  if (getA(backdrop) === 0) {
    const a = mul(getA(src), opacity)
    return ((src & RGB_MASK) | (a << 24)) >>> 0
  }
  if (getA(src) === 0) return backdrop
  const Br = getR(backdrop)
  const Bg = getG(backdrop)
  const Bb = getB(backdrop)
  const Ba = getA(backdrop)
  const Sa = mul(getA(src), opacity)
  const Ra = Sa + Ba - mul(Ba, Sa)
  // C integer division: truncate toward zero.
  const Rr = Br + Math.trunc(((getR(src) - Br) * Sa) / Ra)
  const Rg = Bg + Math.trunc(((getG(src) - Bg) * Sa) / Ra)
  const Rb = Bb + Math.trunc(((getB(src) - Bb) * Sa) / Ra)
  return rgba(Rr, Rg, Rb, Ra)
}

/** Linear interpolation from backdrop to source by `opacity`, alpha included. */
export function merge(backdrop: Color, src: Color, opacity: number): Color {
  const Ba = getA(backdrop)
  const Sa = getA(src)
  let Rr: number
  let Rg: number
  let Rb: number
  if (Ba === 0) {
    Rr = getR(src)
    Rg = getG(src)
    Rb = getB(src)
  } else if (Sa === 0) {
    Rr = getR(backdrop)
    Rg = getG(backdrop)
    Rb = getB(backdrop)
  } else {
    Rr = getR(backdrop) + mul(getR(src) - getR(backdrop), opacity)
    Rg = getG(backdrop) + mul(getG(src) - getG(backdrop), opacity)
    Rb = getB(backdrop) + mul(getB(src) - getB(backdrop), opacity)
  }
  const Ra = Ba + mul(Sa - Ba, opacity)
  if (Ra === 0) Rr = Rg = Rb = 0
  return rgba(Rr, Rg, Rb, Ra)
}

/** An old-style blender: blend the colour channels, keep the source alpha, then source-over. */
function channelwise(f: (b: number, s: number) => number): Blender {
  return (backdrop, src, opacity) => {
    const blended = rgba(f(getR(backdrop), getR(src)), f(getG(backdrop), getG(src)), f(getB(backdrop), getB(src)), 0)
    return normal(backdrop, (blended | (src & 0xff000000)) >>> 0, opacity)
  }
}

// The non-separable (HSL) modes work in 0–1 doubles, as Aseprite does.

const lum = (r: number, g: number, b: number): number => 0.3 * r + 0.59 * g + 0.11 * b
const sat = (r: number, g: number, b: number): number => Math.max(r, g, b) - Math.min(r, g, b)

type Rgb = [number, number, number]

function clipColor([r, g, b]: Rgb): Rgb {
  const l = lum(r, g, b)
  const n = Math.min(r, g, b)
  const x = Math.max(r, g, b)
  if (n < 0) {
    r = l + ((r - l) * l) / (l - n)
    g = l + ((g - l) * l) / (l - n)
    b = l + ((b - l) * l) / (l - n)
  }
  if (x > 1) {
    r = l + ((r - l) * (1 - l)) / (x - l)
    g = l + ((g - l) * (1 - l)) / (x - l)
    b = l + ((b - l) * (1 - l)) / (x - l)
  }
  return [r, g, b]
}

function setLum([r, g, b]: Rgb, l: number): Rgb {
  const d = l - lum(r, g, b)
  return clipColor([r + d, g + d, b + d])
}

function setSat([r, g, b]: Rgb, s: number): Rgb {
  const min = Math.min(r, g, b)
  const max = Math.max(r, g, b)
  const range = max - min
  if (range > 0) return [((r - min) * s) / range, ((g - min) * s) / range, ((b - min) * s) / range]
  return [0, 0, 0]
}

const unit = (c: Color): Rgb => [getR(c) / 255, getG(c) / 255, getB(c) / 255]

function hsl(f: (backdrop: Rgb, src: Rgb) => Rgb): Blender {
  return (backdrop, src, opacity) => {
    const [r, g, b] = f(unit(backdrop), unit(src))
    const blended = rgba(Math.trunc(255 * r), Math.trunc(255 * g), Math.trunc(255 * b), 0)
    return normal(backdrop, (blended | (src & 0xff000000)) >>> 0, opacity)
  }
}

const hue = hsl((b, s) => setLum(setSat(s, sat(...b)), lum(...b)))
const saturation = hsl((b, s) => setLum(setSat(b, sat(...s)), lum(...b)))
const color = hsl((b, s) => setLum(s, lum(...b)))
const luminosity = hsl((b, s) => setLum(b, lum(...s)))

/**
 * Aseprite's "new blend" wrapper: where the backdrop has alpha, fade from
 * normal toward the mode by the backdrop's alpha, then by the composite
 * alpha; where it has none, plain normal.
 */
function newBlend(blend: Blender): Blender {
  return (backdrop, src, opacity) => {
    const Ba = getA(backdrop)
    if (Ba === 0) return normal(backdrop, src, opacity)
    const blended = blend(backdrop, src, opacity)
    const normalToBlend = merge(normal(backdrop, src, opacity), blended, Ba)
    const compositeAlpha = mul(Ba, mul(getA(src), opacity))
    return merge(normalToBlend, blended, compositeAlpha)
  }
}

const RGBA_BLENDERS: Record<BlendMode, Blender> = {
  normal,
  multiply: newBlend(channelwise(multiply)),
  screen: newBlend(channelwise(screen)),
  overlay: newBlend(channelwise(overlay)),
  darken: newBlend(channelwise(darken)),
  lighten: newBlend(channelwise(lighten)),
  'color-dodge': newBlend(channelwise(colorDodge)),
  'color-burn': newBlend(channelwise(colorBurn)),
  'hard-light': newBlend(channelwise(hardLight)),
  'soft-light': newBlend(channelwise(softLight)),
  difference: newBlend(channelwise(difference)),
  exclusion: newBlend(channelwise(exclusion)),
  hue: newBlend(hue),
  saturation: newBlend(saturation),
  color: newBlend(color),
  luminosity: newBlend(luminosity),
  addition: newBlend(channelwise(addition)),
  subtract: newBlend(channelwise(subtract)),
  divide: newBlend(channelwise(divide)),
}

/**
 * Grayscale sprites blend with Aseprite's grey table, which differs from the
 * RGB one in two places: the HSL modes fall back to normal (grey has no hue),
 * and new-blend addition is exclusion — a quirk of Aseprite's table, kept so
 * the output matches. Every other grey blender is the RGB one on equal
 * channels, so the RGB functions serve.
 */
const GRAY_BLENDERS: Record<BlendMode, Blender> = {
  ...RGBA_BLENDERS,
  hue: normal,
  saturation: normal,
  color: normal,
  luminosity: normal,
  addition: RGBA_BLENDERS.exclusion,
}

/** The blender Aseprite uses for `mode`, in a sprite of the given colour mode. */
export function blenderFor(mode: BlendMode, grayscale = false): Blender {
  return (grayscale ? GRAY_BLENDERS : RGBA_BLENDERS)[mode]
}
