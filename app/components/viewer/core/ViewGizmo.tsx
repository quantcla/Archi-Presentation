import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

interface Props {
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  perspectiveCamera: THREE.PerspectiveCamera | null;
  orthographicCamera: THREE.OrthographicCamera | null;
  controls: OrbitControls;
  edgesVisible?: boolean;
  onToggleEdges?: (visible: boolean) => void;
  isOrtho: boolean;
  setIsOrtho: (ortho: boolean) => void;
  // Section cut props
  sectionEnabled?: boolean;
  sectionY?: number;
  sectionMaxY?: number;
  setSectionY?: (y: number | null) => void;
}

interface ViewDirection {
  name: string;
  position: THREE.Vector3;
  up: THREE.Vector3;
}

const VIEW_DIRECTIONS: Record<string, ViewDirection> = {
  front: { name: 'Front', position: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
  back: { name: 'Back', position: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0) },
  top: { name: 'Top', position: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1) },
  bottom: { name: 'Bottom', position: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1) },
  right: { name: 'Right', position: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
  left: { name: 'Left', position: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
};

export const ViewGizmo: React.FC<Props> = ({
  camera,
  perspectiveCamera,
  orthographicCamera,
  controls,
  edgesVisible = false,
  onToggleEdges,
  isOrtho,
  setIsOrtho,
  sectionEnabled = false,
  sectionY = 1.5,
  sectionMaxY = 10,
  setSectionY
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredFace, setHoveredFace] = useState<string | null>(null);
  const [sectionExpanded, setSectionExpanded] = useState(false);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const gizmoRendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const gizmoCameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const cubeRef = useRef<THREE.Group | null>(null);
  const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster());
  const mouseRef = useRef<THREE.Vector2>(new THREE.Vector2());

  useEffect(() => {
    if (!canvasRef.current) return;

    const size = 120;
    const canvas = canvasRef.current;

    // Create gizmo scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // Create gizmo renderer
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(size, size);
    renderer.setPixelRatio(window.devicePixelRatio);
    gizmoRendererRef.current = renderer;

    // Create orthographic camera for gizmo
    const gizmoCamera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
    gizmoCamera.position.set(0, 0, 5);
    gizmoCameraRef.current = gizmoCamera;

    // Create the navigation cube
    const cubeGroup = new THREE.Group();
    cubeRef.current = cubeGroup;

    // Cube geometry
    const cubeSize = 1;
    const cubeGeometry = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);

    // Create materials for each face with labels
    const faceMaterials = createFaceMaterials();
    const cube = new THREE.Mesh(cubeGeometry, faceMaterials);
    cube.name = 'navCube';
    cubeGroup.add(cube);

    // Add edge lines
    const edgeGeometry = new THREE.EdgesGeometry(cubeGeometry);
    const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x333333, linewidth: 2 });
    const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    cubeGroup.add(edges);

    // Add axis indicators
    const axisLength = 1.4;
    const axisGroup = createAxisIndicators(axisLength);
    cubeGroup.add(axisGroup);

    scene.add(cubeGroup);

    // Add ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);

    // Animation loop
    let animationId: number;
    const animate = () => {
      animationId = requestAnimationFrame(animate);

      // Sync gizmo rotation with main camera
      if (cubeRef.current) {
        // Get camera's rotation
        const cameraDirection = new THREE.Vector3();
        camera.getWorldDirection(cameraDirection);

        // Apply inverse rotation to cube
        cubeRef.current.quaternion.copy(camera.quaternion).invert();
      }

      renderer.render(scene, gizmoCamera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animationId);
      renderer.dispose();
    };
  }, [camera]);

  const createFaceMaterials = (): THREE.Material[] => {
    const createFaceTexture = (label: string, bgColor: string, textColor: string = '#333') => {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d')!;

      // Background
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, 128, 128);

      // Border
      ctx.strokeStyle = '#666';
      ctx.lineWidth = 2;
      ctx.strokeRect(2, 2, 124, 124);

      // Text
      ctx.fillStyle = textColor;
      ctx.font = 'bold 32px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 64, 64);

      const texture = new THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      return texture;
    };

    // Order: +X, -X, +Y, -Y, +Z, -Z
    return [
      new THREE.MeshBasicMaterial({ map: createFaceTexture('R', '#e8e8e8') }), // Right (+X)
      new THREE.MeshBasicMaterial({ map: createFaceTexture('L', '#e8e8e8') }), // Left (-X)
      new THREE.MeshBasicMaterial({ map: createFaceTexture('T', '#d4e8d4') }), // Top (+Y)
      new THREE.MeshBasicMaterial({ map: createFaceTexture('B', '#e8d4d4') }), // Bottom (-Y)
      new THREE.MeshBasicMaterial({ map: createFaceTexture('F', '#d4d4e8') }), // Front (+Z)
      new THREE.MeshBasicMaterial({ map: createFaceTexture('Bk', '#e8e8e8') }), // Back (-Z)
    ];
  };

  const createAxisIndicators = (length: number): THREE.Group => {
    const group = new THREE.Group();

    // X axis (red)
    const xGeometry = new THREE.CylinderGeometry(0.02, 0.02, length, 8);
    const xMaterial = new THREE.MeshBasicMaterial({ color: 0xff4444 });
    const xAxis = new THREE.Mesh(xGeometry, xMaterial);
    xAxis.rotation.z = -Math.PI / 2;
    xAxis.position.x = length / 2 + 0.3;
    group.add(xAxis);

    // X cone
    const xCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.06, 0.15, 8),
      xMaterial
    );
    xCone.rotation.z = -Math.PI / 2;
    xCone.position.x = length + 0.35;
    group.add(xCone);

    // Y axis (green)
    const yGeometry = new THREE.CylinderGeometry(0.02, 0.02, length, 8);
    const yMaterial = new THREE.MeshBasicMaterial({ color: 0x44ff44 });
    const yAxis = new THREE.Mesh(yGeometry, yMaterial);
    yAxis.position.y = length / 2 + 0.3;
    group.add(yAxis);

    // Y cone
    const yCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.06, 0.15, 8),
      yMaterial
    );
    yCone.position.y = length + 0.35;
    group.add(yCone);

    // Z axis (blue)
    const zGeometry = new THREE.CylinderGeometry(0.02, 0.02, length, 8);
    const zMaterial = new THREE.MeshBasicMaterial({ color: 0x4444ff });
    const zAxis = new THREE.Mesh(zGeometry, zMaterial);
    zAxis.rotation.x = Math.PI / 2;
    zAxis.position.z = length / 2 + 0.3;
    group.add(zAxis);

    // Z cone
    const zCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.06, 0.15, 8),
      zMaterial
    );
    zCone.rotation.x = Math.PI / 2;
    zCone.position.z = length + 0.35;
    group.add(zCone);

    return group;
  };

  const animateCameraToView = (direction: ViewDirection) => {
    const target = controls.target.clone();
    const distance = camera.position.distanceTo(target);
    const newPosition = target.clone().add(direction.position.clone().multiplyScalar(distance));

    // Animate both cameras to stay in sync
    const startPosition = camera.position.clone();
    const startUp = camera.up.clone();
    const duration = 300;
    const startTime = Date.now();

    const animateCamera = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // Ease out cubic

      const newPos = new THREE.Vector3().lerpVectors(startPosition, newPosition, eased);
      const newUp = new THREE.Vector3().lerpVectors(startUp, direction.up, eased);

      // Update active camera
      camera.position.copy(newPos);
      camera.up.copy(newUp);
      camera.lookAt(target);

      // Keep both cameras in sync
      if (perspectiveCamera && perspectiveCamera !== camera) {
        perspectiveCamera.position.copy(newPos);
        perspectiveCamera.up.copy(newUp);
        perspectiveCamera.lookAt(target);
      }
      if (orthographicCamera && orthographicCamera !== camera) {
        orthographicCamera.position.copy(newPos);
        orthographicCamera.up.copy(newUp);
        orthographicCamera.lookAt(target);
      }

      controls.update();

      if (progress < 1) {
        requestAnimationFrame(animateCamera);
      }
    };

    animateCamera();
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || !cubeRef.current || !gizmoCameraRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycasterRef.current.setFromCamera(mouseRef.current, gizmoCameraRef.current);
    const intersects = raycasterRef.current.intersectObject(cubeRef.current, true);

    if (intersects.length > 0) {
      const hit = intersects[0];
      const faceIndex = hit.face?.materialIndex;

      // Determine which view to switch to based on face index
      const viewMap: Record<number, string> = {
        0: 'right',
        1: 'left',
        2: 'top',
        3: 'bottom',
        4: 'front',
        5: 'back',
      };

      const viewKey = viewMap[faceIndex ?? -1];
      if (viewKey && VIEW_DIRECTIONS[viewKey]) {
        animateCameraToView(VIEW_DIRECTIONS[viewKey]);
      }
    }
  };

  const toggleOrtho = () => {
    setIsOrtho(!isOrtho);
  };

  return (
    <div className="flex flex-col items-end gap-2">
      {/* Navigation Cube */}
      <div className="relative">
        <canvas
          ref={canvasRef}
          width={120}
          height={120}
          onClick={handleCanvasClick}
          onMouseMove={(e) => {
            // Could add hover highlighting here
          }}
          className="cursor-pointer rounded-lg shadow-lg bg-white/90 backdrop-blur-sm"
          title="Click a face to change view"
          style={{ pointerEvents: 'auto' }}
        />
      </div>

      {/* View Controls */}
      <div className="flex flex-col gap-1 bg-white/90 backdrop-blur-sm rounded-lg shadow-lg p-1" style={{ pointerEvents: 'auto', width: '120px' }}>
        {/* Ortho/Persp Toggle */}
        <button
          onClick={toggleOrtho}
          className={`w-full py-1.5 text-xs font-bold rounded transition-colors ${
            isOrtho
              ? 'bg-blue-500 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
          title={isOrtho ? 'Switch to Perspective' : 'Switch to Orthographic'}
        >
          {isOrtho ? 'ORTHO' : 'PERSP'}
        </button>

        {/* Quick View Buttons */}
        <div className="grid grid-cols-3 gap-0.5">
          <button
            onClick={() => animateCameraToView(VIEW_DIRECTIONS.front)}
            className="w-full py-1 text-[10px] font-medium bg-gray-100 hover:bg-blue-100 rounded transition-colors"
            title="Front View"
          >
            Front
          </button>
          <button
            onClick={() => animateCameraToView(VIEW_DIRECTIONS.top)}
            className="w-full py-1 text-[10px] font-medium bg-green-100 hover:bg-green-200 rounded transition-colors"
            title="Top View"
          >
            Top
          </button>
          <button
            onClick={() => animateCameraToView(VIEW_DIRECTIONS.right)}
            className="w-full py-1 text-[10px] font-medium bg-gray-100 hover:bg-blue-100 rounded transition-colors"
            title="Right View"
          >
            Right
          </button>
          <button
            onClick={() => animateCameraToView(VIEW_DIRECTIONS.back)}
            className="w-full py-1 text-[10px] font-medium bg-gray-100 hover:bg-blue-100 rounded transition-colors"
            title="Back View"
          >
            Back
          </button>
          <button
            onClick={() => animateCameraToView(VIEW_DIRECTIONS.left)}
            className="w-full py-1 text-[10px] font-medium bg-gray-100 hover:bg-blue-100 rounded transition-colors"
            title="Left View"
          >
            Left
          </button>
          <div></div>
        </div>

        {/* Edges Toggle */}
        {onToggleEdges && (
          <button
            onClick={() => onToggleEdges(!edgesVisible)}
            className={`w-full py-1.5 text-xs font-bold rounded transition-colors ${
              edgesVisible
                ? 'bg-gray-800 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
            title={edgesVisible ? 'Hide Edges' : 'Show Edges'}
          >
            EDGES
          </button>
        )}

        {/* Section Cut Toggle */}
        {setSectionY && (
          <div className="border-t border-gray-200 pt-1 mt-1">
            <button
              onClick={() => setSectionExpanded(!sectionExpanded)}
              className={`w-full py-1.5 text-xs font-bold rounded transition-colors flex items-center justify-center gap-1 ${
                sectionEnabled
                  ? 'bg-orange-500 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
              title="Section Cut"
            >
              <span>SECTION</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={`transition-transform ${sectionExpanded ? 'rotate-180' : ''}`}
              >
                <path d="m6 9 6 6 6-6"/>
              </svg>
            </button>

            {/* Expanded Section Controls */}
            {sectionExpanded && (
              <div className="mt-1 p-2 bg-gray-50 rounded space-y-2">
                {/* Enable Toggle */}
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-gray-600">Enable</span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sectionEnabled}
                      onChange={(e) => setSectionY(e.target.checked ? sectionY : null)}
                      className="sr-only peer"
                    />
                    <div className="w-8 h-4 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-orange-500"></div>
                  </label>
                </div>

                {/* Height Slider */}
                <div className={sectionEnabled ? '' : 'opacity-50 pointer-events-none'}>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-gray-600">Y:</span>
                    <span className="text-[10px] font-mono text-gray-700">{sectionY.toFixed(2)}m</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max={sectionMaxY}
                    step="0.01"
                    className="w-full h-1 mt-1"
                    value={sectionY}
                    onChange={(e) => setSectionY(parseFloat(e.target.value))}
                    disabled={!sectionEnabled}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
