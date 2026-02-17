import os
import re
import shutil
import subprocess
import time
import sys
import json
import argparse
from pathlib import Path

# =========================
# CONFIG
# =========================
# ⚠️ MAKE SURE THIS PATH IS CORRECT FOR YOUR PC ⚠️
BLENDER_EXE = r"C:\Program Files\Blender Foundation\Blender 5.0\blender.exe"

# Paths
SCRIPT_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = SCRIPT_DIR / "templates"
PROJECTS_DIR = SCRIPT_DIR.parent / "public" / "projects"

TEMPLATE_NAME = "template_project"
TEMPLATE_BLEND = "template.blend"
TEMPLATE_SVG2IFC = "svg2ifc.py"

# =========================
# UTILS
# =========================
def slugify(name: str) -> str:
    name = (name or "").strip()
    if not name: name = "project"
    name = name.lower()
    name = re.sub(r"[^a-z0-9_\-]+", "_", name)
    return re.sub(r"_+", "_", name).strip("_")

def unique_project_dir(base_slug: str) -> Path:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    p = PROJECTS_DIR / base_slug
    if not p.exists(): return p
    for i in range(2, 1000):
        p2 = PROJECTS_DIR / f"{base_slug}_{i}"
        if not p2.exists(): return p2
    return PROJECTS_DIR / f"{base_slug}_{int(time.time())}"

def run_blender_direct(project_dir: Path):
    """
    Runs Blender directly on the blend file, executing the script.
    """
    blend_file = project_dir / TEMPLATE_BLEND
    script_file = project_dir / TEMPLATE_SVG2IFC

    cmd = [
        BLENDER_EXE,
        str(blend_file),       
        "--background",        
        "--python-exit-code", "1", 
        "--python", str(script_file) 
    ]
    
    proc = subprocess.run(
        cmd, 
        cwd=str(project_dir), 
        capture_output=True, 
        text=True, 
        errors="replace",
        env=os.environ.copy()
    )
    return proc.returncode, proc.stdout, proc.stderr

def collect_outputs(project_dir: Path):
    files = []
    
    # 1. IFC Model (Renamed to Model.ifc)
    if (project_dir / "generated.ifc").exists():
        files.append({"name": "Model.ifc", "path": f"/projects/{project_dir.name}/generated.ifc"})

    # 2. Define the Search Directories
    search_dirs = [
        project_dir / "exports" / "_FLAT",
        project_dir / "exports",
        project_dir / "drawings",
        project_dir / "layouts",
        project_dir / "sheets"
    ]

    # 3. Define the Whitelist (Files you WANT)
    # We use partial matching so "A01 - Grundriss.pdf" matches "Grundriss"
    wanted_keywords = [
        "plan.dxf",      # Covers "My Story plan.dxf" or just "plan.dxf"
        "grundriss.pdf", # Covers "A01 Grundriss.pdf"
        "model.ifc"      # Handled above, but listed for clarity
    ]

    seen_names = set()

    for d in search_dirs:
        if d.exists():
            for f in d.glob("*.*"):
                fname_lower = f.name.lower()
                
                # CHECK: Is this file in our whitelist?
                is_wanted = False
                for kw in wanted_keywords:
                    if kw in fname_lower:
                        is_wanted = True
                        break
                
                if is_wanted and f.name not in seen_names:
                    try:
                        # Build relative path for URL
                        rel_dir = d.relative_to(PROJECTS_DIR)
                        web_path = f"/projects/{rel_dir.as_posix()}/{f.name}"
                    except ValueError:
                        # Fallback path logic
                        try:
                            rel_dir = d.relative_to(project_dir)
                            web_path = f"/projects/{project_dir.name}/{rel_dir.as_posix()}/{f.name}"
                        except:
                            continue

                    files.append({"name": f.name, "path": web_path})
                    seen_names.add(f.name)

    return files

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--svg", required=True)
    parser.add_argument("--name", default="my_project")
    args = parser.parse_args()

    try:
        # 1. Setup Project Folder
        base = slugify(args.name)
        project_dir = unique_project_dir(base)
        
        src_template = TEMPLATES_DIR / TEMPLATE_NAME
        if not src_template.exists():
            print(json.dumps({"success": False, "error": f"Template missing at {src_template}"}))
            return
            
        shutil.copytree(src_template, project_dir)
        shutil.copy2(args.svg, project_dir / "plan.svg")

        # 2. Run Blender
        rc, out, err = run_blender_direct(project_dir)

        full_log = (out + "\n" + err).strip()

        # 2b. Run cleanup to remove IfcAnnotation from generated.ifc (optional post-processing)
        cleanup_script = project_dir / "cleanup_annotations.py"
        if cleanup_script.exists() and (project_dir / "generated.ifc").exists():
            try:
                cleanup_result = subprocess.run(
                    [sys.executable, str(cleanup_script)],
                    cwd=str(project_dir),
                    capture_output=True,
                    text=True,
                    timeout=30
                )
                full_log += "\n" + cleanup_result.stdout + cleanup_result.stderr
            except Exception as cleanup_err:
                full_log += f"\n[CLEANUP WARNING] {cleanup_err}"

        # 3. Return JSON
        if rc == 0:
            files = collect_outputs(project_dir)
            print(json.dumps({
                "success": True,
                "project_id": project_dir.name,
                "files": files,
                "logs": full_log[-3000:] 
            }))
        else:
            print(json.dumps({
                "success": False,
                "error": "Blender process failed",
                "logs": full_log[-3000:]
            }))

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e), "logs": str(e)}))

if __name__ == "__main__":
    main()