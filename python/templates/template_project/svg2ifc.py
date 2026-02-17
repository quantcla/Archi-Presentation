# -------------------------------------------------------------------------------------------------
# ONE-SHOT FULL PIPELINE (Bonsai / Blender)
# - Builds IFC from plan.svg (walls + hosted windows/doors using TEMPLATE TYPES)
# - Uses template type models (case-insensitive type name match):
#   Walls: wall
#   Doors: double_slide, double_swing, single_slide, single_swing
#   Windows: double_horizontal, double_vertical, single, triple_horizontal, triple_vertical
# - Per-instance scaling via MAPPED-ITEM scaling (keeps depth, scales width+height)
# - Robust exporting:
#   * discovers/tries Bonsai export ops (export/plot/save/print)
#   * collects/copies any produced SVG/PDF into //exports/_FLAT
#   * fixes SHEET SVG (centers drawing image, embeds linked images, fixes hrefs)
#   * converts SVG->PDF (Inkscape) and SVG->DXF (vector-only)
#
# IMPORTANT FIXES (why your windows/doors disappeared after adding export):
# - Disable global undo while running BIM ops to prevent bonsai undo_post KeyError rollback
# - Always write IFC to disk BEFORE calling any bpy.ops.bim.* export/drawing/sheet ops
# - Reload IFC using the correct filepath AFTER write, then load_project_elements
#
# REQUIREMENTS
# 1) Open your prepared TEMPLATE .blend with Bonsai project loaded (IfcStore must exist)
# 2) Place plan.svg next to the .blend
# 3) Your plan.svg uses:
#    - black filled rects for walls
#    - red filled rects for windows (id like w2-TRIPLE_HORIZONTAL-2.6-0.2-1.8)
#    - gray filled rects for doors (id like d1-DOUBLE_SWING-1.8-2.10)
# -------------------------------------------------------------------------------------------------

import os, re, math, time, glob, traceback, subprocess, shutil, base64, urllib.parse
import xml.etree.ElementTree as ET

import bpy
import numpy as np

# --- Bonsai / IfcOpenShell ---
try:
    from bonsai.bim.ifc import IfcStore
except Exception:
    from blenderbim.bim.ifc import IfcStore

import ifcopenshell
from ifcopenshell.api import run
import ifcopenshell.util.representation as rep_util
import ifcopenshell.geom as ifcgeom


# =========================
# CONFIG
# =========================
SVG_PATH = bpy.path.abspath("//plan.svg")
OUT_IFC  = bpy.path.abspath("//generated.ifc")
LOG_PATH = bpy.path.abspath("//svg2ifc_export.log")

EXPORT_DIR = bpy.path.abspath("//exports")
os.makedirs(EXPORT_DIR, exist_ok=True)

# --- TYPE TOKENS / TEMPLATE TYPE NAMES (case-insensitive) ---
TYPE_WALL = "wall"

DOOR_TYPE_KEYS = ["double_slide", "double_swing", "single_slide", "single_swing"]
DEFAULT_DOOR_TYPE = "single_swing"

WIN_TYPE_KEYS  = ["double_horizontal", "double_vertical", "single", "triple_horizontal", "triple_vertical"]
DEFAULT_WIN_TYPE = "single"

# Defaults (meters)
DEFAULT_WALL_HEIGHT = 3.00
DEFAULT_OPENING_DEPTH_ACROSS_WALL = 1.00   # must cut across wall
DEFAULT_FALLBACK_SILL = 0.90
DEFAULT_FALLBACK_WIN_H = 1.20
DEFAULT_FALLBACK_DOOR_H = 2.10

# Cleanup
CLEANUP_PREVIOUS = True
GEN_PREFIX = "SVGGEN_"

# SVG->DXF sampling
CURVE_SEGMENTS = 32

# PDF conversion via Inkscape
CONVERT_SVG_TO_PDF = True

# Sheet hints (used only to detect sheet/layout exports)
SHEET_HINT = "A01"
SHEET_HINT_2 = "untitled"

# Sheet svg fix behavior
REMOVE_BG_IMAGE = True
BG_AREA_THRESHOLD = 0.70
BG_ORIGIN_EPS = 10.0


# =========================
# LOGGING
# =========================
def log(msg: str):
    s = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(s)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(s + "\n")
    except:
        pass

def reset_log():
    try:
        with open(LOG_PATH, "w", encoding="utf-8") as f:
            f.write("")
    except:
        pass


# =========================
# SAFE UI / CONTEXT HELPERS
# =========================
def set_safe_tool():
    try:
        bpy.ops.wm.tool_set_by_id(name="builtin.select_box")
    except:
        pass

def deselect_all():
    try:
        if bpy.context.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
        bpy.ops.object.select_all(action='DESELECT')
        bpy.context.view_layer.objects.active = None
    except:
        pass

def _find_area_override(area_type: str):
    wm = bpy.context.window_manager
    for win in getattr(wm, "windows", []):
        scr = win.screen
        for area in scr.areas:
            if area.type == area_type:
                for region in area.regions:
                    if region.type == "WINDOW":
                        return {"window": win, "screen": scr, "area": area, "region": region}
    return None

def run_op(op_callable, **kw):
    try:
        return op_callable(**kw)
    except Exception as e1:
        for area_type in ("PROPERTIES", "VIEW_3D", "OUTLINER"):
            ovr = _find_area_override(area_type)
            if ovr:
                try:
                    with bpy.context.temp_override(**ovr):
                        return op_callable(**kw)
                except Exception:
                    pass
        raise e1

def ensure_object_mode():
    try:
        if bpy.context.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
    except:
        pass


# =========================
# IFC HELPERS
# =========================
def get_ifc():
    ifc = None
    if hasattr(IfcStore, "get_file"):
        ifc = IfcStore.get_file()
    elif hasattr(IfcStore, "get"):
        ifc = IfcStore.get()
    else:
        ifc = getattr(IfcStore, "file", None)
    if ifc is None:
        raise RuntimeError("No IFC loaded. Open your prepared template .blend with Bonsai project loaded.")
    return ifc

def try_set_bonsai_ifc_path(path_abs):
    p = os.path.abspath(path_abs).replace("\\", "/")
    try:
        IfcStore.path = p
        log(f"[BIM] IfcStore.path set to {p}")
    except:
        pass

    # Also try to set any scene string props that look like IFC path
    scene = bpy.context.scene
    for attr in dir(scene):
        obj = getattr(scene, attr, None)
        if obj is None or not hasattr(obj, "bl_rna"):
            continue
        for prop in obj.bl_rna.properties:
            if prop.type != 'STRING':
                continue
            pid = prop.identifier.lower()
            if ("ifc" in pid) and ("file" in pid or "path" in pid) and ("bcf" not in pid):
                try:
                    setattr(obj, prop.identifier, p)
                except:
                    pass

def pick_storey(ifc):
    st = ifc.by_type("IfcBuildingStorey") or []
    if st: return st[0]
    b = ifc.by_type("IfcBuilding") or []
    if b: return b[0]
    s = ifc.by_type("IfcSite") or []
    if s: return s[0]
    raise RuntimeError("No Storey/Building/Site found in IFC.")

def body_context(ifc):
    ctx = rep_util.get_context(ifc, "Model", "Body", "MODEL_VIEW")
    if ctx: return ctx
    for sc in (ifc.by_type("IfcGeometricRepresentationSubContext") or []):
        if (sc.ContextIdentifier or "") == "Body":
            return sc
    raise RuntimeError("No Model/Body/MODEL_VIEW context found in IFC.")

def remove_previous_generated(ifc):
    removed = 0
    for cls in ("IfcWall", "IfcWallStandardCase", "IfcDoor", "IfcWindow", "IfcOpeningElement"):
        for p in list(ifc.by_type(cls) or []):
            if (getattr(p, "Name", "") or "").startswith(GEN_PREFIX):
                try:
                    run("root.remove_product", ifc, product=p)
                except:
                    try:
                        ifc.remove(p)
                    except:
                        pass
                removed += 1
    log(f"[CLEAN] Removed {removed} items.")

def place_matrix(ifc, product, M4):
    run("geometry.edit_object_placement", ifc, product=product, matrix=M4)


# =========================
# SVG PARSING
# =========================
def parse_length_mm(s):
    if s is None: return None
    s = str(s).strip()
    m = re.match(r"^\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*([a-zA-Z%]*)\s*$", s)
    if not m: return None
    val = float(m.group(1))
    unit = (m.group(2) or "").lower()
    if unit in ("", "px"):
        return None
    if unit == "mm": return val
    if unit == "cm": return val * 10.0
    if unit == "m":  return val * 1000.0
    if unit == "in": return val * 25.4
    if unit == "pt": return val * (25.4 / 72.0)
    return None

def parse_style(style_str: str):
    d = {}
    if not style_str: return d
    parts = [p.strip() for p in style_str.split(";") if p.strip()]
    for p in parts:
        if ":" in p:
            k, v = p.split(":", 1)
            d[k.strip().lower()] = v.strip()
    return d

def parse_color(s):
    if not s: return None
    s = s.strip().lower()
    if s in ("none", "transparent"): return None
    if s.startswith("#"):
        hx = s[1:]
        if len(hx) == 3:
            return (int(hx[0]*2,16), int(hx[1]*2,16), int(hx[2]*2,16))
        if len(hx) == 6:
            return (int(hx[0:2],16), int(hx[2:4],16), int(hx[4:6],16))
    m = re.match(r"rgb\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*\)", s)
    if m:
        return (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return None

def classify_fill(rgb):
    if rgb is None: return None
    r,g,b = rgb
    if r < 50 and g < 50 and b < 50: return "wall"
    if r > 180 and g < 100 and b < 100: return "window"
    if abs(r-g) < 25 and abs(g-b) < 25 and 80 < r < 200: return "door"
    return None

def parse_transform(transform_str: str):
    M = np.identity(3, dtype=float)
    if not transform_str:
        return M
    s = transform_str.strip()
    func_re = re.compile(r"([a-zA-Z]+)\s*\(([^)]*)\)")
    for fn, args_str in func_re.findall(s):
        fn = fn.lower()
        args = [a for a in re.split(r"[,\s]+", args_str.strip()) if a]
        vals = [float(a) for a in args] if args else []
        T = np.identity(3, dtype=float)

        if fn == "translate":
            tx = vals[0] if len(vals) > 0 else 0.0
            ty = vals[1] if len(vals) > 1 else 0.0
            T = np.array([[1,0,tx],[0,1,ty],[0,0,1]], dtype=float)
        elif fn == "scale":
            sx = vals[0] if len(vals) > 0 else 1.0
            sy = vals[1] if len(vals) > 1 else sx
            T = np.array([[sx,0,0],[0,sy,0],[0,0,1]], dtype=float)
        elif fn == "rotate":
            ang = math.radians(vals[0] if len(vals)>0 else 0.0)
            cx = vals[1] if len(vals)>2 else 0.0
            cy = vals[2] if len(vals)>2 else 0.0
            c = math.cos(ang); si = math.sin(ang)
            R = np.array([[c,-si,0],[si,c,0],[0,0,1]], dtype=float)
            T1 = np.array([[1,0,cx],[0,1,cy],[0,0,1]], dtype=float)
            T2 = np.array([[1,0,-cx],[0,1,-cy],[0,0,1]], dtype=float)
            T = T1 @ R @ T2
        elif fn == "matrix":
            if len(vals) >= 6:
                a,b,c,d,e,f = vals[:6]
                T = np.array([[a,c,e],[b,d,f],[0,0,1]], dtype=float)

        M = M @ T
    return M

def apply_transform(points, M):
    out = []
    for x,y in points:
        v = np.array([x,y,1.0], dtype=float)
        r = M @ v
        out.append((float(r[0]), float(r[1])))
    return out

def parse_points_attr(s: str):
    if not s: return None
    nums = [float(x) for x in re.split(r"[,\s]+", s.strip()) if x]
    if len(nums) < 6: return None
    pts = [(nums[i], nums[i+1]) for i in range(0, len(nums), 2)]
    if pts[0] != pts[-1]:
        pts.append(pts[0])
    return pts

def rect_to_poly(x,y,w,h):
    return [(x,y),(x+w,y),(x+w,y+h),(x,y+h),(x,y)]

def iter_floorplan_shapes(root):
    def strip_ns(tag):
        return tag.split("}",1)[-1] if "}" in tag else tag

    def walk(node, parent_M):
        M_here = parent_M @ parse_transform(node.get("transform"))
        tag = strip_ns(node.tag)

        style = parse_style(node.get("style"))
        fill = node.get("fill") or style.get("fill")
        rgb = parse_color(fill)
        cls = classify_fill(rgb)

        elem_id = node.get("id") or node.get("{http://www.inkscape.org/namespaces/inkscape}label") or ""

        poly = None
        if tag == "rect":
            x = float(node.get("x") or 0.0)
            y = float(node.get("y") or 0.0)
            w = float(node.get("width") or 0.0)
            h = float(node.get("height") or 0.0)
            if w > 0 and h > 0:
                poly = rect_to_poly(x,y,w,h)
        elif tag in ("polygon","polyline"):
            poly = parse_points_attr(node.get("points") or "")
        elif tag == "path":
            # plan.svg is rect-based; if you later use paths, add a proper path->poly here
            poly = None

        if poly and cls in ("wall","window","door"):
            poly_t = apply_transform(poly, M_here)
            yield (cls, poly_t, elem_id)

        for ch in list(node):
            yield from walk(ch, M_here)

    yield from walk(root, np.identity(3, dtype=float))

def compute_svg_unit_to_meter(root):
    vb = root.get("viewBox")
    vb_w = None
    if vb:
        parts = [float(x) for x in re.split(r"[,\s]+", vb.strip()) if x]
        if len(parts) == 4:
            vb_w = parts[2]
    width_mm = parse_length_mm(root.get("width"))
    if width_mm is not None and vb_w is not None and vb_w > 1e-9:
        unit_to_mm = width_mm / vb_w
    else:
        unit_to_mm = 1.0
    return unit_to_mm * 0.1  # ALWAYS 1:100


# =========================
# GEOMETRY HELPERS
# =========================
def poly_centroid(pts):
    xs = [p[0] for p in pts[:-1]]
    ys = [p[1] for p in pts[:-1]]
    return (sum(xs)/len(xs), sum(ys)/len(ys))

def dist_point_to_segment(px,py, ax,ay, bx,by):
    vx = bx-ax; vy = by-ay
    wx = px-ax; wy = py-ay
    vv = vx*vx + vy*vy
    if vv <= 1e-12:
        return math.hypot(px-ax, py-ay), 0.0
    t = (wx*vx + wy*vy) / vv
    t = max(0.0, min(1.0, t))
    cx = ax + t*vx
    cy = ay + t*vy
    return math.hypot(px-cx, py-cy), t

def closest_wall_edge(wall_poly, px, py):
    best = (1e18, None, None)
    for i in range(len(wall_poly)-1):
        ax,ay = wall_poly[i]
        bx,by = wall_poly[i+1]
        d,t = dist_point_to_segment(px,py, ax,ay, bx,by)
        if d < best[0]:
            best = (d, (ax,ay,bx,by), t)
    return best

def unit(vx,vy):
    n = math.hypot(vx,vy)
    if n < 1e-12:
        return (1.0, 0.0)
    return (vx/n, vy/n)

def build_xy_rotation_matrix(x, y, z, ux, uy):
    vx, vy = (-uy, ux)
    return np.array([
        [ux, vx, 0.0, x],
        [uy, vy, 0.0, y],
        [0.0,0.0,1.0, z],
        [0.0,0.0,0.0,1.0]
    ], dtype=float)

def opening_width_from_rect(poly_w, ux, uy):
    vx, vy = (-uy, ux)
    us = [p[0]*ux + p[1]*uy for p in poly_w[:-1]]
    vs = [p[0]*vx + p[1]*vy for p in poly_w[:-1]]
    return max(max(us)-min(us), max(vs)-min(vs))


# =========================
# TYPE RESOLUTION (CASE-INSENSITIVE)
# =========================
def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())

def find_type_ci(ifc, cls: str, name: str):
    target = _norm(name)
    if not target:
        return None
    for t in (ifc.by_type(cls) or []):
        if _norm(getattr(t, "Name", "") or "") == target:
            return t
    return None

def normalize_type_token(kind: str, raw: str):
    s = (raw or "").strip().lower()
    s = s.replace(" ", "_").replace("__", "_")
    s = re.sub(r"[^a-z0-9_]+", "_", s)

    if kind == "WINDOW":
        if "triple" in s and "horizontal" in s: return "triple_horizontal"
        if "triple" in s and "vertical"   in s: return "triple_vertical"
        if "double" in s and "horizontal" in s: return "double_horizontal"
        if "double" in s and "vertical"   in s: return "double_vertical"
        if "single" in s: return "single"
        for k in WIN_TYPE_KEYS:
            if _norm(k) in _norm(s): return k
        return DEFAULT_WIN_TYPE

    if kind == "DOOR":
        if "double" in s and "swing" in s: return "double_swing"
        if "double" in s and "slide" in s: return "double_slide"
        if "single" in s and "swing" in s: return "single_swing"
        if "single" in s and "slide" in s: return "single_slide"
        for k in DOOR_TYPE_KEYS:
            if _norm(k) in _norm(s): return k
        return DEFAULT_DOOR_TYPE

    return s

def parse_spec_from_eid(eid: str):
    """
    Window: w2-TRIPLE_HORIZONTAL-2.6-0.2-1.8  => width=2.6 sill=0.2 height=1.8
    Door  : d1-DOUBLE_SWING-1.8-2.10          => width=1.8 height=2.10
    """
    s = (eid or "").strip()
    if not s:
        return None, None, None, None, None

    toks = [t for t in s.split("-") if t]
    if len(toks) < 2:
        return None, None, None, None, None

    head = toks[0].lower()
    if head.startswith("w"):
        kind = "WINDOW"
    elif head.startswith("d"):
        kind = "DOOR"
    else:
        return None, None, None, None, None

    raw_type = toks[1]
    type_token = normalize_type_token(kind, raw_type)

    nums = []
    for t in toks[2:]:
        try:
            nums.append(float(t))
        except ValueError:
            break

    if kind == "WINDOW":
        width  = nums[0] if len(nums) >= 1 else None
        sill   = nums[1] if len(nums) >= 2 else DEFAULT_FALLBACK_SILL
        height = nums[2] if len(nums) >= 3 else DEFAULT_FALLBACK_WIN_H
    else:
        width  = nums[0] if len(nums) >= 1 else None
        sill   = 0.0
        height = nums[1] if len(nums) >= 2 else DEFAULT_FALLBACK_DOOR_H

    return kind, type_token, width, sill, height


# =========================
# OPENING + WALL GEOMETRY
# =========================
def make_opening_rep(ifc, ctx, width, depth_across, height):
    pts = [(-width/2, -depth_across/2), (width/2, -depth_across/2),
           (width/2, depth_across/2), (-width/2, depth_across/2),
           (-width/2, -depth_across/2)]
    prof = run("profile.add_arbitrary_profile", ifc, profile=pts, name="OPENING_PROFILE")
    rep  = run("geometry.add_profile_representation", ifc, context=ctx, profile=prof, depth=height)
    return rep

def make_wall_rep_from_poly(ifc, ctx, poly_local, height):
    prof = run("profile.add_arbitrary_profile", ifc, profile=poly_local, name="WALL_PROFILE")
    rep  = run("geometry.add_profile_representation", ifc, context=ctx, profile=prof, depth=height)
    return rep


# =========================
# MAPPED-ITEM SCALING (ROBUST)
# =========================
def bbox_local(product):
    settings = ifcgeom.settings()
    settings.set(settings.USE_WORLD_COORDS, False)
    shape = ifcgeom.create_shape(settings, product)
    v = shape.geometry.verts
    xs = v[0::3]; ys = v[1::3]; zs = v[2::3]
    return (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))

def set_mapped_scale_and_center_ALL_REPS_KEEP_DEPTH(ifc, product, target_width, target_height):
    """
    Scales any IfcMappedItem MappingTarget found in ALL representations.
    Keeps depth (Y) scale at 1.0. Scales width (X) and height (Z).
    Also recenters so bbox remains centered after scaling.
    """
    if not getattr(product, "Representation", None):
        return None

    try:
        mnx, mny, mnz, mxx, mxy, mxz = bbox_local(product)
    except Exception as e:
        log(f"[SCALE] bbox failed for {getattr(product,'Name','?')}: {e}")
        return None

    dx = mxx-mnx; dy = mxy-mny; dz = mxz-mnz
    if dx < 1e-6 or dy < 1e-6 or dz < 1e-6:
        return None

    sx = float(target_width) / float(dx)
    sy = 1.0  # KEEP DEPTH
    sz = float(target_height) / float(dz)

    cx = (mnx+mxx)/2.0
    cy = (mny+mxy)/2.0
    ox = -sx*cx
    oy = -sy*cy

    def make_3d_op():
        return ifc.create_entity(
            "IfcCartesianTransformationOperator3DnonUniform",
            Axis1=ifc.create_entity("IfcDirection", DirectionRatios=(1.0,0.0,0.0)),
            Axis2=ifc.create_entity("IfcDirection", DirectionRatios=(0.0,1.0,0.0)),
            Axis3=ifc.create_entity("IfcDirection", DirectionRatios=(0.0,0.0,1.0)),
            LocalOrigin=ifc.create_entity("IfcCartesianPoint", Coordinates=(float(ox), float(oy), 0.0)),
            Scale=float(sx), Scale2=float(sy), Scale3=float(sz)
        )

    def make_2d_op():
        return ifc.create_entity(
            "IfcCartesianTransformationOperator2DnonUniform",
            Axis1=ifc.create_entity("IfcDirection", DirectionRatios=(1.0,0.0)),
            Axis2=ifc.create_entity("IfcDirection", DirectionRatios=(0.0,1.0)),
            LocalOrigin=ifc.create_entity("IfcCartesianPoint", Coordinates=(float(ox), float(oy))),
            Scale=float(sx), Scale2=float(sy)
        )

    reps = product.Representation.Representations or []
    touched = 0
    for rep in reps:
        for it in (rep.Items or []):
            if not it.is_a("IfcMappedItem"):
                continue
            mt = getattr(it, "MappingTarget", None)
            if mt and (mt.is_a("IfcCartesianTransformationOperator2D") or mt.is_a("IfcCartesianTransformationOperator2DnonUniform")):
                it.MappingTarget = make_2d_op()
            else:
                it.MappingTarget = make_3d_op()
            touched += 1

    return (sx, sy, sz, touched)


# =========================
# EXPORT HELPERS (ROBUST)
# =========================
def _op_props(op_callable):
    try:
        rna = op_callable.get_rna_type()
        props = []
        for p in rna.properties:
            if p.identifier in {"rna_type"}:
                continue
            props.append(p.identifier)
        return set(props)
    except:
        return set()

def _call_bim_op_flexible(op_name, desired_kwargs):
    bim = getattr(bpy.ops, "bim", None)
    if not bim or not hasattr(bim, op_name):
        return False
    op = getattr(bim, op_name)
    props = _op_props(op)
    kwargs = {k: v for k, v in desired_kwargs.items() if k in props}
    try:
        res = run_op(op, **kwargs) if kwargs else run_op(op)
        return isinstance(res, set) and "FINISHED" in res
    except TypeError:
        try:
            res = run_op(op)
            return isinstance(res, set) and "FINISHED" in res
        except Exception:
            return False
    except Exception:
        return False

def _find_propgroup(scene, required_collection_name: str):
    for nm in ("BIMDrawingProperties", "BIMSheetProperties", "BIMDocumentProperties", "BIMProperties"):
        pg = getattr(scene, nm, None)
        if pg and hasattr(pg, required_collection_name):
            col = getattr(pg, required_collection_name)
            try:
                _ = len(col)
                return pg
            except:
                pass
    for attr in dir(scene):
        pg = getattr(scene, attr, None)
        if pg is None or not hasattr(pg, "bl_rna"):
            continue
        if hasattr(pg, required_collection_name):
            col = getattr(pg, required_collection_name)
            try:
                _ = len(col)
                return pg
            except:
                pass
    return None

def _find_collection_items_by_name(collection, hints_any):
    items = []
    for i, it in enumerate(collection):
        nm = (getattr(it, "name", None) or getattr(it, "Name", None) or getattr(it, "title", None) or "")
        items.append((i, str(nm)))
    if not hints_any:
        return items, None
    hints = [h.lower() for h in hints_any if h]
    best = None
    for i, nm in items:
        l = nm.lower()
        if all(h in l for h in hints):
            best = i
            break
    if best is None:
        for i, nm in items:
            l = nm.lower()
            if any(h in l for h in hints):
                best = i
                break
    return items, best

def bonsai_add_selected_drawing_to_sheet(sheet_hint_1="A01", sheet_hint_2="untitled", drawing_hints=("storey","plan")):
    scene = bpy.context.scene
    dp = _find_propgroup(scene, "drawings")
    sp = _find_propgroup(scene, "sheets")
    if not dp or not sp:
        log("[ADD2SHEET] Could not find BIM drawing/sheet property groups on scene.")
        return False

    drawings = getattr(dp, "drawings")
    sheets = getattr(sp, "sheets")
    if len(drawings) == 0:
        log("[ADD2SHEET] No drawings available.")
        return False
    if len(sheets) == 0:
        log("[ADD2SHEET] No sheets available.")
        return False

    sheet_items, sheet_idx = _find_collection_items_by_name(sheets, (sheet_hint_1, sheet_hint_2))
    if sheet_idx is None:
        sheet_items, sheet_idx = _find_collection_items_by_name(sheets, (sheet_hint_1,))
    if sheet_idx is None:
        sheet_idx = 0

    draw_idx = None
    if drawing_hints:
        for h in drawing_hints:
            _items, cand = _find_collection_items_by_name(drawings, (h,))
            if cand is not None:
                draw_idx = cand
                break
    if draw_idx is None:
        draw_idx = len(drawings) - 1

    for prop_name in ("active_drawing_index", "drawing_index", "active_index", "index"):
        if hasattr(dp, prop_name):
            try: setattr(dp, prop_name, int(draw_idx))
            except: pass
    for prop_name in ("active_sheet_index", "sheet_index", "active_index", "index"):
        if hasattr(sp, prop_name):
            try: setattr(sp, prop_name, int(sheet_idx))
            except: pass

    sheet_name = sheet_items[sheet_idx][1] if sheet_items else ""
    draw_name = ""
    try: draw_name = str(getattr(drawings[draw_idx], "name", ""))
    except: pass
    log(f"[ADD2SHEET] Selected sheet[{sheet_idx}]='{sheet_name}', drawing[{draw_idx}]='{draw_name}'")

    bim = getattr(bpy.ops, "bim", None)
    if not bim:
        log("[ADD2SHEET] bpy.ops.bim not found.")
        return False

    candidates = [
        "add_selected_drawing_to_sheet",
        "add_drawing_to_sheet",
        "add_drawing_to_selected_sheet",
        "assign_drawing_to_sheet",
        "append_drawing_to_sheet",
        "sheet_add_drawing",
        "drawing_add_to_sheet",
    ]

    discovered = []
    for nm in dir(bim):
        low = nm.lower()
        if ("drawing" in low) and ("sheet" in low) and (("add" in low) or ("assign" in low) or ("append" in low)):
            discovered.append(nm)
    for nm in discovered:
        if nm not in candidates:
            candidates.append(nm)

    desired = {
        "sheet": sheet_idx,
        "sheet_index": sheet_idx,
        "sheet_name": sheet_name,
        "drawing": draw_idx,
        "drawing_index": draw_idx,
        "drawing_name": draw_name,
        "directory": os.path.abspath(EXPORT_DIR) + os.sep,
    }

    for op_name in candidates:
        ok = _call_bim_op_flexible(op_name, desired)
        if ok:
            log(f"[ADD2SHEET] OK via bpy.ops.bim.{op_name}(...)")
            return True

    log("[ADD2SHEET] FAILED: could not run an add-drawing-to-sheet operator.")
    return False

def bonsai_try_load_create_lists():
    # best-effort: load drawings/sheets/docs so ops register
    for opn in ("load_project_elements", "load_drawings", "load_sheets", "load_documents"):
        if hasattr(bpy.ops.bim, opn):
            try:
                run_op(getattr(bpy.ops.bim, opn))
                log(f"[BIM] bim.{opn} OK")
            except Exception as e:
                log(f"[BIM] bim.{opn} FAIL: {e}")
    time.sleep(0.2)
    for opn in ("create_drawing", "create_sheets"):
        if hasattr(bpy.ops.bim, opn):
            try:
                run_op(getattr(bpy.ops.bim, opn))
                log(f"[BIM] bim.{opn} OK")
            except Exception as e:
                log(f"[BIM] bim.{opn} FAIL: {e}")
    time.sleep(0.2)

def bonsai_export_discover_and_run(export_dir):
    """
    Discover ANY ops containing (export|plot|print|save) AND (drawing|sheet|layout|svg|pdf),
    then run them with directory/file args if present.
    """
    bim = getattr(bpy.ops, "bim", None)
    if not bim:
        log("[EXPORT] bpy.ops.bim not found.")
        return False

    export_dir = os.path.abspath(export_dir)
    os.makedirs(export_dir, exist_ok=True)
    if not export_dir.endswith(os.sep):
        export_dir += os.sep

    ops = dir(bim)

    def is_candidate(name):
        low = name.lower()
        if any(k in low for k in ("export", "plot", "print", "save")):
            if any(k in low for k in ("drawing", "sheet", "layout", "svg", "pdf")):
                if "cost" in low and "schedule" in low:
                    return False
                return True
        return False

    discovered = sorted([n for n in ops if is_candidate(n)])

    if discovered:
        log("[EXPORT] Discovered export ops (top 40):")
        for n in discovered[:40]:
            log(f"   bpy.ops.bim.{n}")
    else:
        export_only = sorted([n for n in ops if "export" in n.lower()])
        log(f"[EXPORT] No drawing/sheet export ops discovered. export* ops count={len(export_only)}")
        for n in export_only[:60]:
            log(f"   bpy.ops.bim.{n}")

    preferred = [
        "export_drawings", "export_drawing", "export_drawing_svg", "export_all_drawings",
        "export_sheets", "export_sheet", "export_sheet_svg", "export_all_sheets",
        "export_layouts", "export_layout", "export_layout_svg",
        "export_svg", "export_pdf", "plot_to_svg", "plot_to_pdf",
        "save_drawing", "save_sheet", "save_layout",
        "print_drawing", "print_sheet",
    ]
    queue = []
    for p in preferred:
        if p in ops:
            queue.append(p)
    for n in discovered:
        if n not in queue:
            queue.append(n)

    desired = {
        "directory": export_dir,
        "dirpath": export_dir,
        "path": export_dir,
        "folder": export_dir,
        "output_dir": export_dir,
        "filepath": os.path.join(export_dir, "export.svg"),
        "file_path": os.path.join(export_dir, "export.svg"),
    }

    ran_any = False
    for op_name in queue:
        ok = _call_bim_op_flexible(op_name, desired)
        if ok:
            log(f"[EXPORT] OK via bpy.ops.bim.{op_name}(...)")
            ran_any = True

    log(f"[EXPORT] export-run success={ran_any}")
    return ran_any

def collect_and_flatten_exports():
    """
    Bonsai may write to //drawings, //layouts, //sheets, or nested inside //exports.
    We copy everything we can find into //exports/_FLAT and keep originals.
    """
    project_root = bpy.path.abspath("//")
    candidates = [
        os.path.join(project_root, "exports"),
        os.path.join(project_root, "drawings"),
        os.path.join(project_root, "layouts"),
        os.path.join(project_root, "sheets"),
        os.path.join(project_root, "documents"),
    ]
    found = []
    for c in candidates:
        if os.path.isdir(c):
            found += glob.glob(os.path.join(c, "**", "*.svg"), recursive=True)
            found += glob.glob(os.path.join(c, "**", "*.pdf"), recursive=True)

    found = sorted(set(found))
    flat_dir = os.path.join(EXPORT_DIR, "_FLAT")
    os.makedirs(flat_dir, exist_ok=True)

    copied = 0
    for src in found:
        bn = os.path.basename(src)
        dst = os.path.join(flat_dir, bn)
        if os.path.exists(dst):
            base, ext = os.path.splitext(bn)
            k = 2
            while True:
                dst2 = os.path.join(flat_dir, f"{base}_{k}{ext}")
                if not os.path.exists(dst2):
                    dst = dst2
                    break
                k += 1
        try:
            shutil.copy2(src, dst)
            copied += 1
        except:
            pass

    manifest = os.path.join(EXPORT_DIR, "EXPORT_MANIFEST.txt")
    try:
        with open(manifest, "w", encoding="utf-8") as f:
            f.write("Collected exports:\n")
            for p in found:
                f.write(p + "\n")
        log(f"[EXPORT] Manifest: {manifest}")
    except:
        pass

    log(f"[EXPORT] Flattened copies in: {flat_dir} (copied {copied})")
    return found


# =========================
# SHEET SVG FIX + IMAGE HREF FIX/EMBED
# =========================
def _sf(v, default=0.0):
    try: return float(v)
    except: return default

def _strip_ns(tag):
    return tag.split("}", 1)[-1] if "}" in tag else tag

def _get_attr_any(el, keys):
    for k in keys:
        if k in el.attrib:
            return el.attrib.get(k)
    return None

def _get_href(el):
    return _get_attr_any(el, ["href", "{http://www.w3.org/1999/xlink}href", "{http://www.w3.org/1999/xlink}Href"])

def _set_href(el, val):
    if "href" in el.attrib:
        el.set("href", val)
    else:
        el.set("{http://www.w3.org/1999/xlink}href", val)

def _get_page_size(root):
    vb = root.get("viewBox")
    if vb:
        parts = [p for p in re.split(r"[,\s]+", vb.strip()) if p]
        if len(parts) == 4:
            return (_sf(parts[2], 0.0), _sf(parts[3], 0.0))
    try:
        w = float(re.sub(r"[a-zA-Z]+", "", root.get("width","0")))
        h = float(re.sub(r"[a-zA-Z]+", "", root.get("height","0")))
        if w > 0 and h > 0:
            return (w, h)
    except:
        pass
    return (0.0, 0.0)

def _choose_drawing_viewport_rect(root, page_w, page_h):
    page_area = (page_w * page_h) if (page_w > 0 and page_h > 0) else None
    rects = []
    for el in root.iter():
        if _strip_ns(el.tag) != "rect":
            continue
        x = _sf(el.get("x"), 0.0)
        y = _sf(el.get("y"), 0.0)
        w = _sf(el.get("width"), 0.0)
        h = _sf(el.get("height"), 0.0)
        if w <= 1 or h <= 1:
            continue
        area = w*h
        rects.append((area, x, y, w, h, el))

    if not rects or not page_area:
        return (0.0, 0.0, page_w, page_h)

    cand = []
    for area, x, y, w, h, el in rects:
        ratio = area / page_area
        if ratio < 0.10 or ratio > 0.90:
            continue
        if y > 0.60 * page_h:
            continue
        if h > 0.85 * page_h:
            continue
        cand.append((area, x, y, w, h, el))

    if cand:
        cand.sort(key=lambda t: t[0], reverse=True)
        _, x, y, w, h, _ = cand[0]
        return (x, y, w, h)

    rects.sort(key=lambda t: t[0], reverse=True)
    for area, x, y, w, h, el in rects:
        if (area / page_area) > 0.95:
            continue
        return (x, y, w, h)

    _, x, y, w, h, _ = rects[0]
    return (x, y, w, h)

def _extract_clip_id(clip_path_value: str):
    if not clip_path_value:
        return None
    m = re.search(r"url\(\s*#([^)]+)\s*\)", clip_path_value.strip())
    if m:
        return m.group(1).strip()
    if clip_path_value.strip().startswith("#"):
        return clip_path_value.strip()[1:]
    return None

def _append_translate(el, dx, dy):
    t = el.get("transform") or ""
    t = (t + f" translate({dx:.6f},{dy:.6f})").strip()
    el.set("transform", t)

def fix_svg_image_hrefs_and_embed(svg_path, embed=True, max_bytes=20*1024*1024):
    """
    Fix broken sheet exports by:
      - converting relative image href -> absolute file:/// URI
      - optionally embedding as data:image/...;base64,...
    """
    try:
        tree = ET.parse(svg_path)
        root = tree.getroot()
    except Exception as e:
        log(f"[SVGHREF] Parse fail: {svg_path}: {e}")
        return False

    svg_dir = os.path.dirname(os.path.abspath(svg_path))
    changed = False

    for el in root.iter():
        if _strip_ns(el.tag) != "image":
            continue
        href = (_get_href(el) or "").strip()
        if not href or href.lower().startswith("data:"):
            continue

        href_clean = href.replace("\\", "/")
        if re.match(r"^[a-zA-Z]+:", href_clean):  # absolute URL or C:\...
            abs_path = href_clean.replace("file:///", "")
        else:
            abs_path = os.path.abspath(os.path.join(svg_dir, href_clean))

        if not os.path.exists(abs_path):
            abs_path2 = os.path.abspath(os.path.join(svg_dir, urllib.parse.unquote(href_clean)))
            if os.path.exists(abs_path2):
                abs_path = abs_path2
            else:
                continue

        if embed:
            try:
                sz = os.path.getsize(abs_path)
                if sz <= max_bytes:
                    ext = os.path.splitext(abs_path)[1].lower()
                    mime = "image/png" if ext in (".png",) else "image/jpeg" if ext in (".jpg",".jpeg") else None
                    if mime:
                        with open(abs_path, "rb") as f:
                            b = f.read()
                        data = base64.b64encode(b).decode("ascii")
                        _set_href(el, f"data:{mime};base64,{data}")
                        changed = True
                        continue
            except:
                pass

        uri_path = abs_path.replace("\\", "/")
        uri = "file:///" + urllib.parse.quote(uri_path, safe="/:")
        _set_href(el, uri)
        changed = True

    if changed:
        try:
            tree.write(svg_path, encoding="utf-8", xml_declaration=True)
        except:
            pass
    return changed

def fix_sheet_svg_center_drawing(svg_path, name_hint_1="A01", name_hint_2="untitled"):
    """
    Center only the drawing image in the sheet SVG (do not move titleblock/border).
    Also removes page-filling background image if present.
    """
    if not os.path.exists(svg_path):
        return False

    base = os.path.basename(svg_path).lower()
    if name_hint_1 and name_hint_1.lower() not in base:
        return False
    if name_hint_2 and name_hint_2.lower() not in base:
        return False

    try:
        tree = ET.parse(svg_path)
        root = tree.getroot()
    except Exception as e:
        log(f"[SHEETFIX] Parse fail {svg_path}: {e}")
        return False

    page_w, page_h = _get_page_size(root)
    page_area = (page_w * page_h) if (page_w > 0 and page_h > 0) else None

    vx, vy, vw, vh = _choose_drawing_viewport_rect(root, page_w, page_h)
    v_cx = vx + vw*0.5
    v_cy = vy + vh*0.5
    v_area = vw*vh

    parent_map = {c: p for p in root.iter() for c in p}

    images = []
    for el in root.iter():
        if _strip_ns(el.tag) != "image":
            continue
        ix = _sf(el.get("x"), 0.0)
        iy = _sf(el.get("y"), 0.0)
        iw = _sf(el.get("width"), 0.0)
        ih = _sf(el.get("height"), 0.0)
        if iw <= 0 or ih <= 0:
            continue
        href = (_get_href(el) or "").strip().lower()
        area = iw*ih
        raster = ("data:image/png" in href) or ("data:image/jpeg" in href) or href.endswith(".png") or href.endswith(".jpg") or href.endswith(".jpeg")
        originish = (abs(ix) <= BG_ORIGIN_EPS and abs(iy) <= BG_ORIGIN_EPS)
        clip_id = _extract_clip_id(el.get("clip-path") or "")
        images.append({"el": el, "x": ix, "y": iy, "w": iw, "h": ih, "area": area, "href": href, "raster": raster, "originish": originish, "clip_id": clip_id})

    changed = False

    # Remove huge background raster
    if REMOVE_BG_IMAGE and page_area and len(images) >= 2:
        bg = None
        for im in sorted(images, key=lambda d: d["area"], reverse=True):
            ratio = im["area"]/page_area
            if ratio >= BG_AREA_THRESHOLD and im["originish"] and im["raster"]:
                bg = im
                break
        if bg is not None:
            p = parent_map.get(bg["el"])
            if p is not None:
                p.remove(bg["el"])
                changed = True
                log(f"[SHEETFIX] Removed page-filling background image in '{os.path.basename(svg_path)}'.")
                images = [im for im in images if im["el"] is not bg["el"]]

    if not images:
        if changed:
            tree.write(svg_path, encoding="utf-8", xml_declaration=True)
        return changed

    # Choose most likely drawing image
    def score(im):
        if page_area and (im["area"]/page_area) >= BG_AREA_THRESHOLD:
            return 1e9
        hint_bonus = 0.0
        if "drawings" in im["href"] or "drawing" in im["href"]:
            hint_bonus -= 0.35 * v_area
        if im["clip_id"]:
            hint_bonus -= 0.25 * v_area
        cx = im["x"] + im["w"]*0.5
        cy = im["y"] + im["h"]*0.5
        return abs(im["area"] - v_area) + 0.15*(abs(cx - v_cx) + abs(cy - v_cy))*max(vw, vh) + hint_bonus

    draw_img = sorted(images, key=score)[0]

    el = draw_img["el"]
    old_x = draw_img["x"]; old_y = draw_img["y"]
    iw = draw_img["w"]; ih = draw_img["h"]
    new_x = v_cx - iw*0.5
    new_y = v_cy - ih*0.5
    dx = new_x - old_x
    dy = new_y - old_y

    el.set("x", f"{new_x:.6f}")
    el.set("y", f"{new_y:.6f}")
    changed = True
    log(f"[SHEETFIX] Centered drawing image in '{os.path.basename(svg_path)}' (dx={dx:.3f}, dy={dy:.3f}).")

    clip_id = draw_img.get("clip_id")
    if clip_id:
        clip_el = None
        for c in root.iter():
            if _strip_ns(c.tag) == "clipPath" and (c.get("id") or "") == clip_id:
                clip_el = c
                break
        if clip_el is not None:
            _append_translate(clip_el, dx, dy)
            changed = True
            log(f"[SHEETFIX] Moved clipPath #{clip_id} with drawing.")

    if changed:
        tree.write(svg_path, encoding="utf-8", xml_declaration=True)
    return changed


# =========================
# SVG -> DXF (VECTOR-ONLY)
# =========================
def svg_has_vector_linework(svg_path):
    try:
        tree = ET.parse(svg_path)
        root = tree.getroot()
    except:
        return False

    # If there are *only* images and no vector primitives, DXF would be empty.
    has_vector = False
    for el in root.iter():
        tag = _strip_ns(el.tag)
        if tag == "image":
            continue
        if tag in ("path","line","polyline","polygon","rect","circle","ellipse"):
            if tag == "path" and (el.get("d") or "").strip():
                has_vector = True
                break
            if tag != "path":
                has_vector = True
                break
    return has_vector

def _svg_viewbox_size(root):
    vb = root.get("viewBox")
    if vb:
        parts = [p for p in re.split(r"[,\s]+", vb.strip()) if p]
        if len(parts) == 4:
            return (float(parts[2]), float(parts[3]))
    try:
        w = float(re.sub(r"[a-zA-Z]+", "", root.get("width","1000")) or 1000)
        h = float(re.sub(r"[a-zA-Z]+", "", root.get("height","1000")) or 1000)
        return (w,h)
    except:
        return (1000.0, 1000.0)

def _svg_path_tokenize(d):
    return re.findall(r"[MmLlHhVvCcQqAaZz]|-?\d*\.?\d+(?:[eE][+-]?\d+)?", d or "")

def _bezier_cubic(p0, p1, p2, p3, t):
    u = 1.0 - t
    return (
        u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
        u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1],
    )

def _bezier_quad(p0, p1, p2, t):
    u = 1.0 - t
    return (
        u*u*p0[0] + 2*u*t*p1[0] + t*t*p2[0],
        u*u*p0[1] + 2*u*t*p1[1] + t*t*p2[1],
    )

def _vector_angle(ux, uy, vx, vy):
    dot = ux*vx + uy*vy
    det = ux*vy - uy*vx
    return math.atan2(det, dot)

def _arc_to_points(x1, y1, x2, y2, rx, ry, phi_deg, large_arc, sweep, segments):
    if rx == 0 or ry == 0:
        return [(x2, y2)]
    rx = abs(rx); ry = abs(ry)
    phi = math.radians(phi_deg % 360.0)
    cosphi = math.cos(phi); sinphi = math.sin(phi)

    dx = (x1 - x2) / 2.0
    dy = (y1 - y2) / 2.0
    x1p = cosphi*dx + sinphi*dy
    y1p = -sinphi*dx + cosphi*dy

    lam = (x1p*x1p)/(rx*rx) + (y1p*y1p)/(ry*ry)
    if lam > 1:
        s = math.sqrt(lam)
        rx *= s
        ry *= s

    num = (rx*rx)*(ry*ry) - (rx*rx)*(y1p*y1p) - (ry*ry)*(x1p*x1p)
    den = (rx*rx)*(y1p*y1p) + (ry*ry)*(x1p*x1p)
    if den == 0:
        return [(x2, y2)]
    c = math.sqrt(max(0.0, num/den))
    if bool(large_arc) == bool(sweep):
        c = -c

    cxp = c * (rx * y1p) / ry
    cyp = c * (-ry * x1p) / rx

    cx = cosphi*cxp - sinphi*cyp + (x1 + x2)/2.0
    cy = sinphi*cxp + cosphi*cyp + (y1 + y2)/2.0

    ux = (x1p - cxp) / rx
    uy = (y1p - cyp) / ry
    vx = (-x1p - cxp) / rx
    vy = (-y1p - cyp) / ry

    theta1 = _vector_angle(1, 0, ux, uy)
    dtheta = _vector_angle(ux, uy, vx, vy)

    if not sweep and dtheta > 0:
        dtheta -= 2*math.pi
    elif sweep and dtheta < 0:
        dtheta += 2*math.pi

    pts = []
    for k in range(1, segments+1):
        t = k/segments
        ang = theta1 + dtheta*t
        x = cx + rx*math.cos(phi)*math.cos(ang) - ry*math.sin(phi)*math.sin(ang)
        y = cy + rx*math.sin(phi)*math.cos(ang) + ry*math.cos(phi)*math.sin(ang)
        pts.append((x,y))
    return pts

def _path_to_polylines(d):
    toks = _svg_path_tokenize(d)
    if not toks:
        return []
    i = 0
    cmd = None
    x = y = 0.0
    sx = sy = 0.0
    cur = []
    polys = []

    def num():
        nonlocal i
        v = float(toks[i]); i += 1
        return v

    while i < len(toks):
        t = toks[i]
        if re.match(r"^[MmLlHhVvCcQqAaZz]$", t):
            cmd = t
            i += 1
            if cmd in "Zz":
                if cur:
                    cur.append((sx, sy))
                    polys.append(cur)
                    cur = []
                x, y = sx, sy
            continue

        if cmd is None:
            break

        if cmd in "Mm":
            nx = num(); ny = num()
            if cmd == "m":
                x += nx; y += ny
            else:
                x, y = nx, ny
            sx, sy = x, y
            if cur:
                polys.append(cur)
            cur = [(x, y)]
            cmd = "L" if cmd == "M" else "l"

        elif cmd in "Ll":
            nx = num(); ny = num()
            if cmd == "l":
                x += nx; y += ny
            else:
                x, y = nx, ny
            cur.append((x, y))

        elif cmd in "Hh":
            nx = num()
            x = x + nx if cmd == "h" else nx
            cur.append((x, y))

        elif cmd in "Vv":
            ny = num()
            y = y + ny if cmd == "v" else ny
            cur.append((x, y))

        elif cmd in "Cc":
            x1 = num(); y1 = num()
            x2 = num(); y2 = num()
            x3 = num(); y3 = num()
            if cmd == "c":
                p0 = (x, y)
                p1 = (x + x1, y + y1)
                p2 = (x + x2, y + y2)
                p3 = (x + x3, y + y3)
                x, y = p3
            else:
                p0 = (x, y)
                p1 = (x1, y1)
                p2 = (x2, y2)
                p3 = (x3, y3)
                x, y = p3
            for k in range(1, CURVE_SEGMENTS + 1):
                tt = k / CURVE_SEGMENTS
                cur.append(_bezier_cubic(p0, p1, p2, p3, tt))

        elif cmd in "Qq":
            x1 = num(); y1 = num()
            x2 = num(); y2 = num()
            if cmd == "q":
                p0 = (x, y)
                p1 = (x + x1, y + y1)
                p2 = (x + x2, y + y2)
                x, y = p2
            else:
                p0 = (x, y)
                p1 = (x1, y1)
                p2 = (x2, y2)
                x, y = p2
            for k in range(1, CURVE_SEGMENTS + 1):
                tt = k / CURVE_SEGMENTS
                cur.append(_bezier_quad(p0, p1, p2, tt))

        elif cmd in "Aa":
            rx = num(); ry = num()
            phi = num()
            large_arc = int(num())
            sweep = int(num())
            x2 = num(); y2 = num()
            if cmd == "a":
                x2 += x; y2 += y
            pts = _arc_to_points(x, y, x2, y2, rx, ry, phi, large_arc, sweep, CURVE_SEGMENTS)
            for p in pts:
                cur.append(p)
            x, y = x2, y2

        elif cmd in "Zz":
            if cur:
                cur.append((sx, sy))
                polys.append(cur)
                cur = []
            x, y = sx, sy

        else:
            break

    if cur:
        polys.append(cur)
    return polys

def svg_to_dxf(svg_path, dxf_path):
    try:
        tree = ET.parse(svg_path)
        root = tree.getroot()
    except Exception as e:
        log(f"[DXF] Failed to parse SVG: {e}")
        return False

    vbw, vbh = _svg_viewbox_size(root)
    polylines = []

    def walk(node, parent_M):
        M_here = parent_M @ parse_transform(node.get("transform"))
        tag = _strip_ns(node.tag)

        if tag == "path":
            d = node.get("d") or ""
            for poly in _path_to_polylines(d):
                polylines.append(apply_transform(poly, M_here))

        elif tag in ("polyline", "polygon"):
            pts = parse_points_attr(node.get("points") or "")
            if pts:
                polylines.append(apply_transform(pts, M_here))

        elif tag == "line":
            x1 = float(node.get("x1") or 0)
            y1 = float(node.get("y1") or 0)
            x2 = float(node.get("x2") or 0)
            y2 = float(node.get("y2") or 0)
            polylines.append(apply_transform([(x1, y1), (x2, y2)], M_here))

        elif tag == "rect":
            x = float(node.get("x") or 0)
            y = float(node.get("y") or 0)
            w = float(node.get("width") or 0)
            h = float(node.get("height") or 0)
            if w > 0 and h > 0:
                polylines.append(apply_transform(rect_to_poly(x, y, w, h), M_here))

        for ch in list(node):
            walk(ch, M_here)

    walk(root, np.identity(3, dtype=float))

    polylines = [pl for pl in polylines if pl and len(pl) >= 2]
    if not polylines:
        log(f"[DXF] No linework in '{svg_path}'")
        return False

    try:
        with open(dxf_path, "w", encoding="utf-8", newline="\n") as f:
            def w(code, val):
                f.write(f"{code}\n{val}\n")

            w(0, "SECTION"); w(2, "HEADER")
            w(9, "$ACADVER"); w(1, "AC1015")
            w(0, "ENDSEC")

            w(0, "SECTION"); w(2, "ENTITIES")

            for pts in polylines:
                pts2 = [(x, vbh - y) for x, y in pts]  # Flip Y
                cleaned = []
                for p in pts2:
                    if not cleaned or abs(cleaned[-1][0] - p[0]) > 1e-9 or abs(cleaned[-1][1] - p[1]) > 1e-9:
                        cleaned.append(p)
                if len(cleaned) < 2:
                    continue

                closed = 0
                if len(cleaned) >= 3:
                    if abs(cleaned[0][0] - cleaned[-1][0]) < 1e-9 and abs(cleaned[0][1] - cleaned[-1][1]) < 1e-9:
                        closed = 1

                w(0, "LWPOLYLINE")
                w(8, "0")
                w(90, len(cleaned))
                w(70, 1 if closed else 0)
                for x, y in cleaned:
                    w(10, float(x))
                    w(20, float(y))

            w(0, "ENDSEC")
            w(0, "EOF")

        log(f"[DXF] Wrote: {dxf_path}")
        return True

    except Exception as e:
        log(f"[DXF] Failed to write: {e}")
        return False

def svg_to_pdf(svg_path, pdf_path):
    if not CONVERT_SVG_TO_PDF:
        return False

    inkscape = shutil.which("inkscape") or shutil.which("inkscape.com")
    if not inkscape:
        for guess in [r"C:\Program Files\Inkscape\bin\inkscape.com",
                      r"C:\Program Files\Inkscape\bin\inkscape.exe"]:
            if os.path.exists(guess):
                inkscape = guess
                break
    if not inkscape:
        log("[PDF] Inkscape not found")
        return False

    cwd = os.path.dirname(os.path.abspath(svg_path))
    try:
        subprocess.run(
            [inkscape, svg_path, "--export-type=pdf", f"--export-filename={pdf_path}"],
            check=True,
            cwd=cwd
        )
        log(f"[PDF] Wrote: {pdf_path}")
        return True
    except Exception as e:
        log(f"[PDF] Inkscape failed: {e}")
        return False

def convert_exports_to_dxf_and_pdf(all_export_files):
    svgs = [p for p in all_export_files if p.lower().endswith(".svg")]
    for svg in svgs:
        base = os.path.splitext(svg)[0]
        dxf = base + ".dxf"
        pdf = base + ".pdf"

        # Fix/Embed images first => avoids red X / missing raster in PDF
        try:
            is_sheet = (SHEET_HINT.lower() in os.path.basename(svg).lower()) and (SHEET_HINT_2.lower() in os.path.basename(svg).lower())
            if is_sheet:
                fix_sheet_svg_center_drawing(svg, SHEET_HINT, SHEET_HINT_2)
            fix_svg_image_hrefs_and_embed(svg, embed=True)
        except:
            pass

        # DXF only if it truly contains vector linework
        if svg_has_vector_linework(svg):
            try:
                svg_to_dxf(svg, dxf)
            except:
                pass
        else:
            log(f"[DXF] Skip raster-only SVG: {svg}")

        # PDF always (after embedding hrefs)
        try:
            svg_to_pdf(svg, pdf)
        except:
            pass


# =========================
# RELOAD IFC IN BONSAI
# =========================
def reload_ifc_in_bonsai(filepath_abs):
    deselect_all()
    ensure_object_mode()

    # Always pass filepath if supported
    if hasattr(bpy.ops, "bim") and hasattr(bpy.ops.bim, "reload_ifc_file"):
        try:
            props = _op_props(bpy.ops.bim.reload_ifc_file)
            if "filepath" in props:
                run_op(bpy.ops.bim.reload_ifc_file, filepath=filepath_abs)
            else:
                run_op(bpy.ops.bim.reload_ifc_file)
            log("[BIM] Reloaded via bpy.ops.bim.reload_ifc_file")
        except Exception as e:
            log(f"[BIM] reload_ifc_file failed: {e}")

    # Ensure objects load
    if hasattr(bpy.ops.bim, "load_project_elements"):
        try:
            run_op(bpy.ops.bim.load_project_elements)
            log("[BIM] load_project_elements OK")
        except Exception as e:
            log(f"[BIM] load_project_elements FAIL: {e}")


# =========================
# FIX: CAMERA & UPDATE HELPERS
# =========================
def center_cameras_on_geometry_and_update(ifc):
    """
    1. Calculates the center of generated walls.
    2. Moves the Plan/Section camera to that center.
    3. Forces a geometry update (the boolean cut).
    """
    # A. Calculate Geometry Center
    walls = ifc.by_type("IfcWall")
    if not walls:
        log("[FIX] No walls found, skipping camera fix.")
        return

    # specific import for geometry calculation
    import ifcopenshell.geom
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    
    min_x, min_y, max_x, max_y = 1e9, 1e9, -1e9, -1e9
    count = 0

    for w in walls:
        try:
            shape = ifcopenshell.geom.create_shape(settings, w)
            verts = shape.geometry.verts # [x,y,z, x,y,z...]
            xs = verts[0::3]
            ys = verts[1::3]
            min_x = min(min_x, min(xs))
            min_y = min(min_y, min(ys))
            max_x = max(max_x, max(xs))
            max_y = max(max_y, max(ys))
            count += 1
        except: pass

    if count == 0: return
    
    cx = (min_x + max_x) / 2.0
    cy = (min_y + max_y) / 2.0
    width = max_x - min_x
    height = max_y - min_y
    log(f"[FIX] Geometry Center: X={cx:.2f}, Y={cy:.2f}")

    # B. Move Cameras & C. Force Update
    # Find objects that look like BIM drawings
    candidates = [obj for obj in bpy.data.objects if obj.type == 'CAMERA']
    
    for obj in candidates:
        # Check if it's likely our plan camera
        is_drawing = getattr(obj, "BIMDrawingProperties", None) or "plan" in obj.name.lower()
        
        if is_drawing:
            log(f"[FIX] Recentering camera: {obj.name}")
            obj.location.x = cx
            obj.location.y = cy
            # Ensure Z cuts through walls (walls are usually 0-3m, so 1.5 is safe)
            obj.location.z = 1.5 
            
            # Expand camera view if Orthographic
            if obj.data.type == 'ORTHO':
                dim = max(width, height) * 1.2 # add 20% padding
                # Only expand, don't shrink too much
                if dim > obj.data.ortho_scale:
                    obj.data.ortho_scale = dim

            # FORCE UPDATE (The critical part for blank meshes)
            log(f"[FIX] Forcing Update on: {obj.name}")
            bpy.context.view_layer.objects.active = obj
            try:
                # This operator generates the 2D linework from 3D model
                if hasattr(bpy.ops.bim, "update_drawing"):
                    run_op(bpy.ops.bim.update_drawing)
                elif hasattr(bpy.ops.bim, "activate_drawing"):
                     # Older versions of bonsai sometimes use activate to trigger update
                    run_op(bpy.ops.bim.activate_drawing)
            except Exception as e:
                log(f"[FIX] Update failed: {e}")


# =========================
# MAIN
# =========================
def main():
    reset_log()
    set_safe_tool()
    deselect_all()
    ensure_object_mode()

    log("=== START ===")

    if not os.path.exists(SVG_PATH):
        raise RuntimeError(f"plan.svg not found: {SVG_PATH}")

    # CRITICAL: prevent Bonsai undo_post KeyError rollback while running bim ops
    old_undo = bpy.context.preferences.edit.use_global_undo
    bpy.context.preferences.edit.use_global_undo = False

    try:
        ifc = get_ifc()
        storey = pick_storey(ifc)
        ctx = body_context(ifc)

        if CLEANUP_PREVIOUS:
            remove_previous_generated(ifc)

        # --- Find template wall type ---
        wall_type = find_type_ci(ifc, "IfcWallType", TYPE_WALL)
        if not wall_type:
            wall_type = run("root.create_entity", ifc, ifc_class="IfcWallType", name=TYPE_WALL)
            log(f"[SETUP] Created missing wall type: {TYPE_WALL}")

        # --- Parse SVG ---
        tree = ET.parse(SVG_PATH)
        root = tree.getroot()
        unit_m = compute_svg_unit_to_meter(root)

        walls, wins, doors = [], [], []
        for cls, poly, eid in iter_floorplan_shapes(root):
            poly_w = [(p[0]*unit_m, -p[1]*unit_m) for p in poly]  # Flip Y into IFC coords
            if cls == "wall": walls.append((poly_w, eid))
            elif cls == "window": wins.append((poly_w, eid))
            elif cls == "door": doors.append((poly_w, eid))

        log(f"[SVG] walls={len(walls)} wins={len(wins)} doors={len(doors)} unit_m={unit_m}")

        # --- BUILD WALLS ---
        wall_recs = []
        for i, (poly, eid) in enumerate(walls):
            cx, cy = poly_centroid(poly)
            poly_loc = [(p[0]-cx, p[1]-cy) for p in poly]

            w = run("root.create_entity", ifc, ifc_class="IfcWall", name=f"{GEN_PREFIX}WALL_{i}")
            run("spatial.assign_container", ifc, relating_structure=storey, products=[w])

            # wall is not mapped from a template model; we use profile rep
            run("type.assign_type", ifc, related_objects=[w], relating_type=wall_type, should_map_representations=False)

            rep = make_wall_rep_from_poly(ifc, ctx, poly_loc, DEFAULT_WALL_HEIGHT)
            run("geometry.assign_representation", ifc, product=w, representation=rep)
            place_matrix(ifc, w, np.array([[1,0,0,cx],[0,1,0,cy],[0,0,1,0],[0,0,0,1]], dtype=float))

            wall_recs.append({"poly": poly, "ifc": w})

        # --- BUILD WINDOWS/DOORS (hosted) using TEMPLATE TYPE MODELS ---
        def assign_type_mapped_safe(product, ttype):
            # Different Bonsai versions differ in args. Try best set first.
            try:
                run("type.assign_type", ifc, related_objects=[product], relating_type=ttype, should_map_representations=True)
                return True
            except TypeError:
                try:
                    run("type.assign_type", ifc, related_objects=[product], relating_type=ttype)
                    return True
                except Exception:
                    return False
            except Exception:
                return False

        def build_hosted(items, is_win):
            cls_name = "IfcWindow" if is_win else "IfcDoor"
            prefix = "WIN" if is_win else "DOOR"

            for i, (poly, eid) in enumerate(items):
                cx, cy = poly_centroid(poly)

                kind, type_token, spec_width, sill, height = parse_spec_from_eid(eid)
                if is_win and kind != "WINDOW":
                    type_token = DEFAULT_WIN_TYPE
                    sill = DEFAULT_FALLBACK_SILL
                    height = DEFAULT_FALLBACK_WIN_H
                if (not is_win) and kind != "DOOR":
                    type_token = DEFAULT_DOOR_TYPE
                    sill = 0.0
                    height = DEFAULT_FALLBACK_DOOR_H

                # Host wall
                best = (1e9, None, None)
                for rec in wall_recs:
                    d, edge, t = closest_wall_edge(rec["poly"], cx, cy)
                    if d < best[0]:
                        best = (d, rec, edge)

                host = best[1]
                if not host:
                    log(f"[BUILD] WARNING: No host wall found for {prefix} {i}")
                    continue

                ax, ay, bx, by = best[2]
                ux, uy = unit(bx - ax, by - ay)

                width = spec_width if spec_width is not None else opening_width_from_rect(poly, ux, uy)
                if sill is None:
                    sill = DEFAULT_FALLBACK_SILL if is_win else 0.0
                if height is None:
                    height = DEFAULT_FALLBACK_WIN_H if is_win else DEFAULT_FALLBACK_DOOR_H

                # Resolve template type
                if is_win:
                    ttype = find_type_ci(ifc, "IfcWindowType", type_token)
                    if not ttype:
                        log(f"[TYPE] Missing IfcWindowType '{type_token}', fallback '{DEFAULT_WIN_TYPE}'")
                        ttype = find_type_ci(ifc, "IfcWindowType", DEFAULT_WIN_TYPE)
                    if not ttype:
                        # last resort: create (but it will be placeholder)
                        ttype = run("root.create_entity", ifc, ifc_class="IfcWindowType", name=type_token)
                        log(f"[TYPE] Created missing IfcWindowType '{type_token}' (WARNING: may be placeholder)")
                else:
                    ttype = find_type_ci(ifc, "IfcDoorType", type_token)
                    if not ttype:
                        log(f"[TYPE] Missing IfcDoorType '{type_token}', fallback '{DEFAULT_DOOR_TYPE}'")
                        ttype = find_type_ci(ifc, "IfcDoorType", DEFAULT_DOOR_TYPE)
                    if not ttype:
                        ttype = run("root.create_entity", ifc, ifc_class="IfcDoorType", name=type_token)
                        log(f"[TYPE] Created missing IfcDoorType '{type_token}' (WARNING: may be placeholder)")

                log(f"[BUILD] {prefix} {i}: type='{type_token}' width={width:.3f} height={height:.3f} sill={sill:.3f}")

                # Opening
                op = run("root.create_entity", ifc, ifc_class="IfcOpeningElement", name=f"{GEN_PREFIX}OP_{prefix}_{i}")
                run("spatial.assign_container", ifc, relating_structure=storey, products=[op])
                op_rep = make_opening_rep(ifc, ctx, width, DEFAULT_OPENING_DEPTH_ACROSS_WALL, height)
                run("geometry.assign_representation", ifc, product=op, representation=op_rep)
                Mop = build_xy_rotation_matrix(cx, cy, sill, ux, uy)
                place_matrix(ifc, op, Mop)

                # Add opening to wall
                run("feature.add_feature", ifc, feature=op, element=host["ifc"])

                # Element (Door/Window) - mapped from TEMPLATE TYPE model
                el = run("root.create_entity", ifc, ifc_class=cls_name, name=f"{GEN_PREFIX}{prefix}_{i}_{eid}")
                run("spatial.assign_container", ifc, relating_structure=storey, products=[el])

                ok_map = assign_type_mapped_safe(el, ttype)
                if not ok_map:
                    log(f"[TYPE] WARNING: failed mapping type for {el.Name} -> {getattr(ttype,'Name','?')}")

                # Place element into opening
                place_matrix(ifc, el, Mop)

                # Fill opening
                run("feature.add_filling", ifc, opening=op, element=el)

                # Per-instance scaling (works only if mapped items exist)
                sc = set_mapped_scale_and_center_ALL_REPS_KEEP_DEPTH(ifc, el, width, height)
                if sc:
                    sx, sy, sz, touched = sc
                    log(f"[SCALE] {prefix} {i}: sx={sx:.3f} sz={sz:.3f} touched={touched}")
                else:
                    log(f"[SCALE] {prefix} {i}: no mapped items / scale skipped")

        build_hosted(wins, True)
        build_hosted(doors, False)

        # --- WRITE IFC BEFORE ANY BIM OPS (CRITICAL) ---
        os.makedirs(os.path.dirname(os.path.abspath(OUT_IFC)), exist_ok=True)
        ifc.write(OUT_IFC)
        try_set_bonsai_ifc_path(OUT_IFC)

 # --- Reload so Blender shows the new elements ---
        reload_ifc_in_bonsai(os.path.abspath(OUT_IFC))
        time.sleep(0.3)

        # >>>>>> ADDED FIX HERE <<<<<<
        # Move camera to the new walls and force the 2D linework generation
        center_cameras_on_geometry_and_update(ifc)
        # >>>>>> END FIX <<<<<<

        # --- EXPORT PIPELINE ---
        # Load/create lists so export operators are available
        bonsai_try_load_create_lists()

        # Ensure drawing is on sheet (your prior workflow requirement)
        bonsai_add_selected_drawing_to_sheet(SHEET_HINT, SHEET_HINT_2)

        # Run export (discovered ops)
        bonsai_export_discover_and_run(EXPORT_DIR)

        # Collect everything into exports/_FLAT
        files = collect_and_flatten_exports()

        # Convert any SVGs into DXF/PDF (after fixing hrefs / embedding images)
        convert_exports_to_dxf_and_pdf(files)

        log("=== DONE ===")

    finally:
        bpy.context.preferences.edit.use_global_undo = old_undo


try:
    main()
except Exception as e:
    log(f"FAIL: {e}")
    log(traceback.format_exc())
    raise
