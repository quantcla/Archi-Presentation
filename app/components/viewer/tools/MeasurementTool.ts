import * as THREE from 'three';

export interface MeasurementPoint {
  position: THREE.Vector3;
  snappedTo: 'corner' | 'edge' | 'free';
  edgeInfo?: { start: THREE.Vector3; end: THREE.Vector3 };
}

export interface LineMeasurement {
  id: string;
  type: 'line';
  start: MeasurementPoint;
  end: MeasurementPoint;
  distance: number;
  visible: boolean;
  mesh: THREE.Group;
}

export interface PolygonMeasurement {
  id: string;
  type: 'polygon';
  points: MeasurementPoint[];
  area: number;
  visible: boolean;
  mesh: THREE.Group;
  closed: boolean;
}

export type Measurement = LineMeasurement | PolygonMeasurement;

interface SnapResult {
  point: THREE.Vector3;
  type: 'corner' | 'edge' | 'free';
  edgeInfo?: { start: THREE.Vector3; end: THREE.Vector3 };
}

// Selected point info for gizmo
export interface SelectedPointInfo {
  measurementId: string;
  pointIndex: number; // 0=start, 1=end for line; 0..n for polygon
  position: THREE.Vector3;
}

export class MeasurementManager {
  private scene: THREE.Scene;
  private camera: THREE.Camera | null = null;
  private measurements: Measurement[] = [];
  private selectedId: string | null = null;
  private snapThreshold = 0.5; // meters - increased for better snapping
  private cornerVertices: THREE.Vector3[] = [];
  private edges: Array<{ start: THREE.Vector3; end: THREE.Vector3 }> = [];
  private sectionCutY: number | null = null; // When set, filter snap points above this Y

  // Preview elements
  private cursorIndicator: THREE.Group | null = null;
  private previewLine: THREE.Group | null = null;
  private pendingPointsGroup: THREE.Group | null = null;

  // Point gizmo for moving individual points
  private pointGizmo: THREE.Group | null = null;
  private selectedPoint: SelectedPointInfo | null = null;
  private activeGizmoAxis: 'x' | 'y' | 'z' | null = null;
  private gizmoDragStart: THREE.Vector3 | null = null;
  private gizmoPointStart: THREE.Vector3 | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.createCursorIndicator();
    this.createPointGizmo();
  }

  setCamera(camera: THREE.Camera) {
    this.camera = camera;
  }

  setSectionCutY(y: number | null) {
    this.sectionCutY = y;
  }

  // Create the red cursor indicator (like the drawer's red dot)
  private createCursorIndicator() {
    this.cursorIndicator = new THREE.Group();
    this.cursorIndicator.name = 'measurementCursor';

    // Outer ring
    const ringGeometry = new THREE.RingGeometry(0.06, 0.08, 32);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2; // Make horizontal
    this.cursorIndicator.add(ring);

    // Inner dot
    const dotGeometry = new THREE.SphereGeometry(0.04, 16, 16);
    const dotMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const dot = new THREE.Mesh(dotGeometry, dotMaterial);
    this.cursorIndicator.add(dot);

    this.cursorIndicator.visible = false;
    this.scene.add(this.cursorIndicator);
  }

  // Update cursor position (call this on mouse move)
  updateCursorPosition(position: THREE.Vector3 | null, snapType: 'corner' | 'edge' | 'free' = 'free') {
    if (!this.cursorIndicator) return;

    if (!position) {
      this.cursorIndicator.visible = false;
      return;
    }

    this.cursorIndicator.visible = true;
    this.cursorIndicator.position.copy(position);

    // Change color based on snap type
    const color = snapType === 'corner' ? 0x00ff00 : snapType === 'edge' ? 0xffff00 : 0xff0000;
    this.cursorIndicator.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.material) {
        (obj.material as THREE.MeshBasicMaterial).color.setHex(color);
      }
    });
  }

  // Show/hide cursor
  setCursorVisible(visible: boolean) {
    if (this.cursorIndicator) {
      this.cursorIndicator.visible = visible;
    }
  }

  // Create point gizmo for moving individual measurement points
  private createPointGizmo() {
    this.pointGizmo = new THREE.Group();
    this.pointGizmo.name = 'measurementPointGizmo';
    this.pointGizmo.visible = false;

    const arrowLength = 0.5;
    const arrowHeadLength = 0.1;
    const cylinderRadius = 0.02;

    // X Axis (Red)
    const xArrow = this.createGizmoArrow(0xff0000, 'x', arrowLength, arrowHeadLength, cylinderRadius);
    xArrow.rotation.z = -Math.PI / 2;
    this.pointGizmo.add(xArrow);

    // Y Axis (Green)
    const yArrow = this.createGizmoArrow(0x00ff00, 'y', arrowLength, arrowHeadLength, cylinderRadius);
    this.pointGizmo.add(yArrow);

    // Z Axis (Blue)
    const zArrow = this.createGizmoArrow(0x0088ff, 'z', arrowLength, arrowHeadLength, cylinderRadius);
    zArrow.rotation.x = Math.PI / 2;
    this.pointGizmo.add(zArrow);

    // Center sphere
    const centerGeom = new THREE.SphereGeometry(0.04, 16, 16);
    const centerMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const center = new THREE.Mesh(centerGeom, centerMat);
    center.name = 'gizmoCenter';
    this.pointGizmo.add(center);

    this.scene.add(this.pointGizmo);
  }

  private createGizmoArrow(color: number, axis: string, length: number, headLength: number, cylinderRadius: number): THREE.Group {
    const group = new THREE.Group();
    group.name = `measureGizmoArrow_${axis}`;

    // Cylinder shaft
    const shaftGeom = new THREE.CylinderGeometry(cylinderRadius, cylinderRadius, length - headLength, 12);
    const shaftMat = new THREE.MeshBasicMaterial({ color });
    const shaft = new THREE.Mesh(shaftGeom, shaftMat);
    shaft.position.y = (length - headLength) / 2;
    shaft.name = `measureGizmoShaft_${axis}`;
    group.add(shaft);

    // Cone head
    const headGeom = new THREE.ConeGeometry(0.05, headLength, 12);
    const headMat = new THREE.MeshBasicMaterial({ color });
    const head = new THREE.Mesh(headGeom, headMat);
    head.position.y = length - headLength / 2;
    head.name = `measureGizmoHead_${axis}`;
    group.add(head);

    return group;
  }

  // Update preview line from pending point to cursor
  updatePreviewLine(startPoint: THREE.Vector3 | null, endPoint: THREE.Vector3 | null) {
    // Remove existing preview
    if (this.previewLine) {
      this.scene.remove(this.previewLine);
      this.previewLine.traverse((obj) => {
        if (obj instanceof THREE.Line || obj instanceof THREE.Mesh) {
          obj.geometry?.dispose();
        }
      });
      this.previewLine = null;
    }

    if (!startPoint || !endPoint) return;

    this.previewLine = new THREE.Group();
    this.previewLine.name = 'measurementPreview';

    // Dashed line
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([startPoint, endPoint]);
    const lineMaterial = new THREE.LineDashedMaterial({
      color: 0x00ff00,
      dashSize: 0.1,
      gapSize: 0.05,
      linewidth: 2
    });
    const line = new THREE.Line(lineGeometry, lineMaterial);
    line.computeLineDistances();
    this.previewLine.add(line);

    // Distance label
    const distance = startPoint.distanceTo(endPoint);
    const midpoint = new THREE.Vector3().addVectors(startPoint, endPoint).multiplyScalar(0.5);
    const label = this.createTextSprite(`${distance.toFixed(2)}m`, 0x00ff00);
    label.position.copy(midpoint);
    label.position.y += 0.15;
    this.previewLine.add(label);

    this.scene.add(this.previewLine);
  }

  // Update pending points display (for polygon mode)
  updatePendingPoints(points: MeasurementPoint[], currentCursor: THREE.Vector3 | null) {
    // Remove existing
    if (this.pendingPointsGroup) {
      this.scene.remove(this.pendingPointsGroup);
      this.pendingPointsGroup.traverse((obj) => {
        if (obj instanceof THREE.Line || obj instanceof THREE.Mesh) {
          obj.geometry?.dispose();
        }
      });
      this.pendingPointsGroup = null;
    }

    if (points.length === 0) return;

    this.pendingPointsGroup = new THREE.Group();
    this.pendingPointsGroup.name = 'pendingPolygonPoints';

    const sphereGeometry = new THREE.SphereGeometry(0.05, 16, 16);
    const sphereMaterial = new THREE.MeshBasicMaterial({ color: 0x0088ff });
    const lineMaterial = new THREE.LineDashedMaterial({
      color: 0x0088ff,
      dashSize: 0.1,
      gapSize: 0.05
    });

    // Draw points and lines between them
    for (let i = 0; i < points.length; i++) {
      const pos = points[i].position;

      // Point sphere
      const sphere = new THREE.Mesh(sphereGeometry.clone(), sphereMaterial.clone());
      sphere.position.copy(pos);
      this.pendingPointsGroup.add(sphere);

      // Line to next point
      if (i < points.length - 1) {
        const nextPos = points[i + 1].position;
        const lineGeom = new THREE.BufferGeometry().setFromPoints([pos, nextPos]);
        const line = new THREE.Line(lineGeom, lineMaterial.clone());
        line.computeLineDistances();
        this.pendingPointsGroup.add(line);
      }
    }

    // Line from last point to cursor
    if (currentCursor && points.length > 0) {
      const lastPoint = points[points.length - 1].position;
      const lineGeom = new THREE.BufferGeometry().setFromPoints([lastPoint, currentCursor]);
      const line = new THREE.Line(lineGeom, lineMaterial.clone());
      line.computeLineDistances();
      this.pendingPointsGroup.add(line);

      // Closing line preview (from cursor to first point) when we have 3+ points
      if (points.length >= 2) {
        const firstPoint = points[0].position;
        const closingLineGeom = new THREE.BufferGeometry().setFromPoints([currentCursor, firstPoint]);
        const closingLineMaterial = new THREE.LineDashedMaterial({
          color: 0x0088ff,
          dashSize: 0.05,
          gapSize: 0.05,
          transparent: true,
          opacity: 0.5
        });
        const closingLine = new THREE.Line(closingLineGeom, closingLineMaterial);
        closingLine.computeLineDistances();
        this.pendingPointsGroup.add(closingLine);
      }
    }

    this.scene.add(this.pendingPointsGroup);
  }

  // Clear all preview elements
  clearPreviews() {
    this.updatePreviewLine(null, null);
    this.updatePendingPoints([], null);
    this.setCursorVisible(false);
  }

  // Extract corners and edges from scene meshes
  updateGeometryCache() {
    this.cornerVertices = [];
    this.edges = [];

    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.geometry && obj.name !== 'sectionCapMesh') {
        if (obj.parent?.name === 'sectionCapGroup') return;
        if (obj.name === 'measurementHelper') return;
        if (obj.name === 'measurementPoint') return;
        if (obj.parent?.name === 'measurementLine') return;
        if (obj.parent?.name === 'measurementPolygon') return;
        if (obj.parent?.name === 'measurementPreview') return;
        if (obj.parent?.name === 'measurementCursor') return;
        if (obj.parent?.name === 'pendingPolygonPoints') return;
        // Skip grid helper
        if (obj.parent instanceof THREE.GridHelper) return;

        try {
          obj.updateWorldMatrix(true, false);
          const worldMatrix = obj.matrixWorld;
          const geometry = obj.geometry;
          const posAttr = geometry.getAttribute('position');
          const indexAttr = geometry.getIndex();

          if (!posAttr) return;

          // Collect unique vertices (corners)
          const vertexMap = new Map<string, THREE.Vector3>();

          for (let i = 0; i < posAttr.count; i++) {
            const v = new THREE.Vector3(
              posAttr.getX(i),
              posAttr.getY(i),
              posAttr.getZ(i)
            ).applyMatrix4(worldMatrix);

            const key = `${v.x.toFixed(3)}_${v.y.toFixed(3)}_${v.z.toFixed(3)}`;
            if (!vertexMap.has(key)) {
              vertexMap.set(key, v);
            }
          }

          this.cornerVertices.push(...vertexMap.values());

          // Collect edges
          if (indexAttr) {
            for (let i = 0; i < indexAttr.count; i += 3) {
              const i0 = indexAttr.getX(i);
              const i1 = indexAttr.getX(i + 1);
              const i2 = indexAttr.getX(i + 2);

              const v0 = new THREE.Vector3(posAttr.getX(i0), posAttr.getY(i0), posAttr.getZ(i0)).applyMatrix4(worldMatrix);
              const v1 = new THREE.Vector3(posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1)).applyMatrix4(worldMatrix);
              const v2 = new THREE.Vector3(posAttr.getX(i2), posAttr.getY(i2), posAttr.getZ(i2)).applyMatrix4(worldMatrix);

              this.edges.push({ start: v0.clone(), end: v1.clone() });
              this.edges.push({ start: v1.clone(), end: v2.clone() });
              this.edges.push({ start: v2.clone(), end: v0.clone() });
            }
          }
        } catch (e) {
          // Skip problematic meshes
        }
      }
    });

    console.log(`MeasurementManager: Cached ${this.cornerVertices.length} corners and ${this.edges.length} edges`);
  }

  // Find snap point near given position
  findSnapPoint(worldPoint: THREE.Vector3): SnapResult {
    const cutY = this.sectionCutY;
    let closestCorner: THREE.Vector3 | null = null;
    let closestCornerDist = this.snapThreshold;

    // Check corners first (higher priority)
    for (const corner of this.cornerVertices) {
      // Skip corners above section cut
      if (cutY !== null && corner.y > cutY + 0.01) continue;
      const dist = worldPoint.distanceTo(corner);
      if (dist < closestCornerDist) {
        closestCornerDist = dist;
        closestCorner = corner.clone();
      }
    }

    if (closestCorner) {
      return { point: closestCorner, type: 'corner' };
    }

    // Check edges
    let closestEdgePoint: THREE.Vector3 | null = null;
    let closestEdgeDist = this.snapThreshold;
    let closestEdgeInfo: { start: THREE.Vector3; end: THREE.Vector3 } | undefined;

    for (const edge of this.edges) {
      // Skip edges that are entirely above section cut
      if (cutY !== null && edge.start.y > cutY + 0.01 && edge.end.y > cutY + 0.01) continue;
      const projected = this.projectPointOnLineSegment(worldPoint, edge.start, edge.end);
      if (projected) {
        // Skip projected points above section cut
        if (cutY !== null && projected.y > cutY + 0.01) continue;
        const dist = worldPoint.distanceTo(projected);
        if (dist < closestEdgeDist) {
          closestEdgeDist = dist;
          closestEdgePoint = projected;
          closestEdgeInfo = { start: edge.start.clone(), end: edge.end.clone() };
        }
      }
    }

    if (closestEdgePoint) {
      return { point: closestEdgePoint, type: 'edge', edgeInfo: closestEdgeInfo };
    }

    return { point: worldPoint.clone(), type: 'free' };
  }

  private projectPointOnLineSegment(point: THREE.Vector3, lineStart: THREE.Vector3, lineEnd: THREE.Vector3): THREE.Vector3 | null {
    const line = new THREE.Vector3().subVectors(lineEnd, lineStart);
    const lineLength = line.length();
    if (lineLength < 0.001) return null;

    line.normalize();
    const pointToStart = new THREE.Vector3().subVectors(point, lineStart);
    const t = pointToStart.dot(line);

    if (t < 0 || t > lineLength) return null;

    return new THREE.Vector3().addVectors(lineStart, line.multiplyScalar(t));
  }

  // Create a line measurement
  createLineMeasurement(start: MeasurementPoint, end: MeasurementPoint): LineMeasurement {
    const id = crypto.randomUUID();
    const distance = start.position.distanceTo(end.position);
    const mesh = this.createLineMesh(start.position, end.position, distance);

    const measurement: LineMeasurement = {
      id,
      type: 'line',
      start,
      end,
      distance,
      visible: true,
      mesh
    };

    this.measurements.push(measurement);
    this.scene.add(mesh);

    return measurement;
  }

  // Create a polygon measurement
  createPolygonMeasurement(points: MeasurementPoint[]): PolygonMeasurement {
    const id = crypto.randomUUID();
    const area = this.calculatePolygonArea(points.map(p => p.position));
    const mesh = this.createPolygonMesh(points.map(p => p.position), area);

    const measurement: PolygonMeasurement = {
      id,
      type: 'polygon',
      points,
      area,
      visible: true,
      mesh,
      closed: true
    };

    this.measurements.push(measurement);
    this.scene.add(mesh);

    return measurement;
  }

  private createLineMesh(start: THREE.Vector3, end: THREE.Vector3, distance: number): THREE.Group {
    const group = new THREE.Group();
    group.name = 'measurementLine';

    // Line
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([start, end]);
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 2 });
    const line = new THREE.Line(lineGeometry, lineMaterial);
    group.add(line);

    // Start point sphere
    const sphereGeometry = new THREE.SphereGeometry(0.05, 16, 16);
    const sphereMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    const startSphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
    startSphere.position.copy(start);
    startSphere.name = 'measurementPoint';
    group.add(startSphere);

    // End point sphere
    const endSphere = new THREE.Mesh(sphereGeometry, sphereMaterial.clone());
    endSphere.position.copy(end);
    endSphere.name = 'measurementPoint';
    group.add(endSphere);

    // Distance label (using sprite)
    const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const label = this.createTextSprite(`${distance.toFixed(2)}m`, 0x00ff00);
    label.position.copy(midpoint);
    label.position.y += 0.15;
    group.add(label);

    return group;
  }

  private createPolygonMesh(points: THREE.Vector3[], area: number): THREE.Group {
    const group = new THREE.Group();
    group.name = 'measurementPolygon';

    // Outline lines
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x0088ff, linewidth: 2 });
    for (let i = 0; i < points.length; i++) {
      const start = points[i];
      const end = points[(i + 1) % points.length];
      const lineGeometry = new THREE.BufferGeometry().setFromPoints([start, end]);
      const line = new THREE.Line(lineGeometry, lineMaterial);
      group.add(line);
    }

    // Point spheres
    const sphereGeometry = new THREE.SphereGeometry(0.05, 16, 16);
    const sphereMaterial = new THREE.MeshBasicMaterial({ color: 0x0088ff });
    for (const point of points) {
      const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial.clone());
      sphere.position.copy(point);
      sphere.name = 'measurementPoint';
      group.add(sphere);
    }

    // Fill polygon (semi-transparent)
    if (points.length >= 3) {
      const shape = new THREE.Shape();
      // Project to XZ plane for shape creation
      // Negate Z to fix mirroring (Shape is 2D in XY, then rotated to XZ plane)
      shape.moveTo(points[0].x, -points[0].z);
      for (let i = 1; i < points.length; i++) {
        shape.lineTo(points[i].x, -points[i].z);
      }
      shape.closePath();

      const shapeGeometry = new THREE.ShapeGeometry(shape);
      // Rotate to be horizontal
      shapeGeometry.rotateX(-Math.PI / 2);
      // Position at average Y
      const avgY = points.reduce((sum, p) => sum + p.y, 0) / points.length;

      const fillMaterial = new THREE.MeshBasicMaterial({
        color: 0x0088ff,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide
      });
      const fill = new THREE.Mesh(shapeGeometry, fillMaterial);
      fill.position.y = avgY;
      group.add(fill);
    }

    // Area label
    const centroid = this.calculateCentroid(points);
    const label = this.createTextSprite(`${area.toFixed(2)} m²`, 0x0088ff);
    label.position.copy(centroid);
    label.position.y += 0.2;
    group.add(label);

    return group;
  }

  private createTextSprite(text: string, color: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    canvas.width = 256;
    canvas.height = 64;

    // Background
    context.fillStyle = 'rgba(255, 255, 255, 0.9)';
    context.fillRect(0, 0, canvas.width, canvas.height);

    // Border
    context.strokeStyle = `#${color.toString(16).padStart(6, '0')}`;
    context.lineWidth = 3;
    context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);

    // Text
    context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    context.font = 'bold 28px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.8, 0.2, 1);
    sprite.name = 'measurementLabel';

    return sprite;
  }

  private calculatePolygonArea(points: THREE.Vector3[]): number {
    if (points.length < 3) return 0;

    // Calculate polygon normal using Newell's method (works for any polygon orientation)
    const normal = new THREE.Vector3(0, 0, 0);
    for (let i = 0; i < points.length; i++) {
      const current = points[i];
      const next = points[(i + 1) % points.length];
      normal.x += (current.y - next.y) * (current.z + next.z);
      normal.y += (current.z - next.z) * (current.x + next.x);
      normal.z += (current.x - next.x) * (current.y + next.y);
    }

    if (normal.length() < 1e-10) return 0;
    normal.normalize();

    // Create a coordinate system on the polygon plane
    // Find the axis most different from normal to avoid numerical issues
    let refAxis = new THREE.Vector3(1, 0, 0);
    if (Math.abs(normal.dot(refAxis)) > 0.9) {
      refAxis = new THREE.Vector3(0, 1, 0);
    }

    // Create orthonormal basis on the plane
    const uAxis = new THREE.Vector3().crossVectors(normal, refAxis).normalize();
    const vAxis = new THREE.Vector3().crossVectors(normal, uAxis).normalize();

    // Project all points onto the 2D plane defined by uAxis and vAxis
    const projected2D: { u: number; v: number }[] = [];
    for (const p of points) {
      projected2D.push({
        u: p.dot(uAxis),
        v: p.dot(vAxis)
      });
    }

    // Apply Shoelace formula on the 2D projection
    let area = 0;
    for (let i = 0; i < projected2D.length; i++) {
      const j = (i + 1) % projected2D.length;
      area += projected2D[i].u * projected2D[j].v;
      area -= projected2D[j].u * projected2D[i].v;
    }

    return Math.abs(area) / 2;
  }

  private calculateCentroid(points: THREE.Vector3[]): THREE.Vector3 {
    const centroid = new THREE.Vector3();
    for (const point of points) {
      centroid.add(point);
    }
    return centroid.divideScalar(points.length);
  }

  // Select a measurement
  selectMeasurement(id: string | null) {
    // Deselect previous
    if (this.selectedId) {
      const prev = this.measurements.find(m => m.id === this.selectedId);
      if (prev) {
        this.updateMeshColor(prev.mesh, prev.type === 'line' ? 0x00ff00 : 0x0088ff);
      }
    }

    this.selectedId = id;

    // Highlight selected
    if (id) {
      const selected = this.measurements.find(m => m.id === id);
      if (selected) {
        this.updateMeshColor(selected.mesh, 0xff8800);
      }
    }
  }

  private updateMeshColor(group: THREE.Group, color: number) {
    group.traverse((obj) => {
      if (obj instanceof THREE.Line && obj.material instanceof THREE.LineBasicMaterial) {
        obj.material.color.setHex(color);
      }
      if (obj instanceof THREE.Mesh && obj.name === 'measurementPoint') {
        (obj.material as THREE.MeshBasicMaterial).color.setHex(color);
      }
    });
  }

  // Delete selected measurement
  deleteMeasurement(id: string) {
    const index = this.measurements.findIndex(m => m.id === id);
    if (index >= 0) {
      const measurement = this.measurements[index];
      this.scene.remove(measurement.mesh);
      measurement.mesh.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry?.dispose();
          if (obj.material) {
            const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
            materials.forEach(m => m.dispose());
          }
        }
      });
      this.measurements.splice(index, 1);
      if (this.selectedId === id) {
        this.selectedId = null;
      }
    }
  }

  // Move a measurement along X or Z axis
  moveMeasurement(id: string, axis: 'x' | 'z', delta: number) {
    const measurement = this.measurements.find(m => m.id === id);
    if (!measurement) return;

    if (measurement.type === 'line') {
      measurement.start.position[axis] += delta;
      measurement.end.position[axis] += delta;
    } else {
      for (const point of measurement.points) {
        point.position[axis] += delta;
      }
    }

    // Rebuild mesh
    this.scene.remove(measurement.mesh);
    if (measurement.type === 'line') {
      measurement.mesh = this.createLineMesh(
        measurement.start.position,
        measurement.end.position,
        measurement.distance
      );
    } else {
      measurement.mesh = this.createPolygonMesh(
        measurement.points.map(p => p.position),
        measurement.area
      );
    }
    this.scene.add(measurement.mesh);

    // Re-select to maintain highlight
    if (this.selectedId === id) {
      this.updateMeshColor(measurement.mesh, 0xff8800);
    }
  }

  // Get all measurements
  getMeasurements(): Measurement[] {
    return this.measurements;
  }

  // Get selected measurement
  getSelectedMeasurement(): Measurement | null {
    return this.measurements.find(m => m.id === this.selectedId) || null;
  }

  // Toggle measurement visibility
  setMeasurementVisible(id: string, visible: boolean) {
    const measurement = this.measurements.find(m => m.id === id);
    if (measurement) {
      measurement.visible = visible;
      measurement.mesh.visible = visible;
    }
  }

  // Set all measurements visibility
  setAllVisible(visible: boolean) {
    for (const m of this.measurements) {
      m.visible = visible;
      m.mesh.visible = visible;
    }
  }

  // Export measurements as DXF lines with text labels
  exportToDXFLines(includeMeasurements: boolean): string {
    if (!includeMeasurements) return '';

    let dxf = '';

    for (const m of this.measurements) {
      if (!m.visible) continue;

      if (m.type === 'line') {
        // Export the line
        dxf += '0\nLINE\n';
        dxf += '8\nMEASUREMENTS\n';
        dxf += `10\n${m.start.position.x.toFixed(6)}\n`;
        dxf += `20\n${m.start.position.z.toFixed(6)}\n`;
        dxf += '30\n0\n';
        dxf += `11\n${m.end.position.x.toFixed(6)}\n`;
        dxf += `21\n${m.end.position.z.toFixed(6)}\n`;
        dxf += '31\n0\n';

        // Export the distance label as TEXT
        const midX = (m.start.position.x + m.end.position.x) / 2;
        const midZ = (m.start.position.z + m.end.position.z) / 2;
        const distanceText = `${m.distance.toFixed(2)}m`;

        dxf += '0\nTEXT\n';
        dxf += '8\nMEASUREMENTS\n';
        dxf += `10\n${midX.toFixed(6)}\n`; // X position
        dxf += `20\n${midZ.toFixed(6)}\n`; // Y position (Z in 3D)
        dxf += '30\n0\n'; // Z position
        dxf += '40\n0.15\n'; // Text height
        dxf += `1\n${distanceText}\n`; // Text content
        dxf += '72\n1\n'; // Horizontal justification (center)
        dxf += '73\n2\n'; // Vertical justification (middle)
        dxf += `11\n${midX.toFixed(6)}\n`; // Alignment point X
        dxf += `21\n${midZ.toFixed(6)}\n`; // Alignment point Y
        dxf += '31\n0\n'; // Alignment point Z

      } else if (m.type === 'polygon') {
        // Export polygon as LWPOLYLINE
        dxf += '0\nLWPOLYLINE\n';
        dxf += '8\nMEASUREMENTS\n';
        dxf += `90\n${m.points.length}\n`;
        dxf += '70\n1\n'; // Closed

        for (const point of m.points) {
          dxf += `10\n${point.position.x.toFixed(6)}\n`;
          dxf += `20\n${point.position.z.toFixed(6)}\n`;
        }

        // Export the area label as TEXT at centroid
        const centroid = this.calculateCentroid(m.points.map(p => p.position));
        const areaText = `${m.area.toFixed(2)} m²`;

        dxf += '0\nTEXT\n';
        dxf += '8\nMEASUREMENTS\n';
        dxf += `10\n${centroid.x.toFixed(6)}\n`;
        dxf += `20\n${centroid.z.toFixed(6)}\n`;
        dxf += '30\n0\n';
        dxf += '40\n0.2\n'; // Text height
        dxf += `1\n${areaText}\n`;
        dxf += '72\n1\n'; // Center
        dxf += '73\n2\n'; // Middle
        dxf += `11\n${centroid.x.toFixed(6)}\n`;
        dxf += `21\n${centroid.z.toFixed(6)}\n`;
        dxf += '31\n0\n';
      }
    }

    return dxf;
  }

  // Find measurement at screen position
  findMeasurementAtPoint(raycaster: THREE.Raycaster): Measurement | null {
    const intersects: THREE.Intersection[] = [];

    for (const m of this.measurements) {
      if (!m.visible) continue;
      const hits = raycaster.intersectObject(m.mesh, true);
      if (hits.length > 0) {
        intersects.push({ ...hits[0], object: m.mesh } as THREE.Intersection);
      }
    }

    if (intersects.length === 0) return null;

    // Find the measurement corresponding to the closest hit
    intersects.sort((a, b) => a.distance - b.distance);
    const hitMesh = intersects[0].object;

    // Find parent group
    let parent = hitMesh;
    while (parent.parent && parent.parent !== this.scene) {
      parent = parent.parent;
    }

    return this.measurements.find(m => m.mesh === parent) || null;
  }

  dispose() {
    for (const m of this.measurements) {
      this.scene.remove(m.mesh);
      m.mesh.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry?.dispose();
        }
      });
    }
    this.measurements = [];
  }
}
