-- The Aseprite 1.3 golden fixtures: what 1.2 cannot write — tilemaps with
-- flipped tiles, cel z-indexes, reference layers, and the 1.3
-- homes of tag colours, slice data and properties. Run with Aseprite 1.3 from
-- the repo root:
--   aseprite -b --script-param dir=packages/aseprite-render/fixtures/v1.3 --script packages/aseprite-render/fixtures/v1.3/make.lua
-- Like ../make.lua, each file comes with Aseprite's own PNG of every frame.

local dir = app.params["dir"]
local pc = app.pixelColor

local function save(sprite, name)
  sprite:saveAs(dir .. "/" .. name .. ".aseprite")
  sprite:saveCopyAs(dir .. "/" .. name .. "-{frame}.png")
  sprite:close()
end

-- A tilemap over a translucent backdrop: asymmetric tiles, so every flip shows.
do
  local s = Sprite(40, 24, ColorMode.RGB)
  local back = s.layers[1]
  back.name = "backdrop"
  local b = Image(40, 24, ColorMode.RGB)
  for y = 0, 23 do for x = 0, 39 do b:drawPixel(x, y, pc.rgba(x * 6, y * 10, 120, 160)) end end
  s:newCel(back, 1, b, Point(0, 0))

  app.command.NewLayer{ tilemap = true, gridBounds = Rectangle(0, 0, 8, 8) }
  local map = app.layer
  map.name = "map"
  map.opacity = 220
  local ts = map.tileset
  for t = 1, 3 do
    local tile = s:newTile(ts)
    for y = 0, 7 do for x = 0, 7 do
      -- A corner-heavy pattern: nothing about it is symmetric.
      local on = (x + 2 * y) % (t + 3) == 0 or (x < t and y < 2)
      tile.image:drawPixel(x, y, on and pc.rgba(255 - t * 60, t * 70, 40 * t, 255) or pc.rgba(0, 0, 0, 0))
    end end
  end
  local X, Y, D = 0x20000000, 0x40000000, 0x80000000
  local tiles = {
    { 1, 1 | X, 1 | Y, 1 | D, 1 | X | Y },
    { 2, 2 | D | X, 0, 3 | Y | D, 3 },
  }
  local img = Image(ImageSpec{ colorMode = ColorMode.TILEMAP, width = 5, height = 2 })
  for ty, row in ipairs(tiles) do for tx, v in ipairs(row) do img:putPixel(tx - 1, ty - 1, v) end end
  s:newCel(map, 1, img, Point(-3, 5))
  save(s, "tilemap")
end

-- Cel z-indexes reorder layers per frame; a reference layer never renders.
do
  local s = Sprite(12, 12, ColorMode.RGB)
  local function square(layer, frame, color, x, y, z, opacity)
    local img = Image(7, 7, ColorMode.RGB)
    img:clear(color)
    local cel = s:newCel(layer, frame, img, Point(x, y))
    cel.zIndex = z
    cel.opacity = opacity or 255
  end
  local a = s.layers[1]
  a.name = "a"
  local b = s:newLayer()
  b.name = "b"
  b.blendMode = BlendMode.MULTIPLY
  local c = s:newLayer()
  c.name = "c"
  s:newEmptyFrame()
  square(a, 1, pc.rgba(220, 40, 40, 255), 0, 0, 2)
  square(b, 1, pc.rgba(40, 220, 40, 200), 3, 3, 0)
  square(c, 1, pc.rgba(40, 40, 220, 180), 5, 5, 0, 200)
  square(a, 2, pc.rgba(220, 40, 40, 255), 0, 0, 0)
  square(b, 2, pc.rgba(40, 220, 40, 200), 3, 3, 0)
  square(c, 2, pc.rgba(40, 40, 220, 180), 5, 5, -2)
  app.command.NewLayer{ reference = true }
  local ref = app.layer
  ref.name = "reference"
  local r = Image(12, 12, ColorMode.RGB)
  r:clear(pc.rgba(255, 0, 255, 255))
  s:newCel(ref, 1, r, Point(0, 0))
  save(s, "zindex")
end

-- Metadata in its 1.3 places: tag colours and slice data as user data,
-- properties on the sprite and a layer.
do
  local s = Sprite(16, 16, ColorMode.RGB)
  s.properties.author = "papercut"
  local l = s.layers[1]
  l.name = "body"
  l.properties.speed = 3
  l.data = "layer notes"
  local img = Image(16, 16, ColorMode.RGB)
  img:clear(pc.rgba(90, 160, 200, 255))
  s:newCel(l, 1, img, Point(0, 0))
  s:newFrame()
  s:newFrame()
  local walk = s:newTag(1, 3)
  walk.name = "walk"
  walk.aniDir = AniDir.PING_PONG
  walk.repeats = 2
  walk.color = Color{ r = 200, g = 40, b = 90 }
  local door = s:newSlice(Rectangle(2, 3, 8, 10))
  door.name = "door"
  door.center = Rectangle(1, 1, 6, 8)
  door.pivot = Point(4, 10)
  door.data = "hinge left"
  save(s, "meta")
end
