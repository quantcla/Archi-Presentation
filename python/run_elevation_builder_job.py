"""
Elevation Builder Job Runner
Runs the 3DBuilder add-on (v6.5.0) in Blender to process elevation SVGs into 3D models.

v6.5.0 changes:
- Operator is now eb.create_mesh_parts (was eb.create_intersection_mesh)
- Output is multiple part objects in EB_Output collection (not a single EB_Result)
- Exports ALL mesh objects from EB_Output (excluding EB_TopPlane)

Usage:
    blender --background --python run_elevation_builder_job.py -- \
        --addon /path/to/3dBuilder \
        --svgs_dir /path/to/svgs \
        --out /path/to/output.glb \
        --out_blend /path/to/debug.blend \
        --thickness 500
"""

import sys
import os
import argparse
import importlib.util


def export_meshes_to_ifc(mesh_objects, output_path):
    """
    Export Blender mesh objects to IFC using Bonsai's built-in IFC project.
    Creates a new IFC project, assigns each mesh as IfcBuildingElementProxy,
    then saves the .ifc file via Bonsai.
    """
    import bpy
    from bonsai.bim.ifc import IfcStore

    # Step 1: Create a new Bonsai IFC project (sets up site/building/storey)
    bpy.ops.bim.create_project()
    print("[IFC] Bonsai IFC project created")

    # Step 2: Assign each result mesh as IfcBuildingElementProxy
    for obj in mesh_objects:
        if obj.type != 'MESH':
            continue
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.bim.assign_class(
            ifc_class="IfcBuildingElementProxy",
            predefined_type="NOTDEFINED",
        )
        print(f"[IFC] Assigned '{obj.name}' as IfcBuildingElementProxy")

    # Step 3: Save the IFC file
    IfcStore.path = output_path
    bpy.ops.bim.save_project(filepath=output_path)
    print(f"[IFC] Saved to {output_path}")


def main():
    # Parse arguments after "--"
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []

    parser = argparse.ArgumentParser(description="Elevation Builder Job")
    parser.add_argument("--addon", required=True, help="Path to 3dBuilder add-on file")
    parser.add_argument("--svgs_dir", required=True, help="Directory containing front.svg, right.svg, left.svg, back.svg")
    parser.add_argument("--out", required=True, help="Output GLB path")
    parser.add_argument("--out_ifc", default="", help="Output IFC path")
    parser.add_argument("--out_blend", default="", help="Optional output .blend path for debugging")
    parser.add_argument("--thickness", type=float, default=500.0, help="Extrusion thickness")
    args = parser.parse_args(argv)

    print(f"[RUNNER] Starting Elevation Builder Job")
    print(f"[RUNNER] Add-on path: {args.addon}")
    print(f"[RUNNER] SVGs directory: {args.svgs_dir}")
    print(f"[RUNNER] Output GLB: {args.out}")
    print(f"[RUNNER] Thickness: {args.thickness}")

    # Import bpy (only available when running inside Blender)
    try:
        import bpy
    except ImportError:
        print("[ERROR] This script must be run from within Blender")
        sys.exit(1)

    # Clear the scene first
    print("[RUNNER] Clearing scene...")
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

    # Also clear any existing collections (except Scene Collection)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)

    # Load the add-on from file path
    addon_path = os.path.abspath(args.addon)
    print(f"[RUNNER] Loading add-on from: {addon_path}")

    if not os.path.exists(addon_path):
        print(f"[ERROR] Add-on file not found: {addon_path}")
        sys.exit(1)

    # If addon_path doesn't end in .py, we need to copy/rename it temporarily
    # or use exec() to load the code directly
    try:
        # Read the file content and execute it
        print("[RUNNER] Loading add-on code...")
        with open(addon_path, 'r', encoding='utf-8') as f:
            addon_code = f.read()

        # Create a module namespace
        import types
        eb_module = types.ModuleType("elevation_builder")
        eb_module.__file__ = addon_path

        # Execute the code in the module's namespace
        exec(addon_code, eb_module.__dict__)

        sys.modules["elevation_builder"] = eb_module
        print("[RUNNER] Add-on module loaded")
    except Exception as e:
        print(f"[ERROR] Failed to load add-on module: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

    # Register the add-on
    try:
        if hasattr(eb_module, 'register'):
            eb_module.register()
            print("[RUNNER] Add-on registered")
    except Exception as e:
        print(f"[WARNING] Could not register add-on: {e}")

    # Set add-on settings
    try:
        s = bpy.context.scene.eb_settings

        # SVGs are in mm units representing real-world dimensions.
        # Blender imports 1mm as 0.001 BU (= 0.001m), so no extra scaling needed:
        #   e.g. 20000mm canvas * 0.001 BU/mm = 20 BU (= 20m real).
        s.apply_svg_scale_on_align = True
        s.svg_to_world_scale = 1.0

        # Solidify thickness must be large enough for panel slabs to overlap
        # for intersection. Canvas up to 20000mm → 20 BU, so 50 BU covers it.
        s.solidify_thickness = 50.0

        # Cutter padding in BU. 0.01 BU = 10mm real — enough to
        # avoid coplanar boolean faces without visible distortion.
        s.cutter_padding = 0.01

        # Top plane margin in BU. 0.5 BU = 500mm real — modest margin.
        s.top_plane_margin = 0.5

        print(f"[RUNNER] Set svg_to_world_scale to 1.0 (real-world mm, no extra scaling)")
        print(f"[RUNNER] Set solidify_thickness to {s.solidify_thickness} (internal slab depth)")
        print(f"[RUNNER] Set cutter_padding to {s.cutter_padding}")
        print(f"[RUNNER] Set top_plane_margin to {s.top_plane_margin}")
    except Exception as e:
        print(f"[WARNING] Could not set eb_settings: {e}")

    # Import SVG files (all 5 views: front, right, left, back, top)
    svgs_dir = os.path.abspath(args.svgs_dir)
    svg_files = ['front.svg', 'right.svg', 'left.svg', 'back.svg', 'top.svg']

    print(f"[RUNNER] Importing SVGs from: {svgs_dir}")

    imported_count = 0
    for svg_name in svg_files:
        svg_path = os.path.join(svgs_dir, svg_name)
        if os.path.exists(svg_path):
            print(f"[RUNNER] Importing {svg_name}...")
            try:
                bpy.ops.import_curve.svg(filepath=svg_path)
                imported_count += 1
                print(f"[RUNNER] Successfully imported {svg_name}")
            except Exception as e:
                print(f"[WARNING] Failed to import {svg_name}: {e}")
        else:
            print(f"[WARNING] SVG not found: {svg_path}")

    if imported_count == 0:
        print("[ERROR] No SVGs were imported!")
        sys.exit(1)

    # List imported collections
    print(f"[RUNNER] Collections after import: {[c.name for c in bpy.data.collections]}")

    # List imported collections (brief)
    print(f"[RUNNER] Imported collections: {[c.name for c in bpy.data.collections]}")

    # Run align panels operator
    print("[RUNNER] Running align_panels...")
    try:
        result = bpy.ops.eb.align_panels()
        print(f"[RUNNER] align_panels result: {result}")
    except Exception as e:
        print(f"[ERROR] align_panels failed: {e}")
        import traceback
        traceback.print_exc()

    # Run create mesh parts operator (v6.5.0 - produces multiple parts, no final union)
    print("[RUNNER] Running create_mesh_parts...")
    try:
        result = bpy.ops.eb.create_mesh_parts()
        print(f"[RUNNER] create_mesh_parts result: {result}")
    except Exception as e:
        print(f"[ERROR] create_mesh_parts failed: {e}")
        import traceback
        traceback.print_exc()

    # Find all result mesh objects in EB_Output collection
    result_objs = []

    for coll in bpy.data.collections:
        if 'EB_Output' in coll.name:
            for obj in coll.objects:
                if obj.type == 'MESH' and obj.name != 'EB_TopPlane':
                    result_objs.append(obj)

    # Fallback: look for EB_ prefixed mesh objects anywhere
    if not result_objs:
        for obj in bpy.data.objects:
            if obj.type == 'MESH' and obj.name.startswith('EB_') and obj.name != 'EB_TopPlane':
                result_objs.append(obj)

    # Last resort: any mesh
    if not result_objs:
        for obj in bpy.data.objects:
            if obj.type == 'MESH':
                result_objs.append(obj)
                break

    if result_objs:
        print(f"[RUNNER] Found {len(result_objs)} result object(s): {[o.name for o in result_objs]}")

        # Set all result meshes to standard white material (like default cube)
        white_mat = bpy.data.materials.new(name="Elemente_White")
        white_mat.use_nodes = True
        bsdf = white_mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (0.8, 0.8, 0.8, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.5
        for obj in result_objs:
            if obj.type == 'MESH':
                obj.data.materials.clear()
                obj.data.materials.append(white_mat)
        print(f"[RUNNER] Applied white material to {len(result_objs)} object(s)")

        # Select all result objects for export
        bpy.ops.object.select_all(action='DESELECT')
        for obj in result_objs:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = result_objs[0]

        # Export to GLB (all selected parts)
        print(f"[RUNNER] Exporting {len(result_objs)} part(s) to: {args.out}")
        try:
            bpy.ops.export_scene.gltf(
                filepath=args.out,
                export_format='GLB',
                use_selection=True,
                export_apply=True
            )
            print(f"[RUNNER] GLB export complete")

            # Verify the file was created
            if os.path.exists(args.out):
                file_size = os.path.getsize(args.out)
                print(f"[RUNNER] Output file size: {file_size} bytes")
            else:
                print("[ERROR] Output file was not created!")
        except Exception as e:
            print(f"[ERROR] GLB export failed: {e}")
            import traceback
            traceback.print_exc()
        # Export to IFC (using ifcopenshell)
        if args.out_ifc:
            print(f"[RUNNER] Exporting IFC to: {args.out_ifc}")
            try:
                export_meshes_to_ifc(result_objs, args.out_ifc)
                if os.path.exists(args.out_ifc):
                    ifc_size = os.path.getsize(args.out_ifc)
                    print(f"[RUNNER] IFC export complete, size: {ifc_size} bytes")
                else:
                    print("[WARNING] IFC output file was not created")
            except Exception as e:
                print(f"[WARNING] IFC export failed: {e}")
                import traceback
                traceback.print_exc()

    else:
        print("[ERROR] No mesh object found to export")
        print(f"[DEBUG] Available objects: {[o.name for o in bpy.data.objects]}")
        print(f"[DEBUG] Available collections: {[c.name for c in bpy.data.collections]}")

    # Save debug blend file if requested
    if args.out_blend:
        print(f"[RUNNER] Saving debug blend: {args.out_blend}")
        try:
            bpy.ops.wm.save_as_mainfile(filepath=args.out_blend)
            print("[RUNNER] Blend file saved")
        except Exception as e:
            print(f"[WARNING] Could not save blend file: {e}")

    print("[RUNNER] Job complete")


if __name__ == "__main__":
    main()
