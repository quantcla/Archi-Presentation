"""
Elemente Builder - Converts web app shapes to Blender 3D Builder format
Uses the existing 3DBuilder add-on (v6.5.0) and run_elevation_builder_job.py runner

ARCHITECTURE (v6.5.0 - No-Merge Part Output + Safer Booleans):
- 'on' shapes become on-<G> where G is colorIndex (GROUP)
- 'off' shapes become off-<G>-<K> where G is target ON group, K is cutter ID
- 'cut' shapes are treated same as 'off' (kept for compatibility)

Views (all 5 views work the same for 3D intersection):
  - front, right, left, back, top - all used for 3D intersection/boolean operations
  - Need 'on' shapes on at least 2 views to create an intersection

The 3dBuilder add-on v6.5.0 handles the logic:
  - Build each ON group as its own separate part (INTERSECT across all panels with that group)
  - Subtract ONLY the OFF cutters that belong to that ON group, sequentially
  - Does NOT UNION parts into one mesh (prevents accumulated boolean damage / dents)
  - Uses cutter padding to avoid coplanar boolean faces
  - Base mass still comes from BLACK (main) and GREY (negatives)
"""

import os
import json
import subprocess
import time
from pathlib import Path
from typing import List, Dict, Any

# Blender executable path - will try multiple versions
BLENDER_PATHS = [
    r"C:\Program Files\Blender Foundation\Blender 5.0\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.2\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.1\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.0\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 3.6\blender.exe",
]

def find_blender():
    """Find an available Blender installation."""
    for path in BLENDER_PATHS:
        if os.path.exists(path):
            return path
    return None

# Marker colors for each view (matching the 3DBuilder add-on v6.5.0 expectations)
# Side views use left/right markers for alignment:
#   FRONT = BLUE (left) + RED (right)
#   RIGHT = RED (left) + GREEN (right)
#   LEFT  = YELLOW (left) + BLUE (right)
#   BACK  = GREEN (left) + YELLOW (right)
# TOP view uses left/right markers PLUS top/bottom markers for depth alignment:
#   TOP = CYAN (left) + PINK (right) + PURPLE (top/front edge) + ORANGE (bottom/back edge)
VIEW_MARKERS = {
    'front': {'colors': ['blue', 'red'], 'rgb': {'blue': (0, 0, 255), 'red': (255, 0, 0)}},
    'right': {'colors': ['red', 'green'], 'rgb': {'red': (255, 0, 0), 'green': (0, 255, 0)}},
    'left':  {'colors': ['yellow', 'blue'], 'rgb': {'yellow': (255, 255, 0), 'blue': (0, 0, 255)}},
    'back':  {'colors': ['green', 'yellow'], 'rgb': {'green': (0, 255, 0), 'yellow': (255, 255, 0)}},
    'top':   {
        'colors': ['cyan', 'pink'],
        'rgb': {'cyan': (0, 255, 255), 'pink': (255, 0, 255)},
        # Additional markers for depth alignment (top=front edge, bottom=back edge)
        'depth_colors': ['purple', 'orange'],
        'depth_rgb': {'purple': (128, 0, 128), 'orange': (255, 165, 0)}
    },
}

# Shape type colors for the 3dBuilder add-on v6.5.0
# Colors don't matter for v6.5.0 - naming is primary
# But we use distinct colors for visual clarity in SVGs
def get_on_color_for_index(color_index: int) -> tuple:
    """Generate a unique dark grey color for each 'on' group."""
    # Use dark greys that won't be confused with markers
    base = 30
    step = 15
    value = min(80, base + (color_index - 1) * step)
    return (value, value, value)


def get_off_color_for_index(color_index: int, sub_index: int) -> tuple:
    """
    Generate a unique reddish color for each 'off' (colorIndex, subIndex) pair.
    Uses dark red tones that won't be confused with the marker red (255,0,0).
    """
    base_r = 180
    base_gb = 60
    step = 15

    r_value = base_r - (color_index - 1) * step
    gb_value = base_gb - (sub_index - 1) * (step // 2)

    # Clamp to valid range
    r_value = max(100, min(200, r_value))
    gb_value = max(20, min(80, gb_value))

    return (r_value, gb_value, gb_value)


def get_cut_color_for_index(color_index: int, sub_index: int) -> tuple:
    """
    Generate a unique purple color for each 'cut' (colorIndex, subIndex) pair.
    """
    base_b = 160
    base_r = 140
    base_g = 40
    step = 15

    r_value = max(100, min(180, base_r - (color_index - 1) * step))
    b_value = max(120, min(200, base_b - (sub_index - 1) * step))

    return (r_value, base_g, b_value)


def generate_svg_for_view_unified(
    view: str,
    shapes: List[Dict],
    canvas_size_mm: float = 4000.0,
    canvas_px: int = 800,
) -> str:
    """
    Generate an SVG file for a view with proper naming for the 3dBuilder add-on v6.5.0.

    SVG uses mm units representing real-world dimensions. The canvas_size_mm defines
    the real-world size in mm. Points arrive in pixel space (0-canvas_px) and are converted to mm.
    Marker widths and margins scale proportionally with canvas size.

    NAMING CONVENTION (v6.5.0 No-Merge Parts):
    - 'on' shapes -> on-{G} where G is colorIndex (target group)
    - 'off' shapes -> off-{G}-{K} where G is target ON group, K is cutter ID (subIndex)
    - 'cut' shapes -> treated same as off (kept for compatibility)
    """
    cs = canvas_size_mm  # shorthand
    px2mm = cs / canvas_px  # conversion factor: pixels -> mm

    # Marker dimensions scale with canvas (same visual proportion as 30/800 and 50/800)
    marker_w = cs * (30.0 / 800.0)
    marker_m = cs * (50.0 / 800.0)

    markers = VIEW_MARKERS[view]
    left_color = markers['colors'][0]
    right_color = markers['colors'][1]
    left_rgb = markers['rgb'][left_color]
    right_rgb = markers['rgb'][right_color]

    svg_parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{cs}mm" height="{cs}mm" viewBox="0 0 {cs} {cs}">',
        f'  <!-- View: {view.upper()} - Real-world mm - Canvas {cs}mm -->',
        '',
        '  <!-- Background -->',
        f'  <rect width="{cs}" height="{cs}" fill="white"/>',
        '',
        f'  <!-- Left Marker - {left_color.upper()} -->',
        f'  <rect id="marker_{left_color}" x="0" y="{marker_m}" width="{marker_w}" height="{cs - 2*marker_m}" fill="rgb({left_rgb[0]},{left_rgb[1]},{left_rgb[2]})"/>',
        '',
        f'  <!-- Right Marker - {right_color.upper()} -->',
        f'  <rect id="marker_{right_color}" x="{cs - marker_w}" y="{marker_m}" width="{marker_w}" height="{cs - 2*marker_m}" fill="rgb({right_rgb[0]},{right_rgb[1]},{right_rgb[2]})"/>',
    ]

    # For TOP view, add depth markers (top=front edge, bottom=back edge)
    if view == 'top' and 'depth_colors' in markers:
        top_color = markers['depth_colors'][0]  # purple = front edge
        bottom_color = markers['depth_colors'][1]  # orange = back edge
        top_rgb = markers['depth_rgb'][top_color]
        bottom_rgb = markers['depth_rgb'][bottom_color]

        svg_parts.extend([
            '',
            f'  <!-- Top Marker (Front Edge) - {top_color.upper()} -->',
            f'  <rect id="marker_{top_color}" x="{marker_m}" y="0" width="{cs - 2*marker_m}" height="{marker_w}" fill="rgb({top_rgb[0]},{top_rgb[1]},{top_rgb[2]})"/>',
            '',
            f'  <!-- Bottom Marker (Back Edge) - {bottom_color.upper()} -->',
            f'  <rect id="marker_{bottom_color}" x="{marker_m}" y="{cs - marker_w}" width="{cs - 2*marker_m}" height="{marker_w}" fill="rgb({bottom_rgb[0]},{bottom_rgb[1]},{bottom_rgb[2]})"/>',
        ])

    svg_parts.extend([
        '',
        '  <!-- Shapes -->',
    ])

    # Add shapes with v6.5.0 naming convention
    for idx, shape in enumerate(shapes):
        shape_type = shape.get('shapeType', 'on')
        color_index = shape.get('colorIndex', 1)
        sub_index = shape.get('subIndex', 0)
        points = shape.get('points', [])

        if len(points) < 3:
            continue

        # Convert pixel coordinates to mm
        points_str = ' '.join(f"{p['x'] * px2mm},{p['y'] * px2mm}" for p in points)

        # Determine color and name based on type
        if shape_type == 'on':
            rgb = get_on_color_for_index(color_index)
            shape_name = f"on-{color_index}"
        elif shape_type == 'off':
            rgb = get_off_color_for_index(color_index, sub_index)
            shape_name = f"off-{color_index}-{sub_index}"
        elif shape_type == 'cut':
            rgb = get_cut_color_for_index(color_index, sub_index)
            shape_name = f"cut-{color_index}-{sub_index}"
        else:
            rgb = (0, 0, 0)
            shape_name = f"unknown-{idx}"

        shape_id = f"{shape_name}-{idx}"
        svg_parts.append(f'  <polygon id="{shape_id}" points="{points_str}" fill="rgb({rgb[0]},{rgb[1]},{rgb[2]})" stroke="rgb({rgb[0]},{rgb[1]},{rgb[2]})" stroke-width="{2 * px2mm}"/>')

    svg_parts.extend(['', '</svg>'])
    return '\n'.join(svg_parts)


def build_elemente_3d(
    shapes_data: Dict[str, List[Dict]],
    canvas_size_mm: float = 4000.0,
) -> Dict[str, Any]:
    """
    Main function to build 3D model from Elemente shapes using the 3DBuilder add-on v6.5.0.

    SVGs are generated in mm units representing real-world dimensions. The canvas_size_mm
    parameter controls the real-world size and must match the frontend's elementeCanvasSizeMM.
    The solidify thickness and other internal parameters are set by the runner.
    """
    # Find Blender
    blender_exe = find_blender()
    if not blender_exe:
        return {
            "success": False,
            "error": "Blender not found",
            "logs": f"Tried paths: {BLENDER_PATHS}"
        }

    print(f"Using Blender: {blender_exe}")

    # Find the 3DBuilder add-on and runner script
    script_dir = Path(__file__).parent
    addon_path = script_dir.parent.parent / "3dBuilder"
    runner_path = script_dir.parent / "run_blender_job.py"

    # Check if we have run_elevation_builder_job.py instead
    alt_runner = script_dir.parent / "run_elevation_builder_job.py"
    if alt_runner.exists():
        runner_path = alt_runner

    if not addon_path.exists():
        return {
            "success": False,
            "error": "3DBuilder add-on not found",
            "logs": f"Expected at: {addon_path}"
        }

    if not runner_path.exists():
        return {
            "success": False,
            "error": "Runner script not found",
            "logs": f"Expected at: {runner_path}"
        }

    print(f"Using add-on: {addon_path}")
    print(f"Using runner: {runner_path}")

    # Create project directory
    projects_dir = script_dir / "elemente_projects"
    projects_dir.mkdir(exist_ok=True)

    timestamp = time.strftime("%Y%m%d_%H%M%S")
    project_dir = projects_dir / f"build_{timestamp}"
    project_dir.mkdir(exist_ok=True)

    print(f"Project directory: {project_dir}")

    try:
        # Count shapes by type for logging
        on_count = 0
        off_count = 0
        cut_count = 0
        for view, shapes in shapes_data.items():
            for shape in shapes:
                stype = shape.get('shapeType', 'on')
                if stype == 'on':
                    on_count += 1
                elif stype == 'off':
                    off_count += 1
                elif stype == 'cut':
                    cut_count += 1

        print(f"Total shapes: {on_count} 'on', {off_count} 'off', {cut_count} 'cut'")

        if on_count == 0:
            return {
                "success": False,
                "error": "No 'on' shapes found",
                "logs": "No shapes with shapeType='on' to process"
            }

        # Generate SVGs for all views (including top view)
        views_with_on = 0
        for view in ['front', 'right', 'left', 'back', 'top']:
            all_shapes = shapes_data.get(view, [])
            svg_content = generate_svg_for_view_unified(view, all_shapes, canvas_size_mm=canvas_size_mm)
            svg_path = project_dir / f"{view}.svg"
            with open(svg_path, 'w', encoding='utf-8') as f:
                f.write(svg_content)

            on_in_view = sum(1 for s in all_shapes if s.get('shapeType') == 'on')
            off_in_view = sum(1 for s in all_shapes if s.get('shapeType') == 'off')
            cut_in_view = sum(1 for s in all_shapes if s.get('shapeType') == 'cut')
            if on_in_view > 0:
                views_with_on += 1
            print(f"  {view}.svg: {on_in_view} on, {off_in_view} off, {cut_in_view} cut")

        if views_with_on < 2:
            return {
                "success": False,
                "error": f"Need 'on' shapes in at least 2 views, only found in {views_with_on}",
                "logs": "Shapes must be present in at least 2 views to create an intersection"
            }

        # Run Blender with 3dBuilder add-on
        output_glb = project_dir / "output.glb"
        output_ifc = project_dir / "output.ifc"
        output_blend = project_dir / "debug.blend"

        cmd = [
            blender_exe,
            "--background",
            "--python", str(runner_path),
            "--",
            "--addon", str(addon_path),
            "--svgs_dir", str(project_dir),
            "--out", str(output_glb),
            "--out_ifc", str(output_ifc),
            "--out_blend", str(output_blend),
        ]

        print(f"Running Blender...")
        proc = subprocess.run(
            cmd,
            cwd=str(project_dir),
            capture_output=True,
            text=True,
            errors="replace",
            timeout=120
        )

        logs = f"=== STDOUT ===\n{proc.stdout}\n\n=== STDERR ===\n{proc.stderr}"

        log_path = project_dir / "blender_output.log"
        with open(log_path, 'w', encoding='utf-8') as f:
            f.write(logs)

        if output_glb.exists() and output_glb.stat().st_size > 0:
            with open(output_glb, 'rb') as f:
                glb_data = f.read()
            print(f"Success! GLB size: {len(glb_data)} bytes")

            # Read IFC if it was generated
            ifc_data = None
            if output_ifc.exists() and output_ifc.stat().st_size > 0:
                with open(output_ifc, 'rb') as f:
                    ifc_data = f.read()
                print(f"IFC size: {len(ifc_data)} bytes")

            return {
                "success": True,
                "glb_data": glb_data,
                "ifc_data": ifc_data,
                "logs": logs,
                "project_dir": str(project_dir)
            }
        else:
            return {
                "success": False,
                "error": "No output file created",
                "logs": logs,
                "project_dir": str(project_dir)
            }

    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "error": "Blender process timed out",
            "logs": f"Project directory: {project_dir}"
        }
    except Exception as e:
        import traceback
        return {
            "success": False,
            "error": str(e),
            "logs": traceback.format_exc()
        }


if __name__ == "__main__":
    # Test with sample data - includes 'on' and 'off' shapes with cutters
    test_shapes = {
        "front": [
            {
                "points": [{"x": 200, "y": 200}, {"x": 600, "y": 200}, {"x": 600, "y": 600}, {"x": 200, "y": 600}],
                "shapeType": "on",
                "colorIndex": 1
            },
            {
                "points": [{"x": 250, "y": 250}, {"x": 350, "y": 250}, {"x": 350, "y": 350}, {"x": 250, "y": 350}],
                "shapeType": "off",
                "colorIndex": 1,
                "subIndex": 1
            },
            {
                "points": [{"x": 450, "y": 250}, {"x": 550, "y": 250}, {"x": 550, "y": 350}, {"x": 450, "y": 350}],
                "shapeType": "off",
                "colorIndex": 1,
                "subIndex": 2
            }
        ],
        "left": [
            {
                "points": [{"x": 200, "y": 200}, {"x": 600, "y": 200}, {"x": 600, "y": 600}, {"x": 200, "y": 600}],
                "shapeType": "on",
                "colorIndex": 1
            },
            {
                "points": [{"x": 250, "y": 250}, {"x": 350, "y": 250}, {"x": 350, "y": 350}, {"x": 250, "y": 350}],
                "shapeType": "off",
                "colorIndex": 1,
                "subIndex": 1
            },
            {
                "points": [{"x": 450, "y": 250}, {"x": 550, "y": 250}, {"x": 550, "y": 350}, {"x": 450, "y": 350}],
                "shapeType": "off",
                "colorIndex": 1,
                "subIndex": 2
            }
        ]
    }

    result = build_elemente_3d(test_shapes, 100)
    print("\n\nRESULT:")
    print(json.dumps({k: v for k, v in result.items() if k != 'glb_data'}, indent=2))
    if result.get('glb_data'):
        print(f"GLB data size: {len(result['glb_data'])} bytes")
