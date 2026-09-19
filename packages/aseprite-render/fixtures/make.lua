-- Builds the golden fixtures: .aseprite files, and Aseprite's own PNG of each
-- frame beside them. Run from the repo root with:
--   aseprite -b --script-param dir=packages/aseprite-render/fixtures --script packages/aseprite-render/fixtures/make.lua
-- The golden test (tests/aseprite-golden.test.ts) renders each file with
-- @papercut/aseprite-render and compares it with the PNG, pixel for pixel.

local dir = app.params["dir"]
local pc = app.pixelColor

local MODES = {
  BlendMode.NORMAL, BlendMode.MULTIPLY, BlendMode.SCREEN, BlendMode.OVERLAY,
  BlendMode.DARKEN, BlendMode.LIGHTEN, BlendMode.COLOR_DODGE, BlendMode.COLOR_BURN,
  BlendMode.HARD_LIGHT, BlendMode.SOFT_LIGHT, BlendMode.DIFFERENCE, BlendMode.EXCLUSION,
  BlendMode.HSL_HUE, BlendMode.HSL_SATURATION, BlendMode.HSL_COLOR, BlendMode.HSL_LUMINOSITY,
  BlendMode.ADDITION, BlendMode.SUBTRACT, BlendMode.DIVIDE,
}

-- A deterministic spread of values, so every band sees dark, light, and
-- translucent pixels on both sides of the blend.
local function v(x, y, k) return (x * 37 + y * 91 + k * 53) % 256 end
local function alpha(x, y, k)
  local a = (x * 29 + y * 17 + k * 71) % 5
  return ({ 0, 64, 128, 200, 255 })[a + 1]
end

local function save(sprite, name)
  sprite:saveAs(dir .. "/" .. name .. ".aseprite")
  sprite:saveCopyAs(dir .. "/" .. name .. "-{frame}.png")
  sprite:close()
end

-- Every blend mode, one 16×4 band each, over a varied translucent backdrop.
local function blendModes(colorMode, name)
  local W, BAND = 16, 4
  local s = Sprite(W, BAND * #MODES, colorMode)
  local function px(x, y, k)
    if colorMode == ColorMode.GRAYSCALE then return pc.graya(v(x, y, k), alpha(x, y, k)) end
    return pc.rgba(v(x, y, k), v(y, x, k + 1), v(x + y, x, k + 2), alpha(x, y, k))
  end
  local back = s.layers[1]
  back.name = "backdrop"
  local img = Image(W, BAND * #MODES, colorMode)
  for y = 0, img.height - 1 do for x = 0, img.width - 1 do img:drawPixel(x, y, px(x, y, 3)) end end
  s:newCel(back, 1, img, Point(0, 0))
  for i, mode in ipairs(MODES) do
    local l = s:newLayer()
    l.name = "mode " .. i
    l.blendMode = mode
    l.opacity = ({ 255, 200, 128 })[(i % 3) + 1]
    local top = Image(W, BAND, colorMode)
    for y = 0, BAND - 1 do for x = 0, W - 1 do top:drawPixel(x, y, px(x + i, y, i)) end end
    local cel = s:newCel(l, 1, top, Point(0, (i - 1) * BAND))
    cel.opacity = ({ 255, 180 })[(i % 2) + 1]
  end
  save(s, name)
end

blendModes(ColorMode.RGB, "blend-rgb")
blendModes(ColorMode.GRAYSCALE, "blend-gray")

-- Groups (flattened, as 1.2 files always are), a hidden group, a hidden
-- layer, a background layer, cels hanging off the canvas, and two frames with
-- a linked cel that moves.
do
  local s = Sprite(12, 10, ColorMode.RGB)
  local bg = s.layers[1]
  bg.name = "bg"
  local b = Image(12, 10, ColorMode.RGB)
  b:clear(pc.rgba(30, 60, 90, 255))
  s:newCel(bg, 1, b, Point(0, 0))
  app.activeLayer = bg
  app.command.BackgroundFromLayer()

  local g = s:newGroup()
  g.name = "group"
  local inner = s:newLayer()
  inner.name = "inner"
  inner.parent = g
  inner.opacity = 160
  inner.blendMode = BlendMode.SCREEN
  local i1 = Image(8, 8, ColorMode.RGB)
  for y = 0, 7 do for x = 0, 7 do i1:drawPixel(x, y, pc.rgba(x * 30, y * 30, 200, 100 + x * 15)) end end
  s:newCel(inner, 1, i1, Point(-3, 4))

  local hiddenGroup = s:newGroup()
  hiddenGroup.name = "hidden group"
  local ghost = s:newLayer()
  ghost.name = "ghost"
  ghost.parent = hiddenGroup
  local gi = Image(12, 10, ColorMode.RGB)
  gi:clear(pc.rgba(255, 0, 255, 255))
  s:newCel(ghost, 1, gi, Point(0, 0))
  hiddenGroup.isVisible = false

  local hidden = s:newLayer()
  hidden.name = "hidden"
  s:newCel(hidden, 1, gi, Point(0, 0))
  hidden.isVisible = false

  local top = s:newLayer()
  top.name = "top"
  top.blendMode = BlendMode.MULTIPLY
  local t = Image(6, 6, ColorMode.RGB)
  for y = 0, 5 do for x = 0, 5 do t:drawPixel(x, y, pc.rgba(255 - x * 40, 255, 255 - y * 40, 255)) end end
  s:newCel(top, 1, t, Point(8, -2))

  -- Frame 2: a continuous layer's cel is linked to frame 1's; another layer's
  -- cel is a moved, fainter copy.
  top.isContinuous = true
  s:newFrame()
  local moved = s.layers[2].layers[1]:cel(2)
  moved.position = Point(2, 2)
  moved.opacity = 90
  save(s, "layers")
end

-- An indexed sprite: a palette with a translucent entry, a transparent index
-- that is not 0, and a background.
do
  local s = Sprite(8, 6, ColorMode.INDEXED)
  local pal = Palette(6)
  pal:setColor(0, Color{ r = 0, g = 0, b = 0, a = 255 })
  pal:setColor(1, Color{ r = 250, g = 200, b = 10, a = 255 })
  pal:setColor(2, Color{ r = 20, g = 120, b = 220, a = 255 })
  pal:setColor(3, Color{ r = 90, g = 30, b = 60, a = 255 })
  pal:setColor(4, Color{ r = 200, g = 200, b = 200, a = 255 })
  pal:setColor(5, Color{ r = 10, g = 250, b = 90, a = 255 })
  s:setPalette(pal)
  s.transparentColor = 3
  local bg = s.layers[1]
  local b = Image(8, 6, ColorMode.INDEXED)
  for y = 0, 5 do for x = 0, 7 do b:drawPixel(x, y, (x + y) % 6) end end
  s:newCel(bg, 1, b, Point(0, 0))
  app.activeLayer = bg
  app.command.BackgroundFromLayer()
  local l = s:newLayer()
  local img = Image(5, 4, ColorMode.INDEXED)
  for y = 0, 3 do for x = 0, 4 do img:drawPixel(x, y, (x * 2 + y) % 6) end end
  s:newCel(l, 1, img, Point(2, 1))
  save(s, "indexed")
end

-- The same without a background, so the transparent index shows through.
do
  local s = Sprite(6, 4, ColorMode.INDEXED)
  local pal = Palette(4)
  pal:setColor(0, Color{ r = 0, g = 0, b = 0, a = 255 })
  pal:setColor(1, Color{ r = 250, g = 0, b = 0, a = 255 })
  pal:setColor(2, Color{ r = 0, g = 250, b = 0, a = 255 })
  pal:setColor(3, Color{ r = 0, g = 0, b = 250, a = 255 })
  s:setPalette(pal)
  local l = s.layers[1]
  local img = Image(6, 4, ColorMode.INDEXED)
  for y = 0, 3 do for x = 0, 5 do img:drawPixel(x, y, (x + y) % 4) end end
  s:newCel(l, 1, img, Point(0, 0))
  save(s, "indexed-clear")
end
