import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

export interface PlacedObject {
  id: string;
  name: string;
  mesh: THREE.Group;
  position: THREE.Vector3;
  rotation: THREE.Euler;
  scale: THREE.Vector3;
  visible: boolean;
  fileType: string;
}

export class ObjectManager {
  private scene: THREE.Scene;
  private camera: THREE.Camera | null = null;
  private objects: PlacedObject[] = [];
  private selectedId: string | null = null;

  // Transform gizmo
  private gizmo: THREE.Group | null = null;
  private activeAxis: 'x' | 'y' | 'z' | null = null;
  private dragStart: THREE.Vector3 | null = null;
  private objectStartPosition: THREE.Vector3 | null = null;

  // Gizmo arrows
  private xArrow: THREE.Group | null = null;
  private yArrow: THREE.Group | null = null;
  private zArrow: THREE.Group | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.createGizmo();
  }

  setCamera(camera: THREE.Camera) {
    this.camera = camera;
  }

  private createGizmo() {
    this.gizmo = new THREE.Group();
    this.gizmo.name = 'objectGizmo';
    this.gizmo.visible = false;

    const arrowLength = 1.0;
    const arrowHeadLength = 0.2;
    const arrowHeadWidth = 0.1;
    const cylinderRadius = 0.03;

    // X Axis (Red)
    this.xArrow = this.createAxisArrow(0xff0000, 'x', arrowLength, arrowHeadLength, arrowHeadWidth, cylinderRadius);
    this.xArrow.rotation.z = -Math.PI / 2;
    this.gizmo.add(this.xArrow);

    // Y Axis (Green)
    this.yArrow = this.createAxisArrow(0x00ff00, 'y', arrowLength, arrowHeadLength, arrowHeadWidth, cylinderRadius);
    this.gizmo.add(this.yArrow);

    // Z Axis (Blue)
    this.zArrow = this.createAxisArrow(0x0088ff, 'z', arrowLength, arrowHeadLength, arrowHeadWidth, cylinderRadius);
    this.zArrow.rotation.x = Math.PI / 2;
    this.gizmo.add(this.zArrow);

    // Center sphere
    const centerGeom = new THREE.SphereGeometry(0.08, 16, 16);
    const centerMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const center = new THREE.Mesh(centerGeom, centerMat);
    center.name = 'gizmoCenter';
    this.gizmo.add(center);

    this.scene.add(this.gizmo);
  }

  private createAxisArrow(color: number, axis: string, length: number, headLength: number, headWidth: number, cylinderRadius: number): THREE.Group {
    const group = new THREE.Group();
    group.name = `gizmoArrow_${axis}`;

    // Cylinder shaft
    const shaftGeom = new THREE.CylinderGeometry(cylinderRadius, cylinderRadius, length - headLength, 12);
    const shaftMat = new THREE.MeshBasicMaterial({ color });
    const shaft = new THREE.Mesh(shaftGeom, shaftMat);
    shaft.position.y = (length - headLength) / 2;
    shaft.name = `gizmoShaft_${axis}`;
    group.add(shaft);

    // Cone head
    const headGeom = new THREE.ConeGeometry(headWidth, headLength, 12);
    const headMat = new THREE.MeshBasicMaterial({ color });
    const head = new THREE.Mesh(headGeom, headMat);
    head.position.y = length - headLength / 2;
    head.name = `gizmoHead_${axis}`;
    group.add(head);

    // Invisible hitbox for easier clicking
    const hitboxGeom = new THREE.CylinderGeometry(0.1, 0.1, length, 8);
    const hitboxMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
    const hitbox = new THREE.Mesh(hitboxGeom, hitboxMat);
    hitbox.position.y = length / 2;
    hitbox.name = `gizmoHitbox_${axis}`;
    group.add(hitbox);

    return group;
  }

  // Load and add object from file
  async addObject(file: File, initialPosition?: THREE.Vector3): Promise<PlacedObject | null> {
    const fileName = file.name.toLowerCase();
    const fileExt = fileName.split('.').pop() || '';

    let mesh: THREE.Group | null = null;

    try {
      if (fileExt === 'gltf' || fileExt === 'glb') {
        mesh = await this.loadGLTF(file);
      } else if (fileExt === 'obj') {
        mesh = await this.loadOBJ(file);
      } else if (fileExt === 'fbx') {
        mesh = await this.loadFBX(file);
      } else {
        console.warn(`Unsupported file format: ${fileExt}`);
        return null;
      }

      if (!mesh) return null;

      const id = crypto.randomUUID();
      const position = initialPosition?.clone() || new THREE.Vector3(0, 0, 0);

      mesh.name = `placedObject_${id}`;
      mesh.position.copy(position);

      const placedObject: PlacedObject = {
        id,
        name: file.name.replace(/\.[^/.]+$/, ''),
        mesh,
        position: mesh.position,
        rotation: mesh.rotation,
        scale: mesh.scale,
        visible: true,
        fileType: fileExt
      };

      this.objects.push(placedObject);
      this.scene.add(mesh);

      // Auto-select the new object
      this.selectObject(id);

      return placedObject;
    } catch (error) {
      console.error('Error loading object:', error);
      return null;
    }
  }

  private loadGLTF(file: File): Promise<THREE.Group> {
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      const url = URL.createObjectURL(file);

      loader.load(
        url,
        (gltf) => {
          URL.revokeObjectURL(url);
          const group = new THREE.Group();
          group.add(gltf.scene);
          resolve(group);
        },
        undefined,
        (error) => {
          URL.revokeObjectURL(url);
          reject(error);
        }
      );
    });
  }

  private loadOBJ(file: File): Promise<THREE.Group> {
    return new Promise((resolve, reject) => {
      const loader = new OBJLoader();
      const reader = new FileReader();

      reader.onload = (e) => {
        try {
          const text = e.target?.result as string;
          const obj = loader.parse(text);
          const group = new THREE.Group();
          group.add(obj);
          resolve(group);
        } catch (error) {
          reject(error);
        }
      };

      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  private loadFBX(file: File): Promise<THREE.Group> {
    return new Promise((resolve, reject) => {
      const loader = new FBXLoader();
      const url = URL.createObjectURL(file);

      loader.load(
        url,
        (fbx) => {
          URL.revokeObjectURL(url);
          const group = new THREE.Group();
          group.add(fbx);
          resolve(group);
        },
        undefined,
        (error) => {
          URL.revokeObjectURL(url);
          reject(error);
        }
      );
    });
  }

  // Select an object
  selectObject(id: string | null) {
    // Reset previous selection highlight
    if (this.selectedId) {
      const prev = this.objects.find(o => o.id === this.selectedId);
      if (prev) {
        this.setObjectHighlight(prev.mesh, false);
      }
    }

    this.selectedId = id;

    if (id) {
      const selected = this.objects.find(o => o.id === id);
      if (selected && this.gizmo) {
        this.setObjectHighlight(selected.mesh, true);
        this.gizmo.visible = true;
        this.gizmo.position.copy(selected.mesh.position);
      }
    } else {
      if (this.gizmo) {
        this.gizmo.visible = false;
      }
    }
  }

  private setObjectHighlight(mesh: THREE.Group, highlight: boolean) {
    mesh.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.material) {
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach((mat) => {
          // Only MeshStandardMaterial and MeshPhongMaterial have emissive property
          if (mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshPhongMaterial) {
            if (highlight) {
              mat.emissive = new THREE.Color(0x444444);
            } else {
              mat.emissive = new THREE.Color(0x000000);
            }
          }
        });
      }
    });
  }

  // Find object at screen position
  findObjectAtPoint(raycaster: THREE.Raycaster): PlacedObject | null {
    for (const obj of this.objects) {
      if (!obj.visible) continue;
      const hits = raycaster.intersectObject(obj.mesh, true);
      if (hits.length > 0) {
        return obj;
      }
    }
    return null;
  }

  // Check if gizmo axis was clicked
  checkGizmoHit(raycaster: THREE.Raycaster): 'x' | 'y' | 'z' | null {
    if (!this.gizmo || !this.gizmo.visible) return null;

    const hits = raycaster.intersectObject(this.gizmo, true);
    if (hits.length === 0) return null;

    const hitName = hits[0].object.name;
    if (hitName.includes('_x')) return 'x';
    if (hitName.includes('_y')) return 'y';
    if (hitName.includes('_z')) return 'z';

    return null;
  }

  // Start dragging on an axis
  startDrag(axis: 'x' | 'y' | 'z', mousePosition: THREE.Vector3) {
    this.activeAxis = axis;
    this.dragStart = mousePosition.clone();

    const selected = this.getSelectedObject();
    if (selected) {
      this.objectStartPosition = selected.mesh.position.clone();
    }

    // Highlight the active axis
    this.highlightAxis(axis, true);
  }

  // Update drag
  updateDrag(currentMousePosition: THREE.Vector3) {
    if (!this.activeAxis || !this.dragStart || !this.objectStartPosition) return;

    const selected = this.getSelectedObject();
    if (!selected) return;

    const delta = new THREE.Vector3().subVectors(currentMousePosition, this.dragStart);

    // Apply movement only along the active axis
    const newPosition = this.objectStartPosition.clone();
    if (this.activeAxis === 'x') {
      newPosition.x += delta.x;
    } else if (this.activeAxis === 'y') {
      newPosition.y += delta.y;
    } else if (this.activeAxis === 'z') {
      newPosition.z += delta.z;
    }

    selected.mesh.position.copy(newPosition);
    selected.position.copy(newPosition);

    // Update gizmo position
    if (this.gizmo) {
      this.gizmo.position.copy(newPosition);
    }
  }

  // End drag
  endDrag() {
    if (this.activeAxis) {
      this.highlightAxis(this.activeAxis, false);
    }
    this.activeAxis = null;
    this.dragStart = null;
    this.objectStartPosition = null;
  }

  private highlightAxis(axis: 'x' | 'y' | 'z', highlight: boolean) {
    let arrow: THREE.Group | null = null;
    if (axis === 'x') arrow = this.xArrow;
    else if (axis === 'y') arrow = this.yArrow;
    else if (axis === 'z') arrow = this.zArrow;

    if (!arrow) return;

    const color = highlight ? 0xffff00 : (axis === 'x' ? 0xff0000 : axis === 'y' ? 0x00ff00 : 0x0088ff);
    arrow.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshBasicMaterial) {
        if (!obj.name.includes('Hitbox')) {
          obj.material.color.setHex(color);
        }
      }
    });
  }

  // Check if dragging
  isDragging(): boolean {
    return this.activeAxis !== null;
  }

  // Get selected object
  getSelectedObject(): PlacedObject | null {
    return this.objects.find(o => o.id === this.selectedId) || null;
  }

  getSelectedId(): string | null {
    return this.selectedId;
  }

  // Get all objects
  getObjects(): PlacedObject[] {
    return this.objects;
  }

  // Update object properties
  updateObject(id: string, updates: Partial<{ position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3; visible: boolean; name: string }>) {
    const obj = this.objects.find(o => o.id === id);
    if (!obj) return;

    if (updates.position) {
      obj.mesh.position.copy(updates.position);
      obj.position.copy(updates.position);
      if (this.selectedId === id && this.gizmo) {
        this.gizmo.position.copy(updates.position);
      }
    }

    if (updates.rotation) {
      obj.mesh.rotation.copy(updates.rotation);
      obj.rotation.copy(updates.rotation);
    }

    if (updates.scale) {
      obj.mesh.scale.copy(updates.scale);
      obj.scale.copy(updates.scale);
    }

    if (updates.visible !== undefined) {
      obj.mesh.visible = updates.visible;
      obj.visible = updates.visible;
      if (!updates.visible && this.selectedId === id) {
        this.selectObject(null);
      }
    }

    if (updates.name !== undefined) {
      obj.name = updates.name;
    }
  }

  // Delete object
  deleteObject(id: string) {
    const index = this.objects.findIndex(o => o.id === id);
    if (index < 0) return;

    const obj = this.objects[index];
    this.scene.remove(obj.mesh);

    // Dispose geometry and materials
    obj.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        if (child.material) {
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.forEach(m => m.dispose());
        }
      }
    });

    this.objects.splice(index, 1);

    if (this.selectedId === id) {
      this.selectObject(null);
    }
  }

  // Duplicate object
  duplicateObject(id: string): PlacedObject | null {
    const original = this.objects.find(o => o.id === id);
    if (!original) return null;

    const newId = crypto.randomUUID();
    const clonedMesh = original.mesh.clone();
    clonedMesh.name = `placedObject_${newId}`;

    // Offset position slightly
    clonedMesh.position.x += 0.5;
    clonedMesh.position.z += 0.5;

    const newObject: PlacedObject = {
      id: newId,
      name: `${original.name} (copy)`,
      mesh: clonedMesh,
      position: clonedMesh.position,
      rotation: clonedMesh.rotation,
      scale: clonedMesh.scale,
      visible: true,
      fileType: original.fileType
    };

    this.objects.push(newObject);
    this.scene.add(clonedMesh);
    this.selectObject(newId);

    return newObject;
  }

  // Update gizmo visibility based on selection
  updateGizmo() {
    if (!this.gizmo) return;

    const selected = this.getSelectedObject();
    if (selected) {
      this.gizmo.visible = true;
      this.gizmo.position.copy(selected.mesh.position);
    } else {
      this.gizmo.visible = false;
    }
  }

  // Get world position from mouse for drag calculations
  getWorldPositionOnPlane(raycaster: THREE.Raycaster, planeNormal: THREE.Vector3, planePoint: THREE.Vector3): THREE.Vector3 | null {
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, planePoint);
    const intersection = new THREE.Vector3();

    if (raycaster.ray.intersectPlane(plane, intersection)) {
      return intersection;
    }
    return null;
  }

  dispose() {
    for (const obj of this.objects) {
      this.scene.remove(obj.mesh);
      obj.mesh.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry?.dispose();
        }
      });
    }
    this.objects = [];

    if (this.gizmo) {
      this.scene.remove(this.gizmo);
      this.gizmo = null;
    }
  }
}
