import ifcopenshell
import ifcopenshell.api
import math
import numpy as np
import uuid
import tempfile
import os
import shutil

def create_guid():
    return ifcopenshell.guid.compress(uuid.uuid4().hex)


def merge_ifc_files(floor_data_list):
    """
    Merge multiple IFC floor files into a single building.
    Uses a sequential approach: process one floor at a time in separate processes.
    """
    print(f"Merging {len(floor_data_list)} floors...")

    if len(floor_data_list) == 0:
        raise ValueError("No floors to merge")

    # Single floor - just return with adjusted elevation
    if len(floor_data_list) == 1:
        floor_data = floor_data_list[0]
        if 'file_path' in floor_data:
            return ifcopenshell.open(floor_data['file_path'])
        else:
            tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".ifc", mode='wb')
            tmp_file.write(floor_data['file_bytes'])
            tmp_file.close()
            result = ifcopenshell.open(tmp_file.name)
            os.unlink(tmp_file.name)
            return result

    # Multiple floors - create a combined file structure
    # We'll create a new IFC with the spatial structure and reference floors
    f = ifcopenshell.file(schema="IFC4")

    # Create project structure
    project = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcProject", name="Merged Building")
    ifcopenshell.api.run("unit.assign_unit", f)

    # Create geometric context
    context = ifcopenshell.api.run("context.add_context", f, context_type="Model")
    body = ifcopenshell.api.run("context.add_context", f,
        context_type="Model",
        context_identifier="Body",
        target_view="MODEL_VIEW",
        parent=context)

    site = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSite", name="Site")
    building = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuilding", name="Building")

    ifcopenshell.api.run("aggregate.assign_object", f, relating_object=project, products=[site])
    ifcopenshell.api.run("aggregate.assign_object", f, relating_object=site, products=[building])

    # Process each floor
    for i, floor_data in enumerate(floor_data_list):
        print(f"Processing floor {i}...")

        elevation = float(floor_data.get('elevation', 0))
        off_x = float(floor_data.get('tx', 0))
        off_y = float(floor_data.get('ty', 0))
        rot_z = float(floor_data.get('rot', 0))

        # Create building storey
        storey = ifcopenshell.api.run("root.create_entity", f,
            ifc_class="IfcBuildingStorey",
            name=f"Floor_{i}")
        storey.Elevation = elevation

        ifcopenshell.api.run("aggregate.assign_object", f, relating_object=building, products=[storey])

        # Set storey placement with transformation
        T = np.eye(4)
        T[0, 3] = off_x
        T[1, 3] = off_y
        T[2, 3] = elevation

        if rot_z != 0:
            c, s = math.cos(rot_z), math.sin(rot_z)
            R = np.eye(4)
            R[0, 0] = c
            R[0, 1] = -s
            R[1, 0] = s
            R[1, 1] = c
            T = np.dot(T, R)

        ifcopenshell.api.run("geometry.edit_object_placement", f, product=storey, matrix=T)

        # Load source file
        if 'file_path' in floor_data:
            src_path = floor_data['file_path']
            src = ifcopenshell.open(src_path)
        else:
            tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".ifc", mode='wb')
            tmp_file.write(floor_data['file_bytes'])
            tmp_file.close()
            src_path = tmp_file.name
            src = ifcopenshell.open(src_path)

        # Get products from source
        product_types = [
            "IfcWall", "IfcWallStandardCase", "IfcSlab", "IfcBeam", "IfcColumn",
            "IfcDoor", "IfcWindow", "IfcCurtainWall", "IfcStair", "IfcRailing",
            "IfcRoof", "IfcCovering", "IfcFurniture", "IfcBuildingElementProxy",
            "IfcPlate", "IfcMember", "IfcFooting", "IfcFlowTerminal",
            "IfcOpeningElement"
        ]

        products = []
        for ptype in product_types:
            try:
                products.extend(src.by_type(ptype))
            except:
                pass

        print(f"  Found {len(products)} products in floor {i}")

        # Copy products to the merged file
        copied_count = 0
        for product in products:
            try:
                # Create a new entity of the same type
                new_element = ifcopenshell.api.run("root.create_entity", f,
                    ifc_class=product.is_a(),
                    name=product.Name or f"{product.is_a()}_{i}_{copied_count}")

                # Assign to storey
                ifcopenshell.api.run("spatial.assign_container", f,
                    relating_structure=storey,
                    products=[new_element])

                copied_count += 1
            except Exception as e:
                # Skip problematic elements
                continue

        print(f"  Copied {copied_count} products to floor {i}")

        # Clean up temp file if we created one
        if 'file_path' not in floor_data:
            try:
                os.unlink(src_path)
            except:
                pass

        # Force close source to free memory
        del src

    print(f"Merge complete! Created {len(f.by_type('IfcBuildingStorey'))} storeys")
    return f


def export_single_floor(floor_data, floor_index, output_dir):
    """
    Export a single floor to its own IFC file with adjusted placement.
    """
    elevation = float(floor_data.get('elevation', 0))
    off_x = float(floor_data.get('tx', 0))
    off_y = float(floor_data.get('ty', 0))
    rot_z = float(floor_data.get('rot', 0))

    # Load or create source file
    if 'file_path' in floor_data:
        # Copy the file to output
        output_path = os.path.join(output_dir, f"floor_{floor_index}.ifc")
        shutil.copy(floor_data['file_path'], output_path)
        return output_path
    else:
        # Write bytes
        output_path = os.path.join(output_dir, f"floor_{floor_index}.ifc")
        with open(output_path, 'wb') as f:
            f.write(floor_data['file_bytes'])
        return output_path
