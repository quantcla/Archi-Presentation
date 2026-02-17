import * as THREE from 'three';
import * as WebIFC from 'web-ifc';
import { IFCANNOTATION } from 'web-ifc';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

export interface FloorModel {
  id: string;
  name: string;
  file: File;
  mesh: THREE.Group;
  edges: THREE.Group;
  elevation: number;
  offset: { x: number; z: number };
  rotation: number;
  visible: boolean;
  modelID: number;
}

export class FloorManager {
  floors: FloorModel[] = [];
  private ifcApi: WebIFC.IfcAPI | null = null;
  scene: THREE.Scene;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private edgesVisible = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.initPromise = this.initialize();
  }

  private async initialize() {
    try {
      const wasmPath = typeof window !== 'undefined'
        ? `${window.location.origin}/wasm/`
        : '/wasm/';

      console.log(`Initializing FloorManager. WASM Path: ${wasmPath}`);

      // Create the IfcAPI instance
      this.ifcApi = new WebIFC.IfcAPI();

      // Set the WASM path with absolute = true
      this.ifcApi.SetWasmPath(wasmPath, true);
      console.log('SetWasmPath called with absolute=true');

      // Initialize the API - this is when it actually loads the WASM
      await this.ifcApi.Init();
      console.log('IfcAPI initialized successfully');

      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize IfcAPI:', error);
      throw error;
    }
  }

  private async ensureInitialized() {
    if (!this.initialized && this.initPromise) {
      await this.initPromise;
    }
    if (!this.ifcApi) {
      throw new Error('IfcAPI not initialized');
    }
  }

  async addFloor(file: File, name: string) {
    await this.ensureInitialized();

    try {
      console.log(`Attempting to load IFC file: ${name}`);

      // Read file as ArrayBuffer
      const arrayBuffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      // Open the model with web-ifc
      const modelID = this.ifcApi!.OpenModel(uint8Array);
      console.log(`Model opened with ID: ${modelID}`);

      // Create Three.js geometry from the IFC model
      const group = this.createThreeGeometry(modelID);
      this.scene.add(group);

      // Create edge lines for the model
      const edgesGroup = this.createEdgeGeometry(group);
      edgesGroup.visible = this.edgesVisible;
      this.scene.add(edgesGroup);

      const currentMaxY = this.floors.reduce((acc, f) => acc + 3, 0);

      const newFloor: FloorModel = {
        id: crypto.randomUUID(),
        name,
        file,
        mesh: group,
        edges: edgesGroup,
        elevation: currentMaxY,
        offset: { x: 0, z: 0 },
        rotation: 0,
        visible: true,
        modelID
      };

      this.updateTransform(newFloor);
      this.floors.push(newFloor);

      console.log("IFC Geometry loaded successfully.");
      return newFloor;

    } catch (error) {
      console.error("IFC LOADING FAILED:", error);
      alert(
        "Failed to load 3D Model.\n\n" +
        "Error: " + (error as Error).message + "\n\n" +
        "Check browser console (F12) for details."
      );
      throw error;
    }
  }

  private createThreeGeometry(modelID: number): THREE.Group {
    const group = new THREE.Group();

    if (!this.ifcApi) return group;

    let meshCount = 0;
    let skippedAnnotations = 0;

    // Build a set of express IDs that belong to IfcAnnotation entities
    // so we can skip their geometry
    const annotationExpressIds = new Set<number>();
    try {
      const annotationIds = this.ifcApi.GetLineIDsWithType(modelID, IFCANNOTATION);
      for (let i = 0; i < annotationIds.size(); i++) {
        annotationExpressIds.add(annotationIds.get(i));
      }
      if (annotationExpressIds.size > 0) {
        console.log(`Found ${annotationExpressIds.size} IfcAnnotation entities to skip`);
      }
    } catch (e) {
      console.warn('Could not get IfcAnnotation IDs:', e);
    }

    // Get all mesh data from the IFC file
    this.ifcApi.StreamAllMeshes(modelID, (mesh) => {
      // Skip meshes that belong to IfcAnnotation entities
      if (annotationExpressIds.has(mesh.expressID)) {
        skippedAnnotations++;
        return;
      }

      const placedGeometries = mesh.geometries;

      for (let i = 0; i < placedGeometries.size(); i++) {
        const placedGeometry = placedGeometries.get(i);

        try {
          const geometry = this.ifcApi!.GetGeometry(modelID, placedGeometry.geometryExpressID);

          const vertexData = geometry.GetVertexData();
          const vertexDataSize = geometry.GetVertexDataSize();
          const indexData = geometry.GetIndexData();
          const indexDataSize = geometry.GetIndexDataSize();

          if (vertexDataSize === 0 || indexDataSize === 0) {
            geometry.delete();
            continue;
          }

          const vertices = this.ifcApi!.GetVertexArray(vertexData, vertexDataSize);
          const indices = this.ifcApi!.GetIndexArray(indexData, indexDataSize);

          // Create Three.js BufferGeometry
          const bufferGeometry = new THREE.BufferGeometry();

          // IFC vertices are packed as: x, y, z, nx, ny, nz (6 floats per vertex)
          const numVertices = vertices.length / 6;
          const positionArray = new Float32Array(numVertices * 3);
          const normalArray = new Float32Array(numVertices * 3);

          for (let j = 0; j < numVertices; j++) {
            const srcIdx = j * 6;
            const dstIdx = j * 3;
            positionArray[dstIdx] = vertices[srcIdx];
            positionArray[dstIdx + 1] = vertices[srcIdx + 1];
            positionArray[dstIdx + 2] = vertices[srcIdx + 2];
            normalArray[dstIdx] = vertices[srcIdx + 3];
            normalArray[dstIdx + 1] = vertices[srcIdx + 4];
            normalArray[dstIdx + 2] = vertices[srcIdx + 5];
          }

          bufferGeometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
          bufferGeometry.setAttribute('normal', new THREE.BufferAttribute(normalArray, 3));
          bufferGeometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));

          // Create material with the color from IFC
          const color = placedGeometry.color;
          const material = new THREE.MeshPhongMaterial({
            color: new THREE.Color(color.x, color.y, color.z),
            opacity: color.w,
            transparent: color.w < 1,
            side: THREE.DoubleSide
          });

          const threeMesh = new THREE.Mesh(bufferGeometry, material);

          // Apply the transformation matrix
          const matrix = new THREE.Matrix4();
          matrix.fromArray(placedGeometry.flatTransformation);
          threeMesh.applyMatrix4(matrix);

          group.add(threeMesh);
          meshCount++;

          // Clean up
          geometry.delete();
        } catch (e) {
          console.warn('Failed to process geometry:', e);
        }
      }
    });

    console.log(`Created ${meshCount} meshes from IFC (skipped ${skippedAnnotations} annotation meshes)`);

    // Compute bounding box for debugging
    const box = new THREE.Box3().setFromObject(group);
    console.log('Model bounding box:', box.min, box.max);

    return group;
  }

  private createEdgeGeometry(group: THREE.Group): THREE.Group {
    const edgesGroup = new THREE.Group();

    group.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        try {
          const edges = new THREE.EdgesGeometry(child.geometry, 15); // 15 degree threshold
          // Create material that supports clipping
          const edgeMaterial = new THREE.LineBasicMaterial({
            color: 0x000000,
            linewidth: 1,
            clippingPlanes: [], // Will be set by setEdgeClipping
          });
          const line = new THREE.LineSegments(edges, edgeMaterial);
          line.name = 'edgeLine';

          // Copy the mesh's world matrix to position edges correctly
          child.updateWorldMatrix(true, false);
          line.applyMatrix4(child.matrixWorld);

          edgesGroup.add(line);
        } catch (e) {
          console.warn('Failed to create edges for mesh:', e);
        }
      }
    });

    return edgesGroup;
  }

  setEdgeClipping(clippingPlane: THREE.Plane | null) {
    this.floors.forEach(floor => {
      if (floor.edges) {
        floor.edges.traverse((child) => {
          if (child instanceof THREE.LineSegments && child.material) {
            const mat = child.material as THREE.LineBasicMaterial;
            mat.clippingPlanes = clippingPlane ? [clippingPlane] : [];
          }
        });
      }
    });
  }

  setEdgesVisible(visible: boolean) {
    this.edgesVisible = visible;
    this.floors.forEach(floor => {
      if (floor.edges) {
        floor.edges.visible = visible && floor.visible;
      }
    });
  }

  getEdgesVisible(): boolean {
    return this.edgesVisible;
  }

  updateTransform(floor: FloorModel) {
    if (!floor.mesh) return;
    floor.mesh.position.set(floor.offset.x, floor.elevation, floor.offset.z);
    floor.mesh.rotation.y = floor.rotation;
    floor.mesh.visible = floor.visible;

    // Update edges transform too
    if (floor.edges) {
      floor.edges.position.set(floor.offset.x, floor.elevation, floor.offset.z);
      floor.edges.rotation.y = floor.rotation;
      floor.edges.visible = this.edgesVisible && floor.visible;
    }
  }

  snapFloor(activeId: string) {
    const active = this.floors.find(f => f.id === activeId);
    if(!active) return;

    active.offset.x = Math.round(active.offset.x * 2) / 2;
    active.offset.z = Math.round(active.offset.z * 2) / 2;
    active.elevation = Math.round(active.elevation * 10) / 10;

    this.updateTransform(active);
  }

  getBoundingBox(): THREE.Box3 {
    const box = new THREE.Box3();
    this.floors.forEach(floor => {
      if (floor.mesh && floor.visible) {
        const floorBox = new THREE.Box3().setFromObject(floor.mesh);
        box.union(floorBox);
      }
    });
    return box;
  }

  dispose() {
    if (this.ifcApi) {
      // Close all models
      this.floors.forEach((floor) => {
        try {
          this.ifcApi!.CloseModel(floor.modelID);
        } catch (e) {
          // Model might already be closed
        }
      });
    }
  }

  /**
   * Export all visible floors as a single GLB file
   */
  async exportAsGLB(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      // Create a temporary group with all visible floor meshes
      const exportGroup = new THREE.Group();
      exportGroup.name = 'BuildingExport';

      this.floors.forEach((floor) => {
        if (floor.visible && floor.mesh) {
          // Clone the mesh group to avoid modifying the original
          const clonedGroup = floor.mesh.clone(true);
          // Apply the current transform to the clone
          clonedGroup.position.set(floor.offset.x, floor.elevation, floor.offset.z);
          clonedGroup.rotation.y = floor.rotation;
          exportGroup.add(clonedGroup);
        }
      });

      const exporter = new GLTFExporter();
      exporter.parse(
        exportGroup,
        (result) => {
          if (result instanceof ArrayBuffer) {
            resolve(new Blob([result], { type: 'model/gltf-binary' }));
          } else {
            // JSON result - convert to blob
            const jsonStr = JSON.stringify(result);
            resolve(new Blob([jsonStr], { type: 'model/gltf+json' }));
          }
        },
        (error) => {
          reject(error);
        },
        { binary: true } // Export as GLB (binary)
      );
    });
  }

  /**
   * Get a clone of all floor meshes for use in the Simulation tab
   */
  getStackedBuildingClone(): THREE.Group {
    const buildingGroup = new THREE.Group();
    buildingGroup.name = 'StackedBuilding';

    this.floors.forEach((floor) => {
      if (floor.visible && floor.mesh) {
        const clonedGroup = floor.mesh.clone(true);
        clonedGroup.position.set(floor.offset.x, floor.elevation, floor.offset.z);
        clonedGroup.rotation.y = floor.rotation;
        clonedGroup.name = `Floor_${floor.name}`;
        buildingGroup.add(clonedGroup);
      }
    });

    return buildingGroup;
  }

  /**
   * Get serializable floor data for passing between tabs
   */
  getFloorData(): Array<{
    name: string;
    elevation: number;
    offset: { x: number; z: number };
    rotation: number;
    visible: boolean;
  }> {
    return this.floors.map(floor => ({
      name: floor.name,
      elevation: floor.elevation,
      offset: { ...floor.offset },
      rotation: floor.rotation,
      visible: floor.visible
    }));
  }
}
