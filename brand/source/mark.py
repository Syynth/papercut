"""The papercut mark's geometry: the Bricolage 'p' as a true extruded solid, sliced, in isometric.

This is the generator the logo was designed with on the exploration canvas; `make_board`
builds one design board (the chosen one is frame="planes_axislines", cut=0.42,
slope=0.4, lift=(0, -56), cardboard=True) and `export_brand.py` turns it into the
files in `brand/`.

Geometry is exact (no stacked copies): the glyph outline is extruded along the
iso depth axis, each facing wall is swept and trimmed where the solid occludes
it, walls are cel-shaded by how much they face up, and the cut face is drawn
as white paper with a grid.
"""
import math
import os

from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from shapely import affinity
from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
# Bricolage Grotesque, variable (SIL Open Font License, fonts/OFL.txt), from @fontsource-variable
FONT = os.path.join(HERE, "fonts", "bricolage-grotesque-latin-standard-normal.woff2")
# where make_board writes its board page and its preview SVG
WORK_DIR = os.path.join(HERE, "out")

# local face coords: X right, Y down. Screen = M @ local (iso front-left face).
M = (0.864, 0.0, 0.5, 0.786)          # a, b, c, d  -> x' = aX + bY, y' = cX + dY
H = 140.0                              # glyph height in local units (= G's block height)
DEPTH = float(os.environ.get("PDEPTH", 140))  # extrusion depth in local depth units
V = (DEPTH * 1.0, DEPTH * -1.2723)     # one depth unit = local (1, -1.2723) = screen (0.864, -0.5)
CUT_SLOPE = 0.4
LIFT = (float(os.environ.get("PLIFTX", 12)), float(os.environ.get("PLIFTY", -46)))  # screen offset of the lifted top piece

INK = "#1F2430"
PAPER = "#FFFDF7"
GRID = "#B9B1A2"
NAVY = dict(front="#2B4C7E", side="#1A3157", top="#274673")
# the three-plane frame (fill, grid line), axis tints, floor shadow and preview ground;
# module globals so an exporter can swap in another palette (e.g. dark mode)
PLANE_FILLS = dict(floor=("#E6DCC8", "#D3C6AC"), back=("#DDD2BC", "#CABC9F"), side=("#EAE2D1", "#D8CCB4"))
AXIS_COLORS = dict(x="#D8705E", y="#6FA35B", z="#4F86C6")
SHADOW_OPACITY = 0.13
BG = "#F3EDE0"
RED = dict(front="#E0533D", side="#9A3323", top="#C2432F")


class FlattenPen(BasePen):
    def __init__(self, glyphset, steps=14):
        super().__init__(glyphset)
        self.contours, self.cur, self.steps = [], [], steps

    def _moveTo(self, p):
        self.cur = [p]

    def _lineTo(self, p):
        self.cur.append(p)

    def _curveToOne(self, p1, p2, p3):
        p0 = self.cur[-1]
        for i in range(1, self.steps + 1):
            t = i / self.steps
            mt = 1 - t
            self.cur.append((
                mt**3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t**3 * p3[0],
                mt**3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t**3 * p3[1]))

    def _closePath(self):
        if len(self.cur) > 2:
            self.contours.append(self.cur)
        self.cur = []

    _endPath = _closePath


def glyph_polygon():
    font = TTFont(FONT)
    font = instancer.instantiateVariableFont(font, {"opsz": 96, "wght": 800, "wdth": 100})
    gs = font.getGlyphSet()
    pen = FlattenPen(gs)
    gs[font.getBestCmap()[ord("p")]].draw(pen)
    rings = sorted((Polygon(c).buffer(0) for c in pen.contours), key=lambda p: -p.area)
    shape = rings[0]
    for r in rings[1:]:
        shape = shape.difference(r) if shape.contains(r) else shape.union(r)
    # font units (y up) -> local (y down), scaled so the ink is H tall, origin at ink top-left
    minx, miny, maxx, maxy = shape.bounds
    s = H / (maxy - miny)
    shape = affinity.scale(shape, s, -s, origin=(0, 0))
    minx, miny, _, _ = shape.bounds
    return affinity.translate(shape, -minx, -miny)


def polys(g):
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    return [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon) and not p.is_empty]


def rings_of(p):
    yield p.exterior, True
    for i in p.interiors:
        yield i, False


def extrude(shape, cut_line):
    """Visible walls of shape swept by V, grouped by shade key ('cut' or 0..3)."""
    groups = {}
    boundary = shape.boundary
    for poly in polys(shape):
        for ring, is_ext in rings_of(poly):
            pts = list(ring.coords)
            ccw = ring.is_ccw
            for a, b in zip(pts, pts[1:]):
                ex, ey = b[0] - a[0], b[1] - a[1]
                L = math.hypot(ex, ey)
                if L < 1e-9:
                    continue
                # outward normal (local y-down coords): exterior ccw-in-math == cw on screen
                outward_right = ccw if is_ext else not ccw
                nx, ny = (ey / L, -ex / L) if outward_right else (-ey / L, ex / L)
                if nx * V[0] + ny * V[1] <= 1e-9:
                    continue
                on_cut = cut_line.distance(LineString([a, b])) < 1e-6 and \
                    abs(ey - CUT_SLOPE * ex) < 1e-6 * max(1, L)
                n = max(1, int(L / 1.2))
                for k in range(n):
                    p0 = (a[0] + ex * k / n, a[1] + ey * k / n)
                    p1 = (a[0] + ex * (k + 1) / n, a[1] + ey * (k + 1) / n)
                    mid = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
                    # first re-entry into the solid along +V trims the wall
                    eps = 1e-4
                    ray = LineString([(mid[0] + V[0] * eps, mid[1] + V[1] * eps),
                                      (mid[0] + V[0], mid[1] + V[1])])
                    hit = ray.intersection(boundary)
                    f = 1.0
                    if not hit.is_empty:
                        pts_hit = [hit] if hit.geom_type == "Point" else \
                            [g for g in getattr(hit, "geoms", []) if g.geom_type == "Point"]
                        for ph in pts_hit:
                            t = ((ph.x - mid[0]) * V[0] + (ph.y - mid[1]) * V[1]) / (V[0] ** 2 + V[1] ** 2)
                            f = min(f, max(t, 0.0))
                    quad = Polygon([p0, p1, (p1[0] + V[0] * f, p1[1] + V[1] * f),
                                    (p0[0] + V[0] * f, p0[1] + V[1] * f)])
                    if on_cut:
                        key = "cut"
                    else:
                        up = -ny                       # local y-down: up-facing walls have ny < 0
                        away = nx if V[0] > 0 else -nx          # faces the side the depth runs to
                        ang = math.degrees(math.atan2(up, away))  # 0 = faces sideways, 90 = faces up
                        key = 0 if ang < 22 else 1 if ang < 45 else 2 if ang < 70 else 3
                    groups.setdefault(key, []).append(quad.buffer(0.05, join_style=2))
    return {k: unary_union(v) for k, v in groups.items()}


def to_screen(g, dx=0.0, dy=0.0):
    a, b, c, d = M
    return affinity.affine_transform(g, [a, b, c, d, dx, dy])


def path_d(g, nd=2):
    out = []
    for p in polys(g):
        for ring, _ in rings_of(p):
            cs = list(ring.coords)
            out.append("M" + " L".join(f"{x:.{nd}f} {y:.{nd}f}" for x, y in cs[:-1]) + "Z")
    return " ".join(out)


def lerp(c1, c2, t):
    h = lambda c: [int(c[i:i + 2], 16) for i in (1, 3, 5)]
    a, b = h(c1), h(c2)
    return "#" + "".join(f"{round(x + (y - x) * t):02X}" for x, y in zip(a, b))


def piece_svg(shape, cut_line, colors, offset, grid):
    walls = extrude(shape, cut_line)
    wall_all = unary_union(list(walls.values())) if walls else Polygon()
    silhouette = unary_union([shape, wall_all])
    S = lambda g: to_screen(g, *offset)
    parts = [f'<path d="{path_d(S(silhouette))}" class="sil"></path>']
    shades = {0: colors["side"], 1: lerp(colors["side"], colors["top"], 0.4),
              2: lerp(colors["side"], colors["top"], 0.75), 3: colors["top"]}
    # base wall tone under the bands so band joints never show the background
    parts.append(f'<path d="{path_d(S(wall_all))}" fill="{shades[1]}"></path>')
    for k in (0, 1, 2, 3):
        if k in walls:
            parts.append(f'<path d="{path_d(S(walls[k]))}" fill="{shades[k]}"></path>')
    if "cut" in walls:
        cut_face = walls["cut"]
        parts.append(f'<path d="{path_d(S(cut_face))}" fill="{PAPER}"></path>')
        if grid:
            # one tile grid laid over the whole cut plane, same spacing in 3D both ways,
            # so every part of the cut face shows the same density. Dashes are placed on
            # the grid itself (not a stroke dasharray), so every line's dashes stay in
            # step: each intersection gets a crossing dash, with two dashes per cell between.
            gd = DEPTH / 4
            gx = gd / math.hypot(1, CUT_SLOPE)
            # the cut line lies on this piece's boundary; thicken the piece a hair so
            # every part of the cut edge (stem and bowl) is found, not just some of it
            edge = shape.buffer(0.01).intersection(cut_line)
            segs = sorted((g for g in getattr(edge, "geoms", [edge]) if g.length > 0),
                          key=lambda g: g.bounds[0])
            def at(x, sdepth):
                t = sdepth / DEPTH
                return (x + V[0] * t, CUT_SLOPE * x + CUT_A + V[1] * t)

            # each strip of the cut (stem, bowl) centres its own grid across its width;
            # spacing is shared, and the cross dashes are phased per strip so they still
            # meet the lines running back at every intersection
            dashes = []
            px, pd = gx / 3, gd / 3
            hx, hd = 0.28 * px, 0.28 * pd
            ds = [k * gd for k in range(1, 4)]
            for seg in segs:
                a, b = seg.bounds[0], seg.bounds[2]
                c = (a + b) / 2
                xs = [c + i * gx for i in range(-int(W / gx) - 1, int(W / gx) + 2) if a < c + i * gx < b]
                for sdepth in ds:                 # lines parallel to the cut edge
                    j = math.floor((a - 6 - c) / px)
                    while c + j * px < b + 6:
                        m = c + j * px
                        dashes.append(LineString([at(m - hx, sdepth), at(m + hx, sdepth)]))
                        j += 1
                for x in xs:                      # lines running back through the depth
                    for j in range(0, int(DEPTH / pd) + 2):
                        m = j * pd
                        dashes.append(LineString([at(x, m - hd), at(x, m + hd)]))
            clip = cut_face.buffer(-1.2)
            for ln in dashes:
                seg = ln.intersection(clip)
                for g in ([seg] if seg.geom_type == "LineString" else getattr(seg, "geoms", [])):
                    if g.geom_type == "LineString" and g.length > 1.2:
                        cs = list(S(g).coords)
                        parts.append(f'<line x1="{cs[0][0]:.2f}" y1="{cs[0][1]:.2f}" '
                                     f'x2="{cs[-1][0]:.2f}" y2="{cs[-1][1]:.2f}" class="grid"></line>')
        parts.append(f'<path d="{path_d(S(cut_face))}" class="edge"></path>')
    parts.append(f'<path d="{path_d(S(shape))}" fill="{colors["front"]}"></path>')
    parts.append(f'<path d="{path_d(S(shape))}" class="edge"></path>')
    return "\n".join(parts), S(silhouette), S(walls.get("cut", Polygon()))


def P3(X, Y, sdepth, lifted=False):
    """A point on the block (face X/Y, depth sdepth) in unscaled screen coords."""
    lx, ly = X + V[0] * sdepth / DEPTH, Y + V[1] * sdepth / DEPTH
    a, b, c, d = M
    x, y = a * lx + b * ly, c * lx + d * ly
    return (x + LIFT[0], y + LIFT[1]) if lifted else (x, y)


def frame_css(sw):
    return (f".ghost{{{{fill:none;stroke:{INK};stroke-opacity:0.5;stroke-width:{2 * sw:.2f};"
            f"stroke-dasharray:{6 * sw:.2f} {5 * sw:.2f};stroke-linecap:round}}}}"
            f".ghosth{{{{fill:none;stroke:{INK};stroke-opacity:0.28;stroke-width:{2 * sw:.2f};"
            f"stroke-dasharray:{0.1 * sw:.2f} {5 * sw:.2f};stroke-linecap:round}}}}"
            f".floor{{{{fill:#E6DCC8;stroke:#CBBDA3;stroke-width:{2 * sw:.2f};stroke-linejoin:round}}}}"
            f".floorg{{{{fill:none;stroke:#D6CAB2;stroke-width:{1.5 * sw:.2f}}}}}"
            f".sheet{{{{fill:{PAPER};fill-opacity:0.7;stroke:{INK};stroke-opacity:0.55;stroke-width:{2 * sw:.2f};stroke-linejoin:round}}}}"
            f".crop{{{{fill:none;stroke:{INK};stroke-width:{2.5 * sw:.2f};stroke-linecap:round}}}}"
            f".hex{{{{fill:#D4E6EC}}}}"
            f".plane{{{{stroke-width:{2 * sw:.2f};stroke-linejoin:round}}}}"
            f".planeg{{{{fill:none;stroke-width:{1.5 * sw:.2f}}}}}"
            f".planegb{{{{fill:none;stroke-width:{2.4 * sw:.2f}}}}}"
            f".axis{{{{fill:none;stroke-width:{3.5 * sw:.2f};stroke-linecap:round}}}}"
            f".axisd{{{{fill:none;stroke-width:{3.5 * sw:.2f};stroke-linecap:round;"
            f"stroke-dasharray:{0.01 * sw:.2f} {8 * sw:.2f};stroke-dashoffset:{-8 * sw:.2f}}}}}").replace("{{", "{").replace("}}", "}")


PLANE_MARGIN_TILES = 1.0   # floor margin around the block's footprint, in tiles
WALL_TILES = 5             # wall height, in tiles


def plane_geometry():
    """The three-plane frame, in tiles of the cut-face grid's depth spacing.

    The block's footprint is 4 x 4 tiles (its depth is exactly 4; its width is within
    a third of a unit of 4). Lines are laid from the back corner where the planes
    meet, so a margin of whole tiles puts the block's edges on grid lines.
    """
    g = DEPTH / 4                      # a tile, in face-X / depth units (both draw at length 1)
    gy = g / M[3]                      # the same on-screen length in local Y units
    nx = round(W / g)
    mt = PLANE_MARGIN_TILES
    x_lo, x_hi = -mt * g, (nx + mt) * g
    s0, s1 = -mt * g, DEPTH + mt * g
    xs, xo = (x_lo, x_hi) if V[0] > 0 else (x_hi, x_lo)      # side wall on the hidden side
    n_x = round((x_hi - x_lo) / g)
    n_s = round((s1 - s0) / g)
    step = g if xo > xs else -g
    return dict(xs=xs, xo=xo, s0=s0, s1=s1, top=H - WALL_TILES * gy, tile=g,
                xlines=[xs + k * step for k in range(1, n_x)],
                slines=[s1 - k * g for k in range(1, n_s)],
                ylines=[H - k * gy for k in range(1, WALL_TILES)])


def framing(kind, bot_cut):
    """Back-layer svg, mid-layer svg (between the halves), and geometry for fitting."""
    if not kind:
        return "", "", []
    corners = {(i, j, k): P3(i * W, j * H, k * DEPTH) for i in (0, 1) for j in (0, 1) for k in (0, 1)}
    lifted = [P3(i * W, j * H, k * DEPTH, True) for i in (0, 1) for j in (0, 1) for k in (0, 1)]
    hull = MultiPolygon([Polygon(list(corners.values())).convex_hull,
                         Polygon(lifted).convex_hull]).convex_hull
    line = lambda p, q, cls: (f'<line x1="{p[0]:.2f}" y1="{p[1]:.2f}" x2="{q[0]:.2f}" '
                              f'y2="{q[1]:.2f}" class="{cls}"></line>')
    if kind == "ghost":
        hidden = (0 if V[0] > 0 else 1, 1, 1)
        out = []
        for a in corners:
            for axis in range(3):
                if a[axis] == 0:
                    b = tuple(1 if n == axis else a[n] for n in range(3))
                    cls = "ghosth" if hidden in (a, b) else "ghost"
                    out.append(line(corners[a], corners[b], cls))
        return "\n".join(out), "", [Polygon(list(corners.values())).convex_hull]
    if kind == "floor":
        m = 18
        tile = Polygon([P3(-m, H, -m), P3(W + m, H, -m), P3(W + m, H, DEPTH + m), P3(-m, H, DEPTH + m)])
        out = [f'<path d="{path_d(tile)}" class="floor"></path>']
        step = DEPTH / 4
        for k in range(1, 4):
            out.append(line(P3(-m, H, k * step), P3(W + m, H, k * step), "floorg"))
        for k in range(1, 4):
            x = W * k / 4
            out.append(line(P3(x, H, -m), P3(x, H, DEPTH + m), "floorg"))
        shadow = Polygon([P3(0, H, 0), P3(W, H, 0), P3(W, H, DEPTH), P3(0, H, DEPTH)])
        out.append(f'<path d="{path_d(shadow)}" fill="{INK}" opacity="{SHADOW_OPACITY}"></path>')
        return "\n".join(out), "", [tile]
    if kind in ("planes", "planes_axis", "planes_axislines", "planes_edgetint"):
        # three planes meeting in the hidden back corner (floor, back wall, side wall),
        # gridded in square tiles laid out from that corner, so every cell is the same
        # size and each line runs on across the joins between planes
        pg = plane_geometry()
        xs, xo, s0, s1, top = pg["xs"], pg["xo"], pg["s0"], pg["s1"], pg["top"]
        if kind in ("planes", "planes_axislines", "planes_edgetint"):
            fills = PLANE_FILLS
        else:
            fills = dict(floor=("#D5E3EE", "#B9CEDF"), back=("#DAE8D3", "#BFD5B4"), side=("#F1DAD3", "#E2BDB2"))
        floor = Polygon([P3(xs, H, s0), P3(xo, H, s0), P3(xo, H, s1), P3(xs, H, s1)])
        back = Polygon([P3(xs, H, s1), P3(xo, H, s1), P3(xo, top, s1), P3(xs, top, s1)])
        side = Polygon([P3(xs, H, s0), P3(xs, H, s1), P3(xs, top, s1), P3(xs, top, s0)])
        out = ['<g id="PID-planes">']
        for name, poly in (("back", back), ("side", side), ("floor", floor)):
            fill, edge = fills[name]
            out.append(f'<path d="{path_d(poly)}" fill="{fill}" stroke="{edge}" class="plane"></path>')
        gcls = "planegb" if kind in ("planes_axislines", "planes_edgetint") else "planeg"
        gl = lambda p, q, name: (f'<line x1="{p[0]:.2f}" y1="{p[1]:.2f}" x2="{q[0]:.2f}" '
                                 f'y2="{q[1]:.2f}" stroke="{fills[name][1]}" class="{gcls}"></line>')
        for x in pg["xlines"]:                # lines running back: floor, then up the back wall
            out.append(gl(P3(x, H, s0), P3(x, H, s1), "floor"))
            out.append(gl(P3(x, H, s1), P3(x, top, s1), "back"))
        for sd in pg["slines"]:               # lines running across: floor, then up the side wall
            out.append(gl(P3(xs, H, sd), P3(xo, H, sd), "floor"))
            out.append(gl(P3(xs, H, sd), P3(xs, top, sd), "side"))
        for y in pg["ylines"]:                # rings round both walls
            out.append(gl(P3(xs, y, s1), P3(xo, y, s1), "back"))
            out.append(gl(P3(xs, y, s0), P3(xs, y, s1), "side"))
        out.append("</g>")
        corner = P3(xs, H, s1)
        if kind == "planes_axislines":
            # the axes run from the back corner along the plane edges, then on past them,
            # dotted, for half the planes' length on that axis
            ext_x, ext_y = 0.5 * abs(xo - xs), 0.5 * (s1 - s0)
            # the up axis matches the others' full on-screen length (its walls are shorter,
            # and a local Y unit draws shorter than an X or depth unit)
            a_, b_, c_, d_ = M
            len_x = (abs(xo - xs) + ext_x) * math.hypot(a_, c_)
            ext_z = len_x / d_ - (H - top)
            xend = xo + (ext_x if xo > xs else -ext_x)
            out.append('<g id="PID-axes">')
            # solid along the planes, dotted where it runs past them
            for edge_end, end, color in (
                    (P3(xo, H, s1), P3(xend, H, s1), AXIS_COLORS["x"]),               # x: across the face
                    (P3(xs, H, s0), P3(xs, H, s0 - ext_y), AXIS_COLORS["y"]),         # y: depth
                    (P3(xs, top, s1), P3(xs, top - ext_z, s1), AXIS_COLORS["z"])):    # z: up
                for a, b, cls in ((corner, edge_end, "axis"), (edge_end, end, "axisd")):
                    out.append(f'<line x1="{a[0]:.2f}" y1="{a[1]:.2f}" x2="{b[0]:.2f}" '
                               f'y2="{b[1]:.2f}" stroke="{color}" class="{cls}"></line>')
            out.append("</g>")
        if kind == "planes_edgetint":
            # tint the planes' outer edges by the axis each one runs along
            edges = [((xs, H, s0), (xo, H, s0), AXIS_COLORS["x"]),           # floor front: x
                     ((xo, H, s0), (xo, H, s1), AXIS_COLORS["y"]),           # floor side: y
                     ((xo, H, s1), (xo, top, s1), AXIS_COLORS["z"]),         # back wall end: z
                     ((xo, top, s1), (xs, top, s1), AXIS_COLORS["x"]),       # back wall top: x
                     ((xs, top, s1), (xs, top, s0), AXIS_COLORS["y"]),       # side wall top: y
                     ((xs, top, s0), (xs, H, s0), AXIS_COLORS["z"])]         # side wall end: z
            for a, b, color in edges:
                p, q = P3(*a), P3(*b)
                out.append(f'<line x1="{p[0]:.2f}" y1="{p[1]:.2f}" x2="{q[0]:.2f}" '
                           f'y2="{q[1]:.2f}" stroke="{color}" class="axis"></line>')
        shadow = Polygon([P3(0, H, 0), P3(W, H, 0), P3(W, H, DEPTH), P3(0, H, DEPTH)])
        out.append(f'<path id="PID-shadow" d="{path_d(shadow)}" fill="{INK}" opacity="{SHADOW_OPACITY}"></path>')
        geoms = [floor, back, side]
        if kind == "planes_axislines":
            geoms += [LineString([corner, P3(xend, H, s1)]).buffer(2),
                      LineString([corner, P3(xs, H, s0 - ext_y)]).buffer(2),
                      LineString([corner, P3(xs, top - ext_z, s1)]).buffer(2)]
        return "\n".join(out), "", geoms
    if kind == "sheet":
        m = 22
        pl = lambda X, sd: P3(X, CUT_A + CUT_SLOPE * X, sd)
        sheet = Polygon([pl(-m, -m), pl(W + m, -m), pl(W + m, DEPTH + m), pl(-m, DEPTH + m)])
        return f'<path d="{path_d(sheet)}" class="sheet"></path>', "", [sheet]
    if kind == "crop":
        x0, y0, x1, y1 = hull.bounds
        g, L = 12, 14            # gap from the artwork, arm length
        x0, y0, x1, y1 = x0 - g, y0 - g, x1 + g, y1 + g
        out = []
        for cx, cy, sx, sy in ((x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)):
            out.append(f'<polyline points="{cx + sx * L:.2f},{cy:.2f} {cx:.2f},{cy:.2f} '
                       f'{cx:.2f},{cy + sy * L:.2f}" class="crop"></polyline>')
        return "\n".join(out), "", [Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)]).buffer(3)]
    if kind == "hex":
        # a regular pointy-top hexagon (the silhouette of an iso cube) around the artwork
        cx, cy = hull.centroid.x, hull.centroid.y
        pts = list(hull.exterior.coords)
        normals = [(math.cos(math.radians(a)), math.sin(math.radians(a))) for a in range(0, 360, 60)]
        apothem = max((px - cx) * nx + (py - cy) * ny for px, py in pts for nx, ny in normals) + 12
        R = apothem / math.cos(math.radians(30))
        hexagon = Polygon([(cx + R * math.cos(math.radians(a)), cy + R * math.sin(math.radians(a)))
                           for a in range(-90, 270, 60)])
        badge = hexagon.buffer(-10, join_style=2).buffer(10, join_style=1, quad_segs=6)
        return f'<path d="{path_d(badge)}" class="hex"></path>', "", [badge]
    raise ValueError(kind)


LEFT_FACE = dict(M=(0.864, 0.0, 0.5, 0.786), vx=1.0)     # p on the front-left face
RIGHT_FACE = dict(M=(0.864, 0.0, -0.5, 0.786), vx=-1.0)   # p on the front-right face
KRAFT = dict(front="#E9DDC6", side="#B8A47F", top="#D3C3A3")


def make_board(out, pid, letter, title, blurb, bottom_colors, top_colors, icon_bg, face,
               depth=105.0, cut=0.60, lift=(14.0, -58.0), frame=None, slope=0.4, cardboard=False):
    global M, V, DEPTH, LIFT, CUT_A, W, CUT_SLOPE
    M, DEPTH, LIFT, CUT, CUT_SLOPE = face["M"], depth, lift, cut, slope
    V = (depth * face["vx"], depth * -1.2723)
    glyph = glyph_polygon()
    W = glyph.bounds[2]
    # cut through the middle of the bowl
    CUT_A = CUT * H - CUT_SLOPE * W / 2
    far = 1000
    cut_line = LineString([(-far, CUT_A - CUT_SLOPE * far), (far, CUT_A + CUT_SLOPE * far)])
    half_top = Polygon([(-far, -far), (far, -far), (far, CUT_A + CUT_SLOPE * far), (-far, CUT_A - CUT_SLOPE * far)])
    bottom = glyph.difference(half_top)
    top = glyph.intersection(half_top)

    bot_svg, bot_sil, bot_cut = piece_svg(bottom, cut_line, bottom_colors, (0, 0), grid=True)
    bot_svg = f'<g id="{pid}-bottom">\n{bot_svg}\n</g>'
    # the top half is drawn closed and lifted by a transform, so it can be animated
    top_svg, top_sil, _ = piece_svg(top, cut_line, top_colors, (0, 0), grid=False)
    top_sil = affinity.translate(top_sil, *LIFT)
    top_svg = (f'<g id="{pid}-top" transform="translate({LIFT[0]:.2f} {LIFT[1]:.2f})">\n'
               f'{top_svg}\n</g>')

    # dashed "cut here" marks, continuing the cut plane past the solid
    # front edge: past the end nearest the viewer; side edge: past the back on the far end
    xf, sf = (0.0, -1.0) if V[0] > 0 else (W, 1.0)
    p_left = (xf + sf * 6, CUT_A + CUT_SLOPE * (xf + sf * 6))
    p_left2 = (xf + sf * 28, CUT_A + CUT_SLOPE * (xf + sf * 28))
    xs = W if V[0] > 0 else 0.0
    p_back = (xs + V[0] * 1.0, CUT_A + CUT_SLOPE * xs + V[1] * 1.0)
    dirv = (V[0] / DEPTH, V[1] / DEPTH)
    p_back1 = (p_back[0] + dirv[0] * 8, p_back[1] + dirv[1] * 8)
    p_back2 = (p_back[0] + dirv[0] * 34, p_back[1] + dirv[1] * 34)
    dash_l = to_screen(LineString([p_left, p_left2]))
    dash_r = to_screen(LineString([p_back1, p_back2]))

    frame_back, frame_mid, frame_geoms = framing(frame, bot_cut)
    frame_back = frame_back.replace("PID-", f"{pid}-")
    if frame:
        extra = frame_geoms
    else:
        extra = [dash_l.buffer(2), dash_r.buffer(2)]

    # fit everything into the 400x400 mark box
    allg = unary_union([bot_sil, top_sil] + extra)
    bx0, by0, bx1, by1 = allg.bounds
    scale = min(320 / (bx1 - bx0), 320 / (by1 - by0))
    tx = 200 - scale * (bx0 + bx1) / 2
    ty = 200 - scale * (by0 + by1) / 2
    dash_svg = "" if frame else "\n".join(
        f'<line x1="{l.coords[0][0]:.2f}" y1="{l.coords[0][1]:.2f}" x2="{l.coords[1][0]:.2f}" '
        f'y2="{l.coords[1][1]:.2f}" class="cut"></line>' for l in (dash_l, dash_r))

    mark = f"""<g id="{pid}-mark">
    <g transform="translate({tx:.2f} {ty:.2f}) scale({scale:.4f})">
    {frame_back}
    {dash_svg}
    {bot_svg}
    {frame_mid}
    {top_svg}
    </g>
    </g>"""

    sw = 1 / scale  # keep stroke widths in final-pixel terms
    wm_extra = ""
    if cardboard:
        # a thin cardboard edge receding the same way as the block's depth
        layers = [f"{0.86 * k:.2f}px {-0.5 * k:.2f}px 0 {'#B08A5A' if k < 5 else '#7E5F3A'}" for k in range(1, 6)]
        wm_extra = "; text-shadow: " + ", ".join(layers)
    html = f"""<!doctype html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <title>Concept {letter}: {title}</title>
    <script src="./support.js"></script>
    </head>
    <body>
    <x-dc>
    <helmet>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,400..800&amp;family=IBM+Plex+Mono:wght@400;500&amp;display=swap">
    <style>
    body{{margin:0;background:#F3EDE0;color:#1F2430;font-family:'IBM Plex Mono',ui-monospace,monospace}}
    .sil{{fill:{INK};stroke:{INK};stroke-width:{12 * sw:.2f};stroke-linejoin:round}}
    .edge{{fill:none;stroke:{INK};stroke-width:{3 * sw:.2f};stroke-linejoin:round}}
    .grid{{fill:none;stroke:{GRID};stroke-width:{2 * sw:.2f};stroke-linecap:butt}}
    .cut{{fill:none;stroke:{INK};stroke-width:{4 * sw:.2f};stroke-dasharray:{8 * sw:.2f} {8 * sw:.2f};stroke-linecap:round}}{frame_css(sw)}
    </style>
    </helmet>
    <div style="width: 560px; height: 680px; box-sizing: border-box; background: #F3EDE0; display: flex; flex-direction: column">
    <div style="display: flex; justify-content: space-between; align-items: baseline; padding: 24px 28px 0 28px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #6B6353">
    <span style="font-weight: 500; color: #1F2430">{letter} · {title}</span>
    <span>{blurb}</span>
    </div>
    <div style="flex-grow: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px">
    <svg viewBox="0 0 400 400" width="300" height="300" role="img" aria-label="{title} mark">
    <defs>
    {mark}
    </defs>
    <use href="#{pid}-mark"></use>
    </svg>
    <div style="font-family: 'Bricolage Grotesque', sans-serif; font-size: 64px; font-weight: 800; letter-spacing: -0.035em; line-height: 1; font-variation-settings: 'opsz' 96{wm_extra}">papercut</div>
    </div>
    <div style="display: flex; align-items: center; gap: 20px; padding: 22px 28px; background: #1F2430">
    <div style="width: 88px; height: 88px; border-radius: 20px; background: {icon_bg}; overflow: hidden"><svg viewBox="0 0 400 400" width="88" height="88" aria-hidden="true"><use href="#{pid}-mark"></use></svg></div>
    <div style="width: 48px; height: 48px; border-radius: 11px; background: {icon_bg}; overflow: hidden"><svg viewBox="0 0 400 400" width="48" height="48" aria-hidden="true"><use href="#{pid}-mark"></use></svg></div>
    <div style="width: 28px; height: 28px; border-radius: 7px; background: {icon_bg}; overflow: hidden"><svg viewBox="0 0 400 400" width="28" height="28" aria-hidden="true"><use href="#{pid}-mark"></use></svg></div>
    <span style="margin-left: auto; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: #B8AE9A">app icon · 88 / 48 / 28</span>
    </div>
    </div>
    </x-dc>
    <script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":560,"height":680}}}}'>
    class Component extends DCLogic {{
    renderVals() {{
    return {{}};
    }}
    }}
    </script>
    </body>
    </html>
    """
    os.makedirs(WORK_DIR, exist_ok=True)
    if not os.environ.get("PNOWRITE"):
        with open(os.path.join(WORK_DIR, out), "w") as fh:
            fh.write(html)

    # standalone preview for local inspection
    with open(os.path.join(WORK_DIR, f"{pid}_preview.svg"), "w") as fh:
        fh.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="800" height="800">'
                 f'<style>.sil{{fill:{INK};stroke:{INK};stroke-width:{12 * sw:.2f};stroke-linejoin:round}}'
                 f'.edge{{fill:none;stroke:{INK};stroke-width:{3 * sw:.2f};stroke-linejoin:round}}'
                 f'.grid{{fill:none;stroke:{GRID};stroke-width:{2 * sw:.2f};stroke-linecap:butt}}'
                 f'.cut{{fill:none;stroke:{INK};stroke-width:{4 * sw:.2f};stroke-dasharray:{8 * sw:.2f} {8 * sw:.2f};stroke-linecap:round}}{frame_css(sw)}</style>'
                 f'<rect width="400" height="400" fill="{BG}"/><defs>{mark}</defs><use href="#{pid}-mark"/></svg>')
    print(out, "W", round(W, 1), "bytes", len(html))
