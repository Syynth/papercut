# /// script
# requires-python = ">=3.12"
# dependencies = ["fonttools", "brotli", "shapely", "uharfbuzz", "trimesh", "mapbox_earcut",
#                 "pygltflib", "pillow", "numpy", "scipy", "networkx", "rtree"]
# ///
"""Export the papercut logo (exploration board L6·1f) as the files in `brand/`.

  papercut-mark.svg             the mark alone, presentation attributes only (no CSS)
  papercut-wordmark.svg         "papercut" outlined from Bricolage Grotesque, with its cardboard edge
  papercut-lockup-horizontal.svg / papercut-lockup-stacked.svg
  *.png                         4096px-wide transparent renders of each SVG
  papercut-mark.glb             the mark as a 3D scene, split into named, animatable nodes

Run from the repo root:  uv run brand/source/export_brand.py
(needs `rsvg-convert`, from librsvg: `brew install librsvg`). Writes into `brand/`.
"""
import importlib
import io
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, ".."))
os.makedirs(OUT, exist_ok=True)

# The mark's geometry lives in mark.py; G is its module namespace, so setting a key
# here (a palette colour, say) changes what its functions draw.
sys.path.insert(0, HERE)
G = vars(importlib.import_module("mark"))
G["WORK_DIR"] = tempfile.mkdtemp(prefix="papercut-brand-")

INK, PAPER, GRID = G["INK"], G["PAPER"], G["GRID"]
NAVY, RED = G["NAVY"], G["RED"]

# The chosen design's parameters (board L6·1f).
H = G["H"]
DEPTH, CUT, SLOPE, LIFT_SCREEN, MARGIN = 105.0, 0.42, 0.4, 56.0, 18.0
VSCALE = 0.786       # the logo draws heights at 0.786 of widths; the 3D model bakes that in

# Light is the canvas design. Dark keeps the same structure for dark backgrounds: the
# frame planes go to slate, the block and axes brighten so they hold on dark, the cut
# face stays paper (it is the one light surface), and the wordmark's face turns paper.
PALETTES = {
    "light": dict(
        INK="#1F2430", PAPER="#FFFDF7", GRID="#B9B1A2",
        NAVY=dict(front="#2B4C7E", side="#1A3157", top="#274673"),
        RED=dict(front="#E0533D", side="#9A3323", top="#C2432F"),
        PLANE_FILLS=dict(floor=("#E6DCC8", "#D3C6AC"), back=("#DDD2BC", "#CABC9F"), side=("#EAE2D1", "#D8CCB4")),
        AXIS_COLORS=dict(x="#D8705E", y="#6FA35B", z="#4F86C6"),
        SHADOW_OPACITY=0.13, BG="#F3EDE0",
        WORD=dict(face="#1F2430", edge="#B08A5A", rim="#7E5F3A")),
    "dark": dict(
        INK="#0B0D11", PAPER="#F1EADB", GRID="#A39A89",
        NAVY=dict(front="#4673B4", side="#28497C", top="#3A62A0"),
        RED=dict(front="#EE6A4F", side="#A63A28", top="#D05037"),
        PLANE_FILLS=dict(floor=("#272B34", "#363C48"), back=("#21252D", "#30353F"), side=("#2C313B", "#3C424E")),
        AXIS_COLORS=dict(x="#F2836C", y="#8BC874", z="#6EA6EE"),
        SHADOW_OPACITY=0.35, BG="#16191F",
        WORD=dict(face="#F3EDE0", edge="#A07D50", rim="#6A4F2E")),
}
PAL = PALETTES["light"]


def apply_palette(name):
    """Point both this script and the board generator at one palette."""
    global PAL, INK, PAPER, GRID, NAVY, RED
    PAL = PALETTES[name]
    for key in ("INK", "PAPER", "GRID", "NAVY", "RED", "PLANE_FILLS", "AXIS_COLORS", "SHADOW_OPACITY", "BG"):
        G[key] = PAL[key]
    INK, PAPER, GRID, NAVY, RED = PAL["INK"], PAL["PAPER"], PAL["GRID"], PAL["NAVY"], PAL["RED"]


def run(*cmd):
    subprocess.run(cmd, check=True)


# ---------------------------------------------------------------- SVG: mark
CSS_PROPS = ("fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-linejoin",
             "stroke-linecap", "stroke-dasharray", "stroke-dashoffset", "opacity")


def inline_css(svg_body, css):
    rules = {}
    for name, body in re.findall(r"\.([\w-]+)\{([^}]*)\}", css):
        rules[name] = [tuple(p.split(":", 1)) for p in body.split(";") if ":" in p]

    def fix(m):
        tag = m.group(0)
        cls = re.search(r' class="([^"]*)"', tag)
        if not cls:
            return tag
        attrs = {}
        for c in cls.group(1).split():
            for k, v in rules.get(c, []):
                if k in CSS_PROPS:
                    attrs[k] = v
        tag = tag.replace(cls.group(0), "")
        for k, v in attrs.items():
            if re.search(rf' {k}="', tag):      # an explicit attribute on the element wins
                continue
            tag = tag.replace(">", f' {k}="{v}">', 1) if not tag.endswith("/>") else \
                tag[:-2] + f' {k}="{v}"/>'
        return tag

    return re.sub(r"<(path|line|polyline|polygon|rect|circle)\b[^>]*>", fix, svg_body)


def alpha_bbox(svg_path, w, h):
    """Bounding box of the drawn pixels, in the SVG's own user units (viewBox 0 0 w h)."""
    from PIL import Image
    png = svg_path + ".bbox.png"
    run("rsvg-convert", "-w", str(w * 4), "-h", str(h * 4), svg_path, "-o", png)
    box = Image.open(png).getbbox()
    os.remove(png)
    return box[0] / 4, box[1] / 4, box[2] / 4, box[3] / 4


def export_mark(tag):
    # rebuild board L6·1f in the current palette; the generator writes a board file
    # and a preview SVG, and the preview is what gets cleaned up into the mark
    pid = f"export{tag}"
    board = f"_{pid}.dc.html"
    G["make_board"](board, pid, "X", "export", "", G["NAVY"], G["RED"], PAL["BG"], G["LEFT_FACE"],
                    frame="planes_axislines", cut=CUT, slope=SLOPE, lift=(0.0, -LIFT_SCREEN), cardboard=True)
    raw = open(os.path.join(G["WORK_DIR"], f"{pid}_preview.svg")).read()
    css = re.search(r"<style>(.*?)</style>", raw).group(1)
    mark = re.search(r"<defs>(.*)</defs>", raw, re.S).group(1)
    # named parts, for animating: pc-planes, pc-axes, pc-shadow, pc-bottom, pc-top
    mark = mark.replace(f'id="{pid}-mark"', 'id="papercut-mark"').replace(f'id="{pid}-', 'id="pc-')
    body = inline_css(mark, css)
    body = "\n".join(l.strip() for l in body.splitlines() if l.strip())
    tmp = os.path.join(OUT, "_mark_full.svg")
    open(tmp, "w").write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">{body}</svg>')
    x0, y0, x1, y1 = alpha_bbox(tmp, 400, 400)
    os.remove(tmp)
    pad = 0.03 * max(x1 - x0, y1 - y0)
    vb = (x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad)
    return body, vb


# ---------------------------------------------------------------- SVG: wordmark
def export_wordmark():
    import uharfbuzz as hb
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer
    from shapely import affinity
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    font = instancer.instantiateVariableFont(TTFont(G["FONT"]), {"opsz": 96, "wght": 800, "wdth": 100})
    font.flavor = None
    buf = io.BytesIO()
    font.save(buf)
    upm = font["head"].unitsPerEm
    face = hb.Face(buf.getvalue())
    hbfont = hb.Font(face)
    hbuf = hb.Buffer()
    hbuf.add_str("papercut")
    hbuf.guess_segment_properties()
    hb.shape(hbfont, hbuf, {"kern": True, "liga": True})
    glyph_order = font.getGlyphOrder()
    gs = font.getGlyphSet()
    tracking = -0.035 * upm

    faces, shapes = [], []
    x = 0.0
    for info, pos in zip(hbuf.glyph_infos, hbuf.glyph_positions):
        name = glyph_order[info.codepoint]
        pen = SVGPathPen(gs)
        gs[name].draw(pen)
        faces.append((x + pos.x_offset, pen.getCommands()))
        fp = G["FlattenPen"](gs, steps=28)
        gs[name].draw(fp)
        rings = sorted((Polygon(c).buffer(0) for c in fp.contours), key=lambda p: -p.area)
        shape = None
        for r in rings:
            shape = r if shape is None else (shape.difference(r) if shape.contains(r) else shape.union(r))
        if shape is not None:
            shapes.append(affinity.translate(shape, x + pos.x_offset, 0))
        x += pos.x_advance + tracking
    glyphs = unary_union(shapes)

    # cardboard edge: the glyphs swept back along the block's depth direction
    # (0.86, -0.5) per px on screen at 64px, 5px deep; font units are y-up
    depth = 5 / 64 * upm
    v = (0.86 * depth, 0.5 * depth)

    def sweep(g, f):
        vx, vy = v[0] * f, v[1] * f
        parts = [g, affinity.translate(g, vx, vy)]
        for p in G["polys"](g):
            for ring in [p.exterior, *p.interiors]:
                cs = list(ring.coords)
                for a, b in zip(cs, cs[1:]):
                    q = Polygon([a, b, (b[0] + vx, b[1] + vy), (a[0] + vx, a[1] + vy)])
                    if q.area > 1e-9:
                        parts.append(q)
        return unary_union(parts)

    def d_of(g):
        out = []
        for p in G["polys"](g):
            for ring in [p.exterior, *p.interiors]:
                cs = list(ring.coords)
                out.append("M" + " L".join(f"{a:.1f} {b:.1f}" for a, b in cs[:-1]) + "Z")
        return " ".join(out)

    rim, mid = sweep(glyphs, 1.0), sweep(glyphs, 0.8)
    x0, y0, x1, y1 = rim.bounds
    # SVG y-down: flip about the baseline, shift so the ink starts at 0,0
    tf = f"matrix(1 0 0 -1 {-x0:.1f} {y1:.1f})"
    face_paths = "".join(f'<path transform="translate({gx:.1f} 0)" d="{d}"/>' for gx, d in faces)
    body = (f'<g transform="{tf}">'
            f'<path d="{d_of(rim)}" fill="{PAL["WORD"]["rim"]}"/>'
            f'<path d="{d_of(mid)}" fill="{PAL["WORD"]["edge"]}"/>'
            f'<g fill="{PAL["WORD"]["face"]}">{face_paths}</g></g>')
    return body, (x1 - x0, y1 - y0)


# The demo animation: planes, axes and shadow fade in, the closed block drops into
# place, then the top half lifts to its logo position and settles. It plays once and
# ends on the static logo; with reduced motion it shows the static logo straight away.
# The top half is drawn closed with a transform="translate(0 -56)" lifting it, so any
# animation of pc-top's transform between translate(0, 0) and translate(0, -56px)
# opens and closes the cut.
ANIMATION_CSS = """
@keyframes pc-planes { 0% { opacity: 0 } 20%, 100% { opacity: 1 } }
@keyframes pc-axes { 0%, 12% { opacity: 0 } 35%, 100% { opacity: 1 } }
@keyframes pc-shadow { 0%, 40% { opacity: 0 } 55%, 100% { opacity: SHADOW } }
@keyframes pc-bottom {
  0%, 25% { opacity: 0; transform: translate(0px, -40px) }
  50%, 100% { opacity: 1; transform: translate(0px, 0px) }
}
@keyframes pc-top {
  0%, 25% { opacity: 0; transform: translate(0px, -40px) }
  50%, 62% { opacity: 1; transform: translate(0px, 0px); animation-timing-function: cubic-bezier(.2, .7, .3, 1) }
  90% { transform: translate(0px, -61px) }
  100% { opacity: 1; transform: translate(0px, -56px) }
}
#pc-planes { animation: pc-planes 2.6s ease-out both }
#pc-axes { animation: pc-axes 2.6s ease-out both }
#pc-shadow { animation: pc-shadow 2.6s ease-out both }
#pc-bottom { animation: pc-bottom 2.6s cubic-bezier(.3, 1.3, .5, 1) both }
#pc-top { animation: pc-top 2.6s cubic-bezier(.3, 1.3, .5, 1) both }
@media (prefers-reduced-motion: reduce) {
  #pc-planes, #pc-axes, #pc-shadow, #pc-bottom, #pc-top { animation: none }
}
"""


# The loop: the same intro, then the top half bobs over its logo position forever.
# Listed second, the bob takes over pc-top's transform once its delay has run.
BOB_CSS = """
@keyframes pc-bob {
  0%, 100% { transform: translate(0px, -56px) }
  50% { transform: translate(0px, -64px) }
}
#pc-top {
  animation: pc-top 2.6s cubic-bezier(.3, 1.3, .5, 1) both,
             pc-bob 3.2s ease-in-out 2.6s infinite;
}
@media (prefers-reduced-motion: reduce) { #pc-top { animation: none } }
"""


def write_svg(name, body, w, h, vb=None, title="papercut"):
    vb = vb or (0, 0, w, h)
    path = os.path.join(OUT, name)
    open(path, "w").write(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb[0]:.2f} {vb[1]:.2f} {vb[2]:.2f} {vb[3]:.2f}" '
        f'width="{w:.0f}" height="{h:.0f}" role="img" aria-label="{title}">\n<title>{title}</title>\n'
        f'{body}\n</svg>\n')
    return path


def png(svg_path, width=4096):
    out = svg_path[:-4] + ".png"
    run("rsvg-convert", "-w", str(width), "--keep-aspect-ratio", svg_path, "-o", out)
    return out


# ---------------------------------------------------------------- glTF
FACTORS = {}


def hex_lin(h, a=1.0):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4) for x in c] + [a]


def cut_texture(glyph, W, cut_a, gx, gd, size=2048):
    """The cut face's dashed grid, laid out exactly as the 2D mark draws it.

    The cut plane does not depend on depth, so the cut face is a set of strips
    [a, b] x [0, DEPTH] in (face X, depth) coordinates; the texture covers
    X in [0, W] by depth in [0, DEPTH] and every cap vertex maps to u = X / W,
    v = depth / DEPTH.
    """
    from PIL import Image, ImageDraw
    from shapely.geometry import LineString
    far = 1000
    line = LineString([(-far, cut_a - SLOPE * far), (far, cut_a + SLOPE * far)])
    edge = glyph.intersection(line)
    segs = sorted((g for g in getattr(edge, "geoms", [edge]) if g.length > 0), key=lambda g: g.bounds[0])
    img = Image.new("RGB", (size, size), PAPER)
    d = ImageDraw.Draw(img)
    ux, vs = size / W, size / DEPTH
    width = 2.0                                       # the logo's grid stroke, in face units
    inset, min_len = 1.2, 1.2                         # the logo clips dashes 1.2 inside each strip
    px, pd = gx / 3, gd / 3
    hx, hd = 0.28 * px, 0.28 * pd
    for seg in segs:
        a, b = seg.bounds[0], seg.bounds[2]
        c = (a + b) / 2
        lo_x, hi_x, lo_s, hi_s = a + inset, b - inset, inset, DEPTH - inset
        xs = [c + i * gx for i in range(-int(W / gx) - 1, int(W / gx) + 2) if a < c + i * gx < b]

        def rect(x0, x1, s0, s1):
            x0, x1, s0, s1 = max(x0, lo_x), min(x1, hi_x), max(s0, lo_s), min(s1, hi_s)
            if x1 - x0 > 0 and s1 - s0 > 0 and max(x1 - x0, s1 - s0) >= min_len:
                d.rectangle([x0 * ux, s0 * vs, x1 * ux, s1 * vs], fill=GRID)

        for sdepth in (gd, 2 * gd, 3 * gd):          # dashes parallel to the cut edge
            j = math.floor((a - 6 - c) / px)
            while c + j * px < b + 6:
                m_ = c + j * px
                rect(m_ - hx, m_ + hx, sdepth - width / 2, sdepth + width / 2)
                j += 1
        for x in xs:                                  # dashes running back through the depth
            for j in range(0, int(DEPTH / pd) + 2):
                m_ = j * pd
                rect(x - width / 2, x + width / 2, m_ - hd, m_ + hd)
    return img


def export_glb(out_name):
    import trimesh
    from PIL import Image, ImageDraw
    from shapely import affinity
    from trimesh.visual.material import PBRMaterial
    from trimesh.visual.texture import TextureVisuals

    glyph = G["glyph_polygon"]()
    W = glyph.bounds[2]
    cut_a = CUT * H - SLOPE * W / 2
    m = MARGIN
    S = 0.01                                   # 100 logo units = 1 m
    lift = LIFT_SCREEN / 0.786                 # straight up, in local (unsquashed) units

    # local X/Y-down/depth -> glTF (y up, front face at z = 0, depth runs to -z)
    def P(X, Y, s):
        return np.array([X * S, (H - Y) * VSCALE * S, -s * S])

    # glyph outline in world xy, extruded back through the depth
    poly = affinity.affine_transform(glyph, [S, 0, 0, -VSCALE * S, 0, H * VSCALE * S])
    solid = trimesh.creation.extrude_polygon(poly, DEPTH * S)
    solid.apply_translation([0, 0, -DEPTH * S])

    # the cut: y + k*x = c, independent of depth
    k = SLOPE * VSCALE
    c = (H - cut_a) * VSCALE * S
    normal = np.array([k, 1.0, 0.0])
    origin = np.array([0.0, c, 0.0])
    top = trimesh.intersections.slice_mesh_plane(solid, normal, origin, cap=True)
    bottom = trimesh.intersections.slice_mesh_plane(solid, -normal, origin, cap=True)

    def mat(name, color, roughness=0.85, texture=None, double=False):
        # trimesh stores colour factors as 8 bits; the exact linear values are written
        # into the file afterwards (fix_materials), keyed by material name
        FACTORS[name] = hex_lin(color) if texture is None else [1.0, 1.0, 1.0, 1.0]
        return PBRMaterial(name=name, baseColorFactor=None, metallicFactor=0.0, roughnessFactor=roughness,
                           baseColorTexture=texture, doubleSided=double)

    # cut-face grid texture: one cell, dashed borders; a crossing dash at every
    # corner and two between, as on the logo
    gd = DEPTH / 4
    gx = gd / math.hypot(1, SLOPE)

    def split_faces(mesh, on_cut_test):
        fn = mesh.face_normals
        cut_idx, front_idx, wall_idx = [], [], []
        for i, f in enumerate(mesh.faces):
            vs = mesh.vertices[f]
            if on_cut_test(vs):
                cut_idx.append(i)
            elif abs(fn[i][2]) > 0.999:
                front_idx.append(i)
            else:
                wall_idx.append(i)
        sub = lambda idx: mesh.submesh([idx], append=True) if idx else None
        return sub(front_idx), sub(wall_idx), sub(cut_idx)

    on_plane = lambda vs: np.all(np.abs(vs[:, 1] + k * vs[:, 0] - c) < 1e-6)

    scene = trimesh.Scene()
    paper = mat("paper", PAPER)
    cut_mat = mat("cut_grid", PAPER, texture=cut_texture(glyph, W, cut_a, gx, gd))

    def add_piece(name, mesh, colors, textured_cut, parent):
        front, walls, cap = split_faces(mesh, on_plane)
        scene.graph.update(frame_from=parent, frame_to=name)
        if front is not None:
            front.visual = TextureVisuals(material=mat(f"{name}_face", colors["front"]))
            scene.add_geometry(front, geom_name=f"{name}_face", node_name=f"{name}_face", parent_node_name=name)
        if walls is not None:
            walls = trimesh.graph.smooth_shade(walls, angle=math.radians(30))  # round bowl, crisp corners
            walls.visual = TextureVisuals(material=mat(f"{name}_sides", colors["top"]))
            scene.add_geometry(walls, geom_name=f"{name}_sides", node_name=f"{name}_sides", parent_node_name=name)
        if cap is not None:
            if textured_cut:
                xs = cap.vertices[:, 0] / S
                s_depth = -cap.vertices[:, 2] / S
                # glTF v runs down the image, the texture's rows run along the depth
                cap.visual = TextureVisuals(uv=np.column_stack([xs / W, 1 - s_depth / DEPTH]), material=cut_mat)
                scene.add_geometry(cap, geom_name=f"{name}_cut", node_name=f"{name}_cut", parent_node_name=name)
            else:
                cap.visual = TextureVisuals(material=paper)
                scene.add_geometry(cap, geom_name=f"{name}_cut", node_name=f"{name}_cut", parent_node_name=name)

    root = "papercut"
    scene.graph.update(frame_from=scene.graph.base_frame, frame_to=root)
    add_piece("p_bottom", bottom, NAVY, True, root)
    add_piece("p_top", top, RED, False, root)
    lift_world = lift * VSCALE * S
    scene.graph.update(frame_from=root, frame_to="p_top",
                       matrix=trimesh.transformations.translation_matrix([0, lift_world, 0]))

    # three planes meeting in the back corner, gridded exactly as in the logo
    pg = G["plane_geometry"]()
    xs_, xo_, s0, s1, top_y = pg["xs"], pg["xo"], pg["s0"], pg["s1"], pg["top"]
    scene.graph.update(frame_from=root, frame_to="planes")

    def plane_tex(lines_u, lines_v, fill, line, size=1024):
        """lines_u: columns from the left; lines_v: rows from the top (fractions)."""
        img = Image.new("RGB", (size, size), fill)
        d = ImageDraw.Draw(img)
        lw = max(2, int(size * 0.016))
        for u in lines_u:
            d.rectangle([u * size - lw / 2, 0, u * size + lw / 2, size], fill=line)
        for v_ in lines_v:
            d.rectangle([0, v_ * size - lw / 2, size, v_ * size + lw / 2], fill=line)
        bw = max(2, int(size * 0.012))
        d.rectangle([0, 0, size - 1, size - 1], outline=line, width=bw)
        return img

    def quad(name, corners, uvs, tex):
        v = np.array(corners)
        mesh = trimesh.Trimesh(vertices=v, faces=[[0, 1, 2], [0, 2, 3]], process=False)
        FACTORS[name] = [1.0, 1.0, 1.0, 1.0]
        mesh.visual = TextureVisuals(uv=np.array(uvs), material=PBRMaterial(
            name=name, baseColorTexture=tex, metallicFactor=0.0, roughnessFactor=0.95, doubleSided=True))
        scene.add_geometry(mesh, geom_name=name, node_name=name, parent_node_name="planes")

    # UVs run u from the side wall / front edge, v up from the floor (trimesh's convention:
    # v = 1 is the image's top row), so image rows are 1 - v
    span_x, span_s, span_h = abs(xo_ - xs_), s1 - s0, H - top_y
    cols_x = [abs(x - xs_) / span_x for x in pg["xlines"]]
    rows_s = [1 - (sd - s0) / span_s for sd in pg["slines"]]
    cols_s = [(sd - s0) / span_s for sd in pg["slines"]]
    rows_h = [1 - (H - y) / span_h for y in pg["ylines"]]
    quad("floor", [P(xs_, H, s0), P(xo_, H, s0), P(xo_, H, s1), P(xs_, H, s1)],
         [(0, 0), (1, 0), (1, 1), (0, 1)], plane_tex(cols_x, rows_s, *PAL["PLANE_FILLS"]["floor"]))
    quad("back_wall", [P(xs_, H, s1), P(xo_, H, s1), P(xo_, top_y, s1), P(xs_, top_y, s1)],
         [(0, 0), (1, 0), (1, 1), (0, 1)], plane_tex(cols_x, rows_h, *PAL["PLANE_FILLS"]["back"]))
    quad("side_wall", [P(xs_, H, s0), P(xs_, H, s1), P(xs_, top_y, s1), P(xs_, top_y, s0)],
         [(0, 0), (1, 0), (1, 1), (0, 1)], plane_tex(cols_s, rows_h, *PAL["PLANE_FILLS"]["side"]))

    # axes from the back corner: solid along the planes, then a run of dots
    scene.graph.update(frame_from=root, frame_to="axes")
    corner = P(xs_, H, s1)
    ext_x, ext_y = 0.5 * span_x, 0.5 * span_s
    ext_z = (span_x + ext_x) / 0.786 - span_h          # same on-screen length as the others, as in the logo
    xsign = 1 if xo_ > xs_ else -1
    radius = 2.0 * S
    spacing = 9.23 / 0.866 * S * 0.866                 # the logo's dot spacing, in metres
    for axis, (edge, end) in {"x": (P(xo_, H, s1), P(xo_ + xsign * ext_x, H, s1)),
                              "y": (P(xs_, H, s0), P(xs_, H, s0 - ext_y)),
                              "z": (P(xs_, top_y, s1), P(xs_, top_y - ext_z, s1))}.items():
        node = f"axis_{axis}"
        scene.graph.update(frame_from="axes", frame_to=node)
        FACTORS[node] = hex_lin(PAL["AXIS_COLORS"][axis])
        amat = PBRMaterial(name=node, metallicFactor=0.0, roughnessFactor=0.6)
        rod = trimesh.creation.cylinder(radius=radius, segment=[corner, edge], sections=24)
        rod.visual = TextureVisuals(material=amat)
        scene.add_geometry(rod, geom_name=f"{node}_line", node_name=f"{node}_line", parent_node_name=node)
        direction = (end - edge) / np.linalg.norm(end - edge)
        n_dots = int(np.linalg.norm(end - edge) / spacing)
        dots = []
        for i in range(1, n_dots + 1):
            ball = trimesh.creation.icosphere(subdivisions=2, radius=radius)
            ball.apply_translation(edge + direction * spacing * i)
            dots.append(ball)
        dot_mesh = trimesh.util.concatenate(dots)
        dot_mesh.visual = TextureVisuals(material=amat)
        scene.add_geometry(dot_mesh, geom_name=f"{node}_dots", node_name=f"{node}_dots", parent_node_name=node)

    glb = scene.export(file_type="glb", include_normals=True)
    path = os.path.join(OUT, out_name)
    open(path, "wb").write(glb)
    add_camera_and_animation(path, lift_world, scene.bounds)
    return path


def add_camera_and_animation(path, lift_world, bounds):
    """An orthographic iso camera that reproduces the logo, and a 'split' clip for the top half."""
    import struct

    import pygltflib
    g = pygltflib.GLTF2().load(path)
    names = {n.name: i for i, n in enumerate(g.nodes)}
    for m in g.materials:                       # exact linear colours (see mat())
        if m.name in FACTORS:
            m.pbrMetallicRoughness.baseColorFactor = FACTORS[m.name]

    # true isometric: from (1, 1, 1). With heights pre-scaled by 0.786 this matches the logo.
    right = np.array([1, 0, -1]) / math.sqrt(2)
    up = np.array([-1, 2, -1]) / math.sqrt(6)
    back = np.array([1, 1, 1]) / math.sqrt(3)
    R = np.column_stack([right, up, back])
    qw = math.sqrt(max(0, 1 + R[0, 0] + R[1, 1] + R[2, 2])) / 2
    qx = (R[2, 1] - R[1, 2]) / (4 * qw)
    qy = (R[0, 2] - R[2, 0]) / (4 * qw)
    qz = (R[1, 0] - R[0, 1]) / (4 * qw)
    lo, hi = np.array(bounds[0]), np.array(bounds[1])
    box = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
    target = (lo + hi) / 2
    rel = box - target
    mag = 1.06 * max(np.abs(rel @ right).max(), np.abs(rel @ up).max())
    eye = target + back * 10.0
    g.cameras.append(pygltflib.Camera(type="orthographic", name="logo_iso",
                                      orthographic=pygltflib.Orthographic(xmag=float(mag), ymag=float(mag),
                                                                          znear=0.01, zfar=40.0)))
    g.nodes.append(pygltflib.Node(name="camera_logo_iso", camera=len(g.cameras) - 1,
                                  translation=eye.tolist(), rotation=[qx, qy, qz, qw]))
    g.scenes[g.scene].nodes.append(len(g.nodes) - 1)

    # 'split': the top half rises from closed to its logo position, easing out
    times = np.linspace(0.0, 1.2, 13, dtype=np.float32)
    ease = 1 - (1 - times / times[-1]) ** 3
    trans = np.zeros((len(times), 3), dtype=np.float32)
    trans[:, 1] = ease * lift_world
    blob = g.binary_blob()
    off = len(blob)
    pad = (4 - off % 4) % 4
    data = bytes(pad) + times.tobytes() + trans.tobytes()
    g.set_binary_blob(blob + data)
    g.buffers[0].byteLength = len(blob) + len(data)
    bv_t = len(g.bufferViews)
    g.bufferViews.append(pygltflib.BufferView(buffer=0, byteOffset=off + pad, byteLength=times.nbytes))
    g.bufferViews.append(pygltflib.BufferView(buffer=0, byteOffset=off + pad + times.nbytes, byteLength=trans.nbytes))
    a_t = len(g.accessors)
    g.accessors.append(pygltflib.Accessor(bufferView=bv_t, componentType=pygltflib.FLOAT, count=len(times),
                                          type="SCALAR", min=[float(times[0])], max=[float(times[-1])]))
    g.accessors.append(pygltflib.Accessor(bufferView=bv_t + 1, componentType=pygltflib.FLOAT, count=len(times),
                                          type="VEC3"))
    g.animations.append(pygltflib.Animation(
        name="split",
        samplers=[pygltflib.AnimationSampler(input=a_t, output=a_t + 1, interpolation="LINEAR")],
        channels=[pygltflib.AnimationChannel(sampler=0, target=pygltflib.AnimationChannelTarget(
            node=names["p_top"], path="translation"))]))
    g.save(path)


# ---------------------------------------------------------------- favicon
# The browser-tab icon: the cut p alone (no planes, no axes), the top half lifted
# half as far as in the logo so the cut still shows in a compact shape, with heavier
# outlines and no cut-face grid so it holds at 16px. One SVG carries both palettes and
# shows the dark one when the browser is dark.
FAVICON_LIFT = LIFT_SCREEN / 2
FAVICON_WEIGHT = 2.2                 # outline widths, relative to the logo's


def favicon_body(tag):
    apply_palette(tag)
    pid = f"fav{tag}"
    G["PATH_SIMPLIFY"] = 0.4         # well under a pixel at favicon sizes
    try:
        G["make_board"](f"_{pid}.dc.html", pid, "X", "favicon", "", G["NAVY"], G["RED"], PAL["BG"], G["LEFT_FACE"],
                        frame="bare", cut=CUT, slope=SLOPE, lift=(0.0, -FAVICON_LIFT), cardboard=False)
    finally:
        G["PATH_SIMPLIFY"] = 0.0
    raw = open(os.path.join(G["WORK_DIR"], f"{pid}_preview.svg")).read()
    css = re.search(r"<style>(.*?)</style>", raw).group(1)
    for cls in ("sil", "edge"):
        css = re.sub(rf"(\.{cls}{{[^}}]*stroke-width:)([\d.]+)",
                     lambda m: f"{m.group(1)}{float(m.group(2)) * FAVICON_WEIGHT:.2f}", css)
    mark = re.search(r"<defs>(.*)</defs>", raw, re.S).group(1)
    mark = re.sub(r'<line[^>]*class="grid"[^>]*></line>', "", mark)
    # a tenth of a unit is far below a pixel at favicon sizes; one decimal halves the file
    mark = re.sub(r"(\d+\.\d)\d+", r"\1", mark)
    return inline_css(mark, css)


def export_favicon():
    light, dark = favicon_body("light"), favicon_body("dark")
    tmp = os.path.join(OUT, "_favicon_full.svg")
    open(tmp, "w").write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">{light}</svg>')
    x0, y0, x1, y1 = alpha_bbox(tmp, 400, 400)
    os.remove(tmp)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2

    def square(scale):
        side = max(x1 - x0, y1 - y0) * scale
        return (cx - side / 2, cy - side / 2, side, side)

    vb = square(1.04)
    themed = ('<style>#favicon-dark { display: none }'
              '@media (prefers-color-scheme: dark) { #favicon-light { display: none } #favicon-dark { display: inline } }'
              '</style>\n'
              f'<g id="favicon-light">{light}</g>\n<g id="favicon-dark">{dark}</g>')
    write_svg("papercut-favicon.svg", themed, 32, 32, vb, "papercut")
    # PNG fallback for browsers without SVG favicons: the light one
    light_svg = write_svg("_favicon-light.svg", light, 32, 32, vb, "papercut")
    run("rsvg-convert", "-w", "32", "-h", "32", light_svg, "-o", os.path.join(OUT, "papercut-favicon-32.png"))
    os.remove(light_svg)
    # iOS home-screen icon: must be opaque, so the same mark on the paper tile
    tvb = square(1.32)
    tile = (f'<rect x="{tvb[0]:.2f}" y="{tvb[1]:.2f}" width="{tvb[2]:.2f}" height="{tvb[3]:.2f}" '
            f'fill="{PALETTES["light"]["BG"]}"/>')
    tile_svg = write_svg("_apple-touch.svg", tile + light, 180, 180, tvb, "papercut")
    run("rsvg-convert", "-w", "180", "-h", "180", tile_svg, "-o", os.path.join(OUT, "papercut-apple-touch-icon.png"))
    os.remove(tile_svg)
    # the editor serves its icons from its public folder (Vite copies that as-is into
    # the Pages build), so it gets copies of these three
    public = os.path.join(HERE, "..", "..", "apps", "editor", "public")
    if os.path.isdir(public):
        for name in ("papercut-favicon.svg", "papercut-favicon-32.png", "papercut-apple-touch-icon.png"):
            shutil.copyfile(os.path.join(OUT, name), os.path.join(public, name))


def export_all(tag):
    apply_palette(tag)
    sfx = "" if tag == "light" else f"-{tag}"
    mark_body, vb = export_mark(tag)
    mark_svg = write_svg(f"papercut-mark{sfx}.svg", mark_body, vb[2] * 2, vb[3] * 2, vb, "papercut mark")
    css = ANIMATION_CSS.replace("SHADOW", str(PAL["SHADOW_OPACITY"]))   # fade the shadow in to its own opacity
    write_svg(f"papercut-mark-animated{sfx}.svg", f"<style>{css}</style>\n{mark_body}",
              vb[2] * 2, vb[3] * 2, vb, "papercut mark")
    # the bob lifts the top 8 units above its logo position; keep that inside the frame
    lvb = (vb[0], vb[1] - 8, vb[2], vb[3] + 8)
    write_svg(f"papercut-mark-loop{sfx}.svg", f"<style>{css}{BOB_CSS}</style>\n{mark_body}",
              lvb[2] * 2, lvb[3] * 2, lvb, "papercut mark")

    wm_body, (ww, wh) = export_wordmark()
    wm_scale = 1 / 10                                   # font units -> SVG units
    write_svg(f"papercut-wordmark{sfx}.svg", f'<g transform="scale({wm_scale})">{wm_body}</g>',
              ww * wm_scale * 4, wh * wm_scale * 4, (0, 0, ww * wm_scale, wh * wm_scale), "papercut")

    # lockups: the mark is drawn in its own viewBox units; place both in one coordinate space
    mw, mh = vb[2], vb[3]
    wmw, wmh = ww * wm_scale, wh * wm_scale
    mark_g = lambda x, y, h: (f'<g transform="translate({x:.2f} {y:.2f}) scale({h / mh:.5f}) '
                              f'translate({-vb[0]:.2f} {-vb[1]:.2f})">{mark_body}</g>')
    word_g = lambda x, y, w: (f'<g transform="translate({x:.2f} {y:.2f}) scale({w / wmw * wm_scale:.5f})">'
                              f'{wm_body}</g>')
    # horizontal: mark 1.9x the wordmark's height, wordmark centred on it
    hh = wmh * 1.9
    hw = mh and hh * mw / mh
    gap = hh * 0.12
    total_w = hw + gap + wmw
    body = mark_g(0, 0, hh) + word_g(hw + gap, (hh - wmh) / 2, wmw)
    write_svg(f"papercut-lockup-horizontal{sfx}.svg", body, total_w * 4, hh * 4, (0, 0, total_w, hh))
    # stacked: mark as wide as 0.8 of the wordmark, centred above it
    sw_ = wmw * 0.8
    sh = sw_ * mh / mw
    gap = sh * 0.06
    body = mark_g((wmw - sw_) / 2, 0, sh) + word_g(0, sh + gap, wmw)
    write_svg(f"papercut-lockup-stacked{sfx}.svg", body, wmw * 4, (sh + gap + wmh) * 4, (0, 0, wmw, sh + gap + wmh))

    for name in ("papercut-mark", "papercut-wordmark", "papercut-lockup-horizontal", "papercut-lockup-stacked"):
        png(os.path.join(OUT, name + sfx + ".svg"))

    print("glb:", export_glb(f"papercut-mark{sfx}.glb"))


if __name__ == "__main__":
    for tag in PALETTES:
        export_all(tag)
    export_favicon()
    for f in sorted(os.listdir(OUT)):
        print(f, os.path.getsize(os.path.join(OUT, f)))
