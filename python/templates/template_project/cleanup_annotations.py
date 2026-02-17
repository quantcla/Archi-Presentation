# -------------------------------------------------------------------------------------------------
# CLEANUP ANNOTATIONS - Post-processing script to remove IfcAnnotation geometry from IFC
#
# This script runs AFTER svg2ifc.py and removes the drawing annotation objects
# that cause clutter in DXF exports. It modifies the generated.ifc file in place.
#
# To disable: simply delete or rename this file
# To revert: the original svg2ifc.py is unchanged, just don't run this script
# -------------------------------------------------------------------------------------------------

import os
import re
import shutil

# Path to the generated IFC file (uses current working directory, not script directory)
# This allows the script to work when copied to project folders
WORK_DIR = os.getcwd()
IFC_PATH = os.path.join(WORK_DIR, "generated.ifc")
BACKUP_PATH = os.path.join(WORK_DIR, "generated_with_annotations.ifc")

def log(msg):
    print(f"[CLEANUP] {msg}")

def cleanup_annotations():
    """
    Remove IfcAnnotation entities and their related geometry from the IFC file.
    This prevents the drawing boundary rectangle from appearing in 3D views and DXF exports.
    """
    if not os.path.exists(IFC_PATH):
        log(f"No IFC file found at {IFC_PATH}")
        return False

    # Create backup
    shutil.copy2(IFC_PATH, BACKUP_PATH)
    log(f"Created backup: {BACKUP_PATH}")

    with open(IFC_PATH, 'r', encoding='utf-8') as f:
        content = f.read()

    lines = content.split('\n')

    # Find all IfcAnnotation entity IDs
    annotation_ids = set()
    annotation_pattern = re.compile(r'^#(\d+)\s*=\s*IFCANNOTATION\s*\(', re.IGNORECASE)

    for line in lines:
        match = annotation_pattern.match(line.strip())
        if match:
            annotation_ids.add(match.group(1))

    if not annotation_ids:
        log("No IfcAnnotation entities found - nothing to clean")
        return True

    log(f"Found {len(annotation_ids)} IfcAnnotation entities to remove: {annotation_ids}")

    # Find all related entities (shape representations, placement, etc.)
    # We'll collect IDs that reference the annotations
    related_ids = set()

    for anno_id in annotation_ids:
        # Find the IFCANNOTATION line to get its references
        anno_pattern = re.compile(rf'^#({anno_id})\s*=\s*IFCANNOTATION\s*\([^)]*\)', re.IGNORECASE)
        for line in lines:
            if anno_pattern.match(line.strip()):
                # Extract all #ID references from this line
                refs = re.findall(r'#(\d+)', line)
                related_ids.update(refs)

    # IDs to remove (annotations + directly referenced geometry)
    # Be conservative - only remove the annotation entities themselves
    ids_to_remove = annotation_ids

    log(f"Removing {len(ids_to_remove)} entities")

    # Filter out lines that define these entities
    new_lines = []
    removed_count = 0

    for line in lines:
        # Check if this line defines an entity we want to remove
        entity_match = re.match(r'^#(\d+)\s*=', line.strip())
        if entity_match and entity_match.group(1) in ids_to_remove:
            removed_count += 1
            log(f"Removed: {line.strip()[:80]}...")
            continue
        new_lines.append(line)

    # Also remove references to removed entities from IFCRELAGGREGATES and IFCRELCONTAINEDINSPATIALSTRUCTURE
    # This prevents dangling references
    final_lines = []
    for line in new_lines:
        modified_line = line
        for anno_id in annotation_ids:
            # Remove references like ,#123, or (#123, or ,#123) from aggregate lists
            modified_line = re.sub(rf',\s*#{anno_id}\b', '', modified_line)
            modified_line = re.sub(rf'#{anno_id}\s*,', '', modified_line)
            # Handle case where it's the only item: (#123) -> ()
            modified_line = re.sub(rf'\(\s*#{anno_id}\s*\)', '()', modified_line)
        final_lines.append(modified_line)

    # Write the cleaned IFC
    with open(IFC_PATH, 'w', encoding='utf-8') as f:
        f.write('\n'.join(final_lines))

    log(f"Cleaned IFC written to {IFC_PATH}")
    log(f"Removed {removed_count} annotation entities")

    return True

if __name__ == "__main__":
    try:
        cleanup_annotations()
        log("Cleanup complete!")
    except Exception as e:
        log(f"Error during cleanup: {e}")
        import traceback
        traceback.print_exc()
