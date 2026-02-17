"""
Simple DXF to SVG conversion with corner extraction for tracing.
No layout selection - just converts everything to SVG.
Uses raw text parsing as fallback for malformed DXF files.
"""
import ezdxf
from ezdxf import recover
from typing import List, Dict, Tuple, Set
import math
import base64
import tempfile
import os
import re


def parse_dxf_raw(content: str) -> List[Tuple[Tuple[float, float], Tuple[float, float]]]:
    """
    Raw DXF parser - extracts geometry directly from text.
    Handles malformed DXF files that ezdxf cannot parse.
    """
    lines = []

    # Split into group code/value pairs
    raw_lines = content.split('\n')
    pairs = []
    i = 0
    while i < len(raw_lines) - 1:
        try:
            code = int(raw_lines[i].strip())
            value = raw_lines[i + 1].strip()
            pairs.append((code, value))
            i += 2
        except:
            i += 1

    # Find ENTITIES section
    in_entities = False
    current_entity = None
    entity_data = {}
    polyline_points = []

    for code, value in pairs:
        # Track section
        if code == 2 and value == 'ENTITIES':
            in_entities = True
            continue
        if code == 0 and value == 'ENDSEC':
            in_entities = False
            continue

        if not in_entities:
            continue

        # New entity starts
        if code == 0:
            # Process previous entity
            if current_entity == 'LINE' and entity_data:
                try:
                    x1 = float(entity_data.get(10, 0))
                    y1 = float(entity_data.get(20, 0))
                    x2 = float(entity_data.get(11, 0))
                    y2 = float(entity_data.get(21, 0))
                    lines.append(((x1, y1), (x2, y2)))
                except:
                    pass

            elif current_entity == 'LWPOLYLINE' and polyline_points:
                # Check if closed (group code 70, bit 1)
                is_closed = (int(entity_data.get(70, 0)) & 1) == 1
                for j in range(len(polyline_points) - 1):
                    lines.append((polyline_points[j], polyline_points[j + 1]))
                if is_closed and len(polyline_points) > 2:
                    lines.append((polyline_points[-1], polyline_points[0]))

            elif current_entity == 'CIRCLE' and entity_data:
                try:
                    cx = float(entity_data.get(10, 0))
                    cy = float(entity_data.get(20, 0))
                    r = float(entity_data.get(40, 0))
                    for k in range(32):
                        a1 = 2 * math.pi * k / 32
                        a2 = 2 * math.pi * (k + 1) / 32
                        lines.append((
                            (cx + r * math.cos(a1), cy + r * math.sin(a1)),
                            (cx + r * math.cos(a2), cy + r * math.sin(a2))
                        ))
                except:
                    pass

            elif current_entity == 'ARC' and entity_data:
                try:
                    cx = float(entity_data.get(10, 0))
                    cy = float(entity_data.get(20, 0))
                    r = float(entity_data.get(40, 0))
                    sa = math.radians(float(entity_data.get(50, 0)))
                    ea = math.radians(float(entity_data.get(51, 0)))
                    if ea < sa:
                        ea += 2 * math.pi
                    segs = max(8, int((ea - sa) / (math.pi / 16)))
                    for k in range(segs):
                        a1 = sa + (ea - sa) * k / segs
                        a2 = sa + (ea - sa) * (k + 1) / segs
                        lines.append((
                            (cx + r * math.cos(a1), cy + r * math.sin(a1)),
                            (cx + r * math.cos(a2), cy + r * math.sin(a2))
                        ))
                except:
                    pass

            # Start new entity
            current_entity = value
            entity_data = {}
            polyline_points = []
            continue

        # Collect entity data
        if current_entity == 'LWPOLYLINE':
            if code == 10:  # X coordinate
                entity_data['last_x'] = float(value)
            elif code == 20:  # Y coordinate
                if 'last_x' in entity_data:
                    polyline_points.append((entity_data['last_x'], float(value)))
                    del entity_data['last_x']
            elif code == 70:
                entity_data[70] = value
        else:
            entity_data[code] = value

    # Process last entity
    if current_entity == 'LINE' and entity_data:
        try:
            x1 = float(entity_data.get(10, 0))
            y1 = float(entity_data.get(20, 0))
            x2 = float(entity_data.get(11, 0))
            y2 = float(entity_data.get(21, 0))
            lines.append(((x1, y1), (x2, y2)))
        except:
            pass
    elif current_entity == 'LWPOLYLINE' and polyline_points:
        is_closed = (int(entity_data.get(70, 0)) & 1) == 1
        for j in range(len(polyline_points) - 1):
            lines.append((polyline_points[j], polyline_points[j + 1]))
        if is_closed and len(polyline_points) > 2:
            lines.append((polyline_points[-1], polyline_points[0]))

    return lines


def convert_dxf_to_svg(dxf_content: bytes) -> Dict:
    """
    Convert DXF to SVG and extract corners for snapping.

    Returns:
        {
            'svg': base64 encoded SVG data URL,
            'corners': list of {x, y} corner points,
            'width': SVG width,
            'height': SVG height,
            'lineCount': number of lines,
            'cornerCount': number of corners
        }
    """
    lines = []

    # Try ezdxf first
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix='.dxf', mode='wb') as f:
            f.write(dxf_content)
            temp_path = f.name

        try:
            doc, auditor = recover.readfile(temp_path)
            print(f"DXF loaded with ezdxf recovery mode, {len(auditor.errors)} errors found")

            msp = doc.modelspace()
            for entity in msp:
                try:
                    etype = entity.dxftype()
                    if etype == 'LINE':
                        lines.append((
                            (entity.dxf.start.x, entity.dxf.start.y),
                            (entity.dxf.end.x, entity.dxf.end.y)
                        ))
                    elif etype == 'LWPOLYLINE':
                        points = list(entity.get_points('xy'))
                        for i in range(len(points) - 1):
                            lines.append((points[i], points[i + 1]))
                        if entity.closed and len(points) > 2:
                            lines.append((points[-1], points[0]))
                    elif etype == 'CIRCLE':
                        cx, cy = entity.dxf.center.x, entity.dxf.center.y
                        r = entity.dxf.radius
                        for i in range(32):
                            a1 = 2 * math.pi * i / 32
                            a2 = 2 * math.pi * (i + 1) / 32
                            lines.append((
                                (cx + r * math.cos(a1), cy + r * math.sin(a1)),
                                (cx + r * math.cos(a2), cy + r * math.sin(a2))
                            ))
                    elif etype == 'ARC':
                        cx, cy = entity.dxf.center.x, entity.dxf.center.y
                        r = entity.dxf.radius
                        sa = math.radians(entity.dxf.start_angle)
                        ea = math.radians(entity.dxf.end_angle)
                        if ea < sa:
                            ea += 2 * math.pi
                        segs = max(8, int((ea - sa) / (math.pi / 16)))
                        for i in range(segs):
                            a1 = sa + (ea - sa) * i / segs
                            a2 = sa + (ea - sa) * (i + 1) / segs
                            lines.append((
                                (cx + r * math.cos(a1), cy + r * math.sin(a1)),
                                (cx + r * math.cos(a2), cy + r * math.sin(a2))
                            ))
                except Exception as e:
                    print(f"Skipping entity: {e}")
                    continue
        except Exception as e:
            print(f"ezdxf failed: {e}, falling back to raw parser")
            lines = []
    finally:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)

    # Fallback to raw parser if ezdxf failed or found nothing
    if not lines:
        print("Using raw DXF parser...")
        try:
            content = dxf_content.decode('utf-8', errors='ignore')
        except:
            content = dxf_content.decode('latin-1', errors='ignore')
        lines = parse_dxf_raw(content)
        print(f"Raw parser found {len(lines)} lines")

    if not lines:
        raise ValueError("No geometry found in DXF file")

    # Calculate bounds - preserve original DXF coordinates (true scale)
    all_x = [p[0] for line in lines for p in line]
    all_y = [p[1] for line in lines for p in line]
    min_x, max_x = min(all_x), max(all_x)
    min_y, max_y = min(all_y), max(all_y)

    # Calculate raw dimensions
    raw_width = max_x - min_x
    raw_height = max_y - min_y

    # Auto-detect units: if dimensions are > 100, assume millimeters and convert to meters
    # Most architectural DXF files use mm (a 10m room = 10000mm)
    # If already in meters, dimensions would typically be < 100
    scale_factor = 1.0
    if raw_width > 100 or raw_height > 100:
        scale_factor = 0.001  # Convert mm to meters
        print(f"Auto-detected millimeters (raw size: {raw_width:.1f}x{raw_height:.1f}), converting to meters")
    else:
        print(f"Assuming meters (raw size: {raw_width:.4f}x{raw_height:.4f})")

    # Apply scale to all coordinates
    lines = [((p1[0] * scale_factor, p1[1] * scale_factor),
              (p2[0] * scale_factor, p2[1] * scale_factor)) for p1, p2 in lines]
    min_x *= scale_factor
    max_x *= scale_factor
    min_y *= scale_factor
    max_y *= scale_factor

    # Now dimensions are in meters
    width = max_x - min_x
    height = max_y - min_y

    # Minimal safety check for degenerate cases only
    if width < 0.001:
        width = 0.001
    if height < 0.001:
        height = 0.001

    # No padding - preserve exact dimensions for accuracy

    # Generate SVG with true scale dimensions
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.4f} {height:.4f}" width="{width:.4f}" height="{height:.4f}">']
    # Stroke width proportional to drawing size for visibility
    stroke_width = max(width, height) * 0.002
    svg.append(f'<g stroke="#374151" stroke-width="{stroke_width:.4f}" fill="none">')

    for (x1, y1), (x2, y2) in lines:
        # Transform: offset to origin, flip Y (preserve exact coordinates)
        sx1 = x1 - min_x
        sy1 = height - (y1 - min_y)
        sx2 = x2 - min_x
        sy2 = height - (y2 - min_y)
        svg.append(f'<line x1="{sx1:.4f}" y1="{sy1:.4f}" x2="{sx2:.4f}" y2="{sy2:.4f}"/>')

    svg.append('</g></svg>')
    svg_str = '\n'.join(svg)

    # Extract corners (endpoints only - simple and fast)
    # Use higher precision rounding to preserve accuracy
    corners_set: Set[Tuple[float, float]] = set()
    for (x1, y1), (x2, y2) in lines:
        # Transform to SVG coords with high precision
        corners_set.add((round(x1 - min_x, 4), round(height - (y1 - min_y), 4)))
        corners_set.add((round(x2 - min_x, 4), round(height - (y2 - min_y), 4)))

    corners = [{'x': x, 'y': y} for x, y in corners_set]

    # Encode SVG
    svg_b64 = base64.b64encode(svg_str.encode()).decode()
    svg_url = f'data:image/svg+xml;base64,{svg_b64}'

    return {
        'svg': svg_url,
        'corners': corners,
        'width': round(width, 4),
        'height': round(height, 4),
        'lineCount': len(lines),
        'cornerCount': len(corners)
    }
