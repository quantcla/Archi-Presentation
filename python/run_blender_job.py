# __run_inside_blender.py
import argparse, os, sys, time
import bpy

def log(msg): print(f"[WRAPPER] {msg}")

def remove_gpu_drawing_handlers():
    removed = 0
    try:
        hp = bpy.app.handlers.load_post
        for h in list(hp):
            mod = (getattr(h, "__module__", "") or "").lower()
            name = (getattr(h, "__name__", "") or "").lower()
            low = f"{mod}::{name}"
            # remove only decoration handlers that try to use GPU in background mode
            if "bonsai" in low and "drawing" in low and ("decoration" in low or "handler" in low):
                try:
                    hp.remove(h); removed += 1
                except:
                    pass
    except Exception as e:
        log(f"handler removal failed: {e}")
    log(f"Removed load_post GPU drawing handlers: {removed}")

def disable_noisy_addons():
    # optional, but helps avoid random background errors from other addons
    try:
        import addon_utils
        for mod in addon_utils.modules():
            name = getattr(mod, "__name__", "")
            low = name.lower()
            if "engon" in low or "polygoniq" in low:
                try:
                    addon_utils.disable(name, default_set=False, handle_error=True)
                    log(f"Disabled addon: {name}")
                except:
                    pass
    except:
        pass

def ifcstore_has_file():
    try:
        from bonsai.bim.ifc import IfcStore
    except Exception:
        from blenderbim.bim.ifc import IfcStore

    if hasattr(IfcStore, "get_file"):
        return IfcStore.get_file() is not None
    if hasattr(IfcStore, "get"):
        return IfcStore.get() is not None
    return getattr(IfcStore, "file", None) is not None

def try_reload_ifc_only_if_needed(ifc_path):
    # IMPORTANT: only do this if IfcStore is empty.
    # If your template.blend already has a loaded Bonsai project, do NOT reload.
    if ifcstore_has_file():
        log("IfcStore already loaded (skipping reload_ifc_file).")
        return True

    if not os.path.exists(ifc_path):
        log(f"IFC does not exist, cannot reload: {ifc_path}")
        return False

    if not (hasattr(bpy.ops, "bim") and hasattr(bpy.ops.bim, "reload_ifc_file")):
        log("bpy.ops.bim.reload_ifc_file not found")
        return False

    try:
        res = bpy.ops.bim.reload_ifc_file(filepath=os.path.abspath(ifc_path))
        ok = isinstance(res, set) and "FINISHED" in res
        log(f"reload_ifc_file -> {ok}")
        return ok
    except Exception as e:
        log(f"reload_ifc_file failed: {e}")
        return False

def execute_script(script_path):
    script_path = os.path.abspath(script_path)
    log(f"Executing: {script_path}")
    g = {"__file__": script_path, "__name__": "__main__"}
    with open(script_path, "r", encoding="utf-8") as f:
        code = f.read()
    exec(compile(code, script_path, "exec"), g, g)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blend", required=True)
    ap.add_argument("--ifc", required=False)   # optional now
    ap.add_argument("--script", required=True)
    args = ap.parse_args(sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else [])

    remove_gpu_drawing_handlers()
    disable_noisy_addons()

    blend_path = os.path.abspath(args.blend)
    log(f"Opening blend: {blend_path}")
    bpy.ops.wm.open_mainfile(filepath=blend_path)

    # only reload IFC if the blend did NOT already have a Bonsai project loaded
    if args.ifc:
        try_reload_ifc_only_if_needed(os.path.abspath(args.ifc))

    time.sleep(0.2)
    execute_script(args.script)

if __name__ == "__main__":
    main()
