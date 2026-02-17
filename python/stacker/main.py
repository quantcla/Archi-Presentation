from fastapi import FastAPI, UploadFile, Form, File, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from typing import List, Optional, Dict, Any
from pydantic import BaseModel
import json
import tempfile
import os
import traceback
import base64
from elemente_builder import build_elemente_3d

app = FastAPI()


# Pydantic models for Elemente Builder
class Point(BaseModel):
    x: float
    y: float

class ElementeShape(BaseModel):
    id: int
    viewId: str
    points: List[Point]
    shapeType: str
    colorIndex: int
    subIndex: int = 0  # Cutter ID for off/cut shapes (0 for on shapes)
    closed: bool

class ElementeBuildRequest(BaseModel):
    shapes: List[ElementeShape]
    canvasSizeMM: float = 4000.0  # Canvas size in mm (1:100 scale)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/api/merge-glb")
async def merge_glb(files: List[UploadFile] = File(...), transforms: str = Form(...)):
    """
    Merge multiple GLB files into a single GLB file with proper transforms applied.
    Each file is positioned according to its transform (x, y, z, rot).
    """
    temp_files = []
    try:
        print(f"Received {len(files)} files for GLB merging")
        transform_list = json.loads(transforms)
        print(f"Transforms: {transform_list}")

        # We'll use pygltflib to merge GLB files
        try:
            from merge_glb import merge_glb_files
        except ImportError:
            # Fallback: just return the first file if merge not available
            if len(files) > 0:
                content = await files[0].read()
                tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".glb", mode='wb')
                tmp.write(content)
                tmp.close()
                return FileResponse(tmp.name, filename="merged_building.glb", media_type="model/gltf-binary")
            raise HTTPException(status_code=500, detail="No merge library available and no files provided")

        floor_data = []
        for i, file in enumerate(files):
            content = await file.read()
            print(f"File {i}: {file.filename}, size: {len(content)} bytes")

            # Write content to a temp file
            temp_glb = tempfile.NamedTemporaryFile(delete=False, suffix=".glb", mode='wb')
            temp_glb.write(content)
            temp_glb.close()
            temp_files.append(temp_glb.name)

            props = transform_list[i]
            floor_data.append({
                'file_path': temp_glb.name,
                'tx': props.get('x') or 0,
                'ty': props.get('y') or 0,  # elevation
                'tz': props.get('z') or 0,
                'rot': props.get('rot') or 0
            })

        print("Starting GLB merge...")
        output_path = tempfile.NamedTemporaryFile(delete=False, suffix=".glb").name
        merge_glb_files(floor_data, output_path)
        print(f"GLB merge complete, output: {output_path}")

        return FileResponse(output_path, filename="merged_building.glb", media_type="model/gltf-binary")

    except Exception as e:
        print(f"Error during GLB merge: {str(e)}")
        print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))

    finally:
        # Clean up temp files
        for temp_file in temp_files:
            try:
                os.unlink(temp_file)
            except:
                pass


@app.post("/api/convert-ifc-to-glb")
async def convert_ifc_to_glb(file: UploadFile = File(...)):
    """
    Convert a single IFC file to GLB format.
    """
    try:
        print(f"Converting IFC to GLB: {file.filename}")
        content = await file.read()

        # Write to temp file
        temp_ifc = tempfile.NamedTemporaryFile(delete=False, suffix=".ifc", mode='wb')
        temp_ifc.write(content)
        temp_ifc.close()

        try:
            from convert_ifc import convert_ifc_to_glb as do_convert
            output_path = tempfile.NamedTemporaryFile(delete=False, suffix=".glb").name
            do_convert(temp_ifc.name, output_path)
            return FileResponse(output_path, filename="converted.glb", media_type="model/gltf-binary")
        except ImportError:
            raise HTTPException(status_code=500, detail="IFC to GLB conversion not available")
        finally:
            os.unlink(temp_ifc.name)

    except Exception as e:
        print(f"Error during IFC to GLB conversion: {str(e)}")
        print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/convert-dxf")
async def convert_dxf(file: UploadFile = File(...)):
    """
    Convert a DXF file to SVG format with extracted corner points for tracing.
    Returns SVG as base64 data URL and corner coordinates.
    """
    try:
        print(f"Converting DXF to SVG: {file.filename}")
        content = await file.read()

        from convert_dxf import convert_dxf_to_svg
        result = convert_dxf_to_svg(content)

        print(f"DXF conversion complete: {result['lineCount']} lines, {result['cornerCount']} corners")
        return result

    except Exception as e:
        print(f"Error during DXF to SVG conversion: {str(e)}")
        print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/elemente-build")
async def elemente_build(request: ElementeBuildRequest):
    """
    Build a 3D model from Elemente shapes using the 3D Builder approach.
    Takes shapes from 5 views (front, right, left, back, top) and creates an intersection mesh.
    The 'top' view is for floor plan drawing and doesn't intersect with side views.
    Returns the GLB file as base64.
    """
    try:
        print(f"Elemente Build: Received {len(request.shapes)} shapes")

        # Debug: print raw viewIds received
        raw_views = [shape.viewId for shape in request.shapes]
        print(f"  Raw viewIds received: {raw_views}")

        # Group shapes by view
        shapes_by_view: Dict[str, List[Dict[str, Any]]] = {
            'front': [],
            'right': [],
            'left': [],
            'back': [],
            'top': []
        }

        for shape in request.shapes:
            view = shape.viewId.lower()
            print(f"  Shape id={shape.id}, viewId='{shape.viewId}' -> '{view}', shapeType='{shape.shapeType}'")
            if view in shapes_by_view:
                shapes_by_view[view].append({
                    'points': [{'x': p.x, 'y': p.y} for p in shape.points],
                    'shapeType': shape.shapeType,
                    'colorIndex': shape.colorIndex,
                    'subIndex': shape.subIndex
                })
            else:
                print(f"  WARNING: Unknown view '{view}' - not in shapes_by_view!")

        # Count shapes per view
        for view, shapes in shapes_by_view.items():
            if shapes:
                print(f"  {view}: {len(shapes)} shapes")

        # Check if we have at least 2 views with shapes (top view counts as a regular view for intersection)
        views_with_shapes = [v for v, s in shapes_by_view.items() if len(s) > 0]

        if len(views_with_shapes) < 2:
            return {
                "success": False,
                "error": f"Need shapes on at least 2 views for 3D intersection. Found shapes on: {', '.join(views_with_shapes) if views_with_shapes else 'none'}"
            }

        # Run the builder
        result = build_elemente_3d(shapes_by_view, request.canvasSizeMM)

        if result.get('success') and result.get('glb_data'):
            # Convert GLB to base64 for JSON response
            glb_base64 = base64.b64encode(result['glb_data']).decode('utf-8')

            # Convert IFC to base64 if available
            ifc_base64 = None
            if result.get('ifc_data'):
                ifc_base64 = base64.b64encode(result['ifc_data']).decode('utf-8')

            return {
                "success": True,
                "glb": glb_base64,
                "ifc": ifc_base64,
                "logs": result.get('logs', '')
            }
        else:
            return {
                "success": False,
                "error": result.get('error', 'Unknown error'),
                "logs": result.get('logs', '')
            }

    except Exception as e:
        print(f"Error during Elemente build: {str(e)}")
        print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/health")
async def health_check():
    """Simple health check endpoint."""
    return {"status": "ok", "service": "elemente-builder"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
