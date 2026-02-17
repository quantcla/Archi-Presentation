import React, { useRef, useEffect, useState, useContext, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { ViewGizmo } from './ViewGizmo';

interface ViewerContextType {
  scene: THREE.Scene | null;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera | null;
  perspectiveCamera: THREE.PerspectiveCamera | null;
  orthographicCamera: THREE.OrthographicCamera | null;
  renderer: THREE.WebGLRenderer | null;
  controls: OrbitControls | null;
  fitToBox: (box: THREE.Box3) => void;
  setSectionPlane: (y: number | null, edgeClippingCallback?: (plane: THREE.Plane | null) => void) => void;
  sectionY: number | null;
  clippingPlane: THREE.Plane | null;
  registerRenderCallback: (id: string, callback: () => void) => void;
  unregisterRenderCallback: (id: string) => void;
  isOrtho: boolean;
  setIsOrtho: (ortho: boolean) => void;
  setCustomRenderer: (renderer: ((scene: THREE.Scene, camera: THREE.Camera, webglRenderer: THREE.WebGLRenderer) => void) | null) => void;
}

const ViewerContext = React.createContext<ViewerContextType>({
  scene: null,
  camera: null,
  perspectiveCamera: null,
  orthographicCamera: null,
  renderer: null,
  controls: null,
  fitToBox: () => {},
  setSectionPlane: () => {},
  sectionY: null,
  clippingPlane: null,
  registerRenderCallback: () => {},
  unregisterRenderCallback: () => {},
  isOrtho: false,
  setIsOrtho: () => {},
  setCustomRenderer: () => {},
});

export const useViewer = () => useContext(ViewerContext);

interface ViewerCanvasProps {
  edgesVisible?: boolean;
  onToggleEdges?: (visible: boolean) => void;
  // Section cut props
  sectionEnabled?: boolean;
  sectionY?: number;
  sectionMaxY?: number;
  setSectionY?: (y: number | null) => void;
}

// Separate component for the 3D canvas
export const ViewerCanvas: React.FC<ViewerCanvasProps> = ({
  edgesVisible = false,
  onToggleEdges,
  sectionEnabled = false,
  sectionY = 1.5,
  sectionMaxY = 10,
  setSectionY
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scene, camera, perspectiveCamera, orthographicCamera, renderer, controls, isOrtho, setIsOrtho } = useViewer();

  useEffect(() => {
    if (!containerRef.current || !renderer) return;

    // Append renderer to container
    containerRef.current.appendChild(renderer.domElement);

    // Handle resize
    const onResize = () => {
      if (!containerRef.current || !renderer) return;
      const width = containerRef.current.clientWidth;
      const height = containerRef.current.clientHeight;
      const aspect = width / height;

      // Update perspective camera
      if (perspectiveCamera) {
        perspectiveCamera.aspect = aspect;
        perspectiveCamera.updateProjectionMatrix();
      }

      // Update orthographic camera - maintain proper frustum
      if (orthographicCamera) {
        const frustumSize = orthographicCamera.userData.frustumSize || 50;
        orthographicCamera.left = -frustumSize * aspect / 2;
        orthographicCamera.right = frustumSize * aspect / 2;
        orthographicCamera.top = frustumSize / 2;
        orthographicCamera.bottom = -frustumSize / 2;
        orthographicCamera.updateProjectionMatrix();
      }

      renderer.setSize(width, height);
    };

    onResize();
    window.addEventListener('resize', onResize);

    // Also observe container size changes
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(containerRef.current);

    return () => {
      window.removeEventListener('resize', onResize);
      resizeObserver.disconnect();
      if (containerRef.current && renderer.domElement.parentElement === containerRef.current) {
        containerRef.current.removeChild(renderer.domElement);
      }
    };
  }, [renderer, perspectiveCamera, orthographicCamera]);

  return (
    <div ref={containerRef} className="w-full h-full relative">
      {/* ViewGizmo overlay */}
      <div className="absolute top-4 right-4 pointer-events-none z-10">
        {camera && controls && (
          <ViewGizmo
            camera={camera}
            perspectiveCamera={perspectiveCamera}
            orthographicCamera={orthographicCamera}
            controls={controls}
            edgesVisible={edgesVisible}
            onToggleEdges={onToggleEdges}
            isOrtho={isOrtho}
            setIsOrtho={setIsOrtho}
            sectionEnabled={sectionEnabled}
            sectionY={sectionY}
            sectionMaxY={sectionMaxY}
            setSectionY={setSectionY}
          />
        )}
      </div>
    </div>
  );
};

export const ViewerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [scene, setScene] = useState<THREE.Scene | null>(null);
  const [camera, setCamera] = useState<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>(null);
  const [perspectiveCamera, setPerspectiveCamera] = useState<THREE.PerspectiveCamera | null>(null);
  const [orthographicCamera, setOrthographicCamera] = useState<THREE.OrthographicCamera | null>(null);
  const [renderer, setRenderer] = useState<THREE.WebGLRenderer | null>(null);
  const [controls, setControls] = useState<OrbitControls | null>(null);
  const [sectionY, setSectionYState] = useState<number | null>(null);
  const [isOrtho, setIsOrthoState] = useState(false);

  const perspectiveCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const orthographicCameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const clippingPlaneRef = useRef<THREE.Plane | null>(null);
  const sectionCapRef = useRef<THREE.Mesh | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const renderCallbacksRef = useRef<Map<string, () => void>>(new Map());
  const activeCameraRef = useRef<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>(null);
  const customRendererRef = useRef<((scene: THREE.Scene, camera: THREE.Camera, webglRenderer: THREE.WebGLRenderer) => void) | null>(null);

  const setCustomRenderer = useCallback((customRenderer: ((scene: THREE.Scene, camera: THREE.Camera, webglRenderer: THREE.WebGLRenderer) => void) | null) => {
    customRendererRef.current = customRenderer;
  }, []);

  const registerRenderCallback = useCallback((id: string, callback: () => void) => {
    renderCallbacksRef.current.set(id, callback);
  }, []);

  const unregisterRenderCallback = useCallback((id: string) => {
    renderCallbacksRef.current.delete(id);
  }, []);

  const setSectionPlane = useCallback((y: number | null, edgeClippingCallback?: (plane: THREE.Plane | null) => void) => {
    setSectionYState(y);
    const _scene = sceneRef.current;

    if (!_scene) return;

    // Remove existing section cap meshes
    const capsToRemove: THREE.Object3D[] = [];
    _scene.traverse((obj) => {
      if (obj.name === 'sectionCapMesh' || obj.name === 'sectionCapGroup') {
        capsToRemove.push(obj);
      }
    });
    capsToRemove.forEach((cap) => {
      _scene.remove(cap);
      cap.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry?.dispose();
          if (child.material) {
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.forEach((m) => m.dispose());
          }
        }
      });
    });
    sectionCapRef.current = null;

    if (y === null) {
      // Disable clipping
      clippingPlaneRef.current = null;
      _scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.material) {
          if (obj.name === 'sectionCapMesh') return;
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
          materials.forEach((mat) => {
            mat.clippingPlanes = [];
            mat.clipShadows = false;
          });
        }
      });
      // Also update edge clipping
      if (edgeClippingCallback) {
        edgeClippingCallback(null);
      }
      return;
    }

    // Create clipping plane (pointing down, so everything above y is clipped)
    const clippingPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), y);
    clippingPlaneRef.current = clippingPlane;

    // Update edge clipping
    if (edgeClippingCallback) {
      edgeClippingCallback(clippingPlane);
    }

    // Material for section caps - dark grey with backface rendering
    const capMaterial = new THREE.MeshBasicMaterial({
      color: 0x404040, // Dark grey for section fill
      side: THREE.BackSide, // Only render back faces
      clippingPlanes: [clippingPlane],
    });

    const capGroup = new THREE.Group();
    capGroup.name = 'sectionCapGroup';

    // Apply clipping plane to all meshes and create backface caps
    _scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.material && obj.geometry) {
        // Skip helper objects and caps
        if (obj.name === 'sectionCapMesh' || obj.name === 'sectionCapGroup') return;
        if (obj.parent?.name === 'sectionCapGroup') return;
        if (obj.parent instanceof THREE.GridHelper) return;

        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach((mat) => {
          mat.clippingPlanes = [clippingPlane];
          mat.clipShadows = true;
          mat.side = THREE.FrontSide; // Original geometry shows front faces
        });

        // Create a cap mesh using the same geometry but with backface material
        // This fills in the cut cross-section
        try {
          const capMesh = new THREE.Mesh(obj.geometry, capMaterial.clone());
          capMesh.name = 'sectionCapMesh';

          // Apply the same world transformation
          obj.updateWorldMatrix(true, false);
          capMesh.applyMatrix4(obj.matrixWorld);

          capGroup.add(capMesh);
        } catch (e) {
          // Skip if mesh can't be processed
        }
      }
    });

    if (capGroup.children.length > 0) {
      _scene.add(capGroup);
      sectionCapRef.current = capGroup as any;
    }
  }, []);

  const fitToBox = useCallback((box: THREE.Box3) => {
    const perspCam = perspectiveCameraRef.current;
    const orthoCam = orthographicCameraRef.current;
    const ctrl = controlsRef.current;
    const cam = activeCameraRef.current;

    console.log('fitToBox called', { cam: !!cam, ctrl: !!ctrl, boxEmpty: box.isEmpty() });

    if (!cam || !ctrl) {
      console.log('fitToBox: camera or controls not ready');
      return;
    }
    if (box.isEmpty()) {
      console.log('fitToBox: box is empty');
      return;
    }

    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    console.log('fitToBox - center:', center.toArray(), 'size:', size.toArray());

    const maxDim = Math.max(size.x, size.y, size.z);

    // Calculate distance for perspective camera
    const fov = perspCam ? perspCam.fov * (Math.PI / 180) : 45 * (Math.PI / 180);
    let cameraDistance = Math.max(maxDim / (2 * Math.tan(fov / 2)), 10);
    cameraDistance *= 2.5; // Extra padding

    const direction = new THREE.Vector3(1, 0.8, 1).normalize();
    const newPosition = center.clone().add(direction.multiplyScalar(cameraDistance));

    console.log('fitToBox - moving camera to:', newPosition.toArray());

    // Update perspective camera
    if (perspCam) {
      perspCam.position.copy(newPosition);
      perspCam.lookAt(center);
      perspCam.updateProjectionMatrix();
    }

    // Update orthographic camera frustum and position
    if (orthoCam) {
      const frustumSize = maxDim * 1.5;
      orthoCam.userData.frustumSize = frustumSize;

      const aspect = rendererRef.current
        ? rendererRef.current.domElement.width / rendererRef.current.domElement.height
        : 1;

      orthoCam.left = -frustumSize * aspect / 2;
      orthoCam.right = frustumSize * aspect / 2;
      orthoCam.top = frustumSize / 2;
      orthoCam.bottom = -frustumSize / 2;
      orthoCam.near = 0.1;
      orthoCam.far = cameraDistance * 10;

      orthoCam.position.copy(newPosition);
      orthoCam.lookAt(center);
      orthoCam.updateProjectionMatrix();
    }

    ctrl.target.copy(center);
    ctrl.update();
  }, []);

  // Function to switch cameras
  const setIsOrtho = useCallback((ortho: boolean) => {
    const perspCam = perspectiveCameraRef.current;
    const orthoCam = orthographicCameraRef.current;
    const ctrl = controlsRef.current;
    const _renderer = rendererRef.current;

    if (!perspCam || !orthoCam || !ctrl || !_renderer) return;

    setIsOrthoState(ortho);

    if (ortho) {
      // Copy position and rotation from perspective to ortho
      orthoCam.position.copy(perspCam.position);
      orthoCam.quaternion.copy(perspCam.quaternion);

      // Calculate frustum size based on distance to target
      const distance = perspCam.position.distanceTo(ctrl.target);
      const fov = perspCam.fov * (Math.PI / 180);
      const frustumSize = 2 * distance * Math.tan(fov / 2);
      orthoCam.userData.frustumSize = frustumSize;

      const aspect = _renderer.domElement.width / _renderer.domElement.height;
      orthoCam.left = -frustumSize * aspect / 2;
      orthoCam.right = frustumSize * aspect / 2;
      orthoCam.top = frustumSize / 2;
      orthoCam.bottom = -frustumSize / 2;
      orthoCam.near = 0.1;
      orthoCam.far = distance * 100;
      orthoCam.updateProjectionMatrix();

      // Switch controls to ortho camera
      ctrl.object = orthoCam;
      ctrl.update();

      activeCameraRef.current = orthoCam;
      setCamera(orthoCam);
    } else {
      // Copy position and rotation from ortho to perspective
      perspCam.position.copy(orthoCam.position);
      perspCam.quaternion.copy(orthoCam.quaternion);
      perspCam.updateProjectionMatrix();

      // Switch controls to perspective camera
      ctrl.object = perspCam;
      ctrl.update();

      activeCameraRef.current = perspCam;
      setCamera(perspCam);
    }
  }, []);

  useEffect(() => {
    // Create scene
    const _scene = new THREE.Scene();
    _scene.background = new THREE.Color(0xf0f2f5);
    sceneRef.current = _scene;

    // Add grid
    const grid = new THREE.GridHelper(100, 100, 0x888888, 0xdddddd);
    _scene.add(grid);

    // Add lights
    const amb = new THREE.AmbientLight(0xffffff, 0.7);
    _scene.add(amb);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(50, 100, 50);
    dir.castShadow = true;
    _scene.add(dir);

    // Create perspective camera
    const _perspCamera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    _perspCamera.position.set(30, 30, 30);
    _perspCamera.lookAt(0, 0, 0);

    // Create orthographic camera with initial frustum
    const initialFrustum = 50;
    const _orthoCamera = new THREE.OrthographicCamera(
      -initialFrustum / 2, initialFrustum / 2,
      initialFrustum / 2, -initialFrustum / 2,
      0.1, 10000
    );
    _orthoCamera.position.copy(_perspCamera.position);
    _orthoCamera.lookAt(0, 0, 0);
    _orthoCamera.userData.frustumSize = initialFrustum;

    // Create renderer
    // Note: logarithmicDepthBuffer disabled because it's incompatible with Spark Gaussian Splat shaders
    const _renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      logarithmicDepthBuffer: false,
      preserveDrawingBuffer: true,  // Required for compare mode snapshot capture via toDataURL()
    });
    _renderer.setPixelRatio(window.devicePixelRatio);
    _renderer.localClippingEnabled = true;

    // Enable proper PBR rendering settings
    _renderer.toneMapping = THREE.ACESFilmicToneMapping;
    _renderer.toneMappingExposure = 1.0;
    _renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Create IBL environment for PBR materials using PMREMGenerator
    const pmremGenerator = new THREE.PMREMGenerator(_renderer);
    pmremGenerator.compileEquirectangularShader();

    // Create a neutral studio-like environment for PBR
    // This generates a simple gradient environment that works well for architectural visualization
    const envScene = new THREE.Scene();

    // Create gradient sky dome for IBL
    const skyGeometry = new THREE.SphereGeometry(500, 32, 32);
    const skyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0xffffff) },     // White/bright top
        bottomColor: { value: new THREE.Color(0xd0d0d0) },  // Light gray bottom
        offset: { value: 0 },
        exponent: { value: 0.6 }
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + offset).y;
          gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
        }
      `,
      side: THREE.BackSide
    });
    const sky = new THREE.Mesh(skyGeometry, skyMaterial);
    envScene.add(sky);

    // Add some soft lights to the environment scene for better reflections
    const envLight1 = new THREE.PointLight(0xffffff, 100, 1000);
    envLight1.position.set(100, 200, 100);
    envScene.add(envLight1);

    const envLight2 = new THREE.PointLight(0xffffff, 50, 1000);
    envLight2.position.set(-100, 100, -100);
    envScene.add(envLight2);

    // Generate environment map from scene
    const envRenderTarget = pmremGenerator.fromScene(envScene, 0.04);
    _scene.environment = envRenderTarget.texture;

    // Cleanup env scene
    skyGeometry.dispose();
    skyMaterial.dispose();
    pmremGenerator.dispose();

    // Create controls (start with perspective camera)
    const _controls = new OrbitControls(_perspCamera, _renderer.domElement);
    _controls.enableDamping = true;
    _controls.dampingFactor = 0.1;
    _controls.minDistance = 0.1;
    _controls.maxDistance = 10000;

    // Store refs
    perspectiveCameraRef.current = _perspCamera;
    orthographicCameraRef.current = _orthoCamera;
    controlsRef.current = _controls;
    rendererRef.current = _renderer;
    activeCameraRef.current = _perspCamera;

    // Set state
    setScene(_scene);
    setCamera(_perspCamera);
    setPerspectiveCamera(_perspCamera);
    setOrthographicCamera(_orthoCamera);
    setRenderer(_renderer);
    setControls(_controls);

    // Animation loop - use activeCameraRef to always render with current camera
    let animationId: number;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      _controls.update();

      // Call all registered render callbacks (e.g., for Gaussian Splats)
      renderCallbacksRef.current.forEach((callback) => {
        try {
          callback();
        } catch (e) {
          console.warn('Render callback error:', e);
        }
      });

      const activeCamera = activeCameraRef.current || _perspCamera;

      // Use custom renderer if set, otherwise default render
      if (customRendererRef.current) {
        customRendererRef.current(_scene, activeCamera, _renderer);
      } else {
        _renderer.render(_scene, activeCamera);
      }
    };
    animate();

    return () => {
      cancelAnimationFrame(animationId);
      _renderer.dispose();
      _controls.dispose();
    };
  }, []);

  return (
    <ViewerContext.Provider value={{
      scene,
      camera,
      perspectiveCamera,
      orthographicCamera,
      renderer,
      controls,
      fitToBox,
      setSectionPlane,
      sectionY,
      clippingPlane: clippingPlaneRef.current,
      registerRenderCallback,
      unregisterRenderCallback,
      isOrtho,
      setIsOrtho,
      setCustomRenderer
    }}>
      {children}
    </ViewerContext.Provider>
  );
};
