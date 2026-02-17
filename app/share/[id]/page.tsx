"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ViewerProvider, useViewer, ViewerCanvas } from '../../components/viewer/core/ViewerContext';
import { FileText, PanelRightClose, ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { SharedPresentation, SharedModel, SharedHotspot } from '../../lib/shared-presentation';

// Inner component that uses the viewer context
function SharedViewerContent({ presentation }: { presentation: SharedPresentation }) {
  const { scene, camera, controls, fitToBox, setSectionPlane } = useViewer();
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [pdfPanelOpen, setPdfPanelOpen] = useState(false);
  const [activeHotspotId, setActiveHotspotId] = useState<string | null>(null);
  const loadedModelsRef = useRef<Map<string, THREE.Group>>(new Map());
  const hotspotMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const isLoadingRef = useRef(false);

  const activeSlide = presentation.slides[activeSlideIndex];
  const activeHotspot = activeHotspotId
    ? activeSlide?.hotspots.find(h => h.id === activeHotspotId) ?? null
    : null;

  // Load all GLB models on mount
  useEffect(() => {
    if (!scene || isLoadingRef.current) return;
    isLoadingRef.current = true;

    const loader = new GLTFLoader();

    const loadModel = async (model: SharedModel) => {
      // Use direct blob URL if available, fall back to API proxy
      const url = model.glbUrl || `/api/share/${presentation.id}/files/${model.glbFilename}`;
      return new Promise<void>((resolve) => {
        loader.load(
          url,
          (gltf) => {
            const group = gltf.scene;
            group.name = `shared-model-${model.id}`;
            group.position.set(model.position.x, model.position.y, model.position.z);
            group.rotation.set(model.rotation.x, model.rotation.y, model.rotation.z);
            group.scale.set(model.scale.x, model.scale.y, model.scale.z);

            // Enable shadow casting
            group.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                child.castShadow = true;
                child.receiveShadow = true;
              }
            });

            scene.add(group);
            loadedModelsRef.current.set(model.id, group);
            resolve();
          },
          undefined,
          (err) => {
            console.warn(`Failed to load model ${model.name}:`, err);
            resolve();
          }
        );
      });
    };

    Promise.all(presentation.models.map(loadModel)).then(() => {
      // Fit camera to all loaded models
      const box = new THREE.Box3();
      loadedModelsRef.current.forEach((group) => {
        box.expandByObject(group);
      });
      if (!box.isEmpty()) {
        fitToBox(box);
      }
      // Apply initial slide visibility
      updateSlideVisibility(0);
    });

    return () => {
      // Cleanup models on unmount
      loadedModelsRef.current.forEach((group) => {
        scene.remove(group);
        group.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry?.dispose();
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.forEach((m) => m.dispose());
          }
        });
      });
      loadedModelsRef.current.clear();
    };
  }, [scene, presentation, fitToBox]);

  // Update model visibility when slide changes
  const updateSlideVisibility = useCallback((slideIndex: number) => {
    const slide = presentation.slides[slideIndex];
    if (!slide) return;

    const visibleIds = new Set(slide.modelIds);
    loadedModelsRef.current.forEach((group, modelId) => {
      // If slide has no models assigned, show all
      group.visible = visibleIds.size === 0 || visibleIds.has(modelId);
    });

    // Apply section cut
    if (slide.sectionCut?.enabled) {
      setSectionPlane(slide.sectionCut.height);
    } else {
      setSectionPlane(null);
    }
  }, [presentation.slides, setSectionPlane]);

  // Update hotspot meshes when slide changes
  useEffect(() => {
    if (!scene) return;

    // Remove old hotspot meshes
    hotspotMeshesRef.current.forEach((mesh) => {
      scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    hotspotMeshesRef.current.clear();

    // Create new hotspot meshes for active slide
    const slide = presentation.slides[activeSlideIndex];
    if (!slide) return;

    slide.hotspots.forEach((hotspot) => {
      const geo = new THREE.SphereGeometry(0.15, 16, 16);
      const mat = new THREE.MeshStandardMaterial({
        color: hotspot.color || '#3b82f6',
        emissive: hotspot.color || '#3b82f6',
        emissiveIntensity: 0.5,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(hotspot.position.x, hotspot.position.y, hotspot.position.z);
      mesh.name = `hotspot-${hotspot.id}`;
      mesh.userData.hotspotId = hotspot.id;
      scene.add(mesh);
      hotspotMeshesRef.current.set(hotspot.id, mesh);
    });

    return () => {
      hotspotMeshesRef.current.forEach((mesh) => {
        scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      });
      hotspotMeshesRef.current.clear();
    };
  }, [scene, activeSlideIndex, presentation.slides]);

  // Handle slide change
  const goToSlide = useCallback((index: number) => {
    if (index < 0 || index >= presentation.slides.length) return;
    setActiveSlideIndex(index);
    setActiveHotspotId(null);
    updateSlideVisibility(index);
  }, [presentation.slides.length, updateSlideVisibility]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        goToSlide(activeSlideIndex + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        goToSlide(activeSlideIndex - 1);
      } else if (e.key === 'Escape') {
        setActiveHotspotId(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSlideIndex, goToSlide]);

  // Handle click on viewport for hotspot interaction
  const handleViewportClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!camera || !scene) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    // Check hotspot intersections
    const hotspotMeshes = Array.from(hotspotMeshesRef.current.values());
    const intersects = raycaster.intersectObjects(hotspotMeshes);

    if (intersects.length > 0) {
      const hotspotId = intersects[0].object.userData.hotspotId;
      const hotspot = activeSlide?.hotspots.find(h => h.id === hotspotId);
      if (hotspot) {
        setActiveHotspotId(hotspotId);

        // Animate camera to saved view
        if (hotspot.savedView && controls) {
          const target = new THREE.Vector3(
            hotspot.savedView.target.x,
            hotspot.savedView.target.y,
            hotspot.savedView.target.z
          );
          const position = new THREE.Vector3(
            hotspot.savedView.position.x,
            hotspot.savedView.position.y,
            hotspot.savedView.position.z
          );

          // Simple animation
          const startPos = camera.position.clone();
          const startTarget = controls.target.clone();
          const duration = 800;
          const startTime = Date.now();

          const animate = () => {
            const elapsed = Date.now() - startTime;
            const t = Math.min(elapsed / duration, 1);
            const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

            camera.position.lerpVectors(startPos, position, ease);
            controls.target.lerpVectors(startTarget, target, ease);
            controls.update();

            if (t < 1) requestAnimationFrame(animate);
          };
          animate();
        }

        // Activate section cut if linked
        if (hotspot.sectionCutAction?.enabled) {
          setSectionPlane(hotspot.sectionCutAction.height);
        }
      }
    } else {
      setActiveHotspotId(null);
    }
  }, [camera, scene, controls, activeSlide, setSectionPlane]);

  // Close hotspot popup
  const closeHotspot = useCallback(() => {
    const hotspot = activeSlide?.hotspots.find(h => h.id === activeHotspotId);
    setActiveHotspotId(null);
    // Deactivate section cut if hotspot had one
    if (hotspot?.sectionCutAction?.enabled) {
      const slide = presentation.slides[activeSlideIndex];
      if (slide?.sectionCut?.enabled) {
        setSectionPlane(slide.sectionCut.height);
      } else {
        setSectionPlane(null);
      }
    }
  }, [activeHotspotId, activeSlide, activeSlideIndex, presentation.slides, setSectionPlane]);

  return (
    <div className="flex flex-col h-screen w-full bg-gray-100">
      {/* Header */}
      <header className="bg-white border-b h-12 flex items-center px-6 shrink-0 z-50 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-gradient-to-br from-blue-600 to-indigo-700 rounded-lg flex items-center justify-center text-white font-bold text-sm shadow-sm">P</div>
          <span className="font-bold text-base text-gray-900">Prototype</span>
        </div>
        <span className="mx-3 text-gray-300">/</span>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-gray-700 truncate">{presentation.name}</span>
          {presentation.description && (
            <span className="text-xs text-gray-400 ml-3 hidden sm:inline">{presentation.description}</span>
          )}
        </div>
        {presentation.pdfFilename && (
          <button onClick={() => setPdfPanelOpen(!pdfPanelOpen)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all shadow-sm ${
              pdfPanelOpen
                ? 'bg-gray-700 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-200'
            }`}>
            <FileText size={16} />
            <span>PDF</span>
          </button>
        )}
      </header>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Left sidebar: slides */}
        <div className="w-56 bg-white border-r flex flex-col shrink-0">
          <div className="p-3 border-b bg-gray-50">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Slides</h3>
          </div>
          <div className="flex-1 overflow-auto p-2 space-y-1.5">
            {presentation.slides.map((slide, index) => (
              <button
                key={slide.id}
                onClick={() => goToSlide(index)}
                className={`w-full text-left p-3 rounded-lg transition-all ${
                  index === activeSlideIndex
                    ? 'bg-blue-50 border-2 border-blue-500 shadow-sm'
                    : 'bg-gray-50 border-2 border-transparent hover:bg-gray-100 hover:border-gray-200'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-bold w-6 h-6 rounded-full flex items-center justify-center ${
                    index === activeSlideIndex ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-600'
                  }`}>{index + 1}</span>
                  <span className={`text-xs font-medium truncate ${
                    index === activeSlideIndex ? 'text-blue-700' : 'text-gray-700'
                  }`}>{slide.name}</span>
                </div>
                {slide.hotspots.length > 0 && (
                  <div className="mt-1.5 ml-8 text-[10px] text-gray-400">
                    {slide.hotspots.length} hotspot{slide.hotspots.length !== 1 ? 's' : ''}
                  </div>
                )}
              </button>
            ))}
          </div>

          {/* Slide navigation */}
          <div className="p-3 border-t bg-gray-50 flex items-center justify-between">
            <button onClick={() => goToSlide(activeSlideIndex - 1)}
              disabled={activeSlideIndex === 0}
              className="p-1.5 rounded-md hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              <ChevronLeft size={16} />
            </button>
            <span className="text-xs text-gray-500 font-medium">
              {activeSlideIndex + 1} / {presentation.slides.length}
            </span>
            <button onClick={() => goToSlide(activeSlideIndex + 1)}
              disabled={activeSlideIndex === presentation.slides.length - 1}
              className="p-1.5 rounded-md hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              <ChevronRight size={16} />
            </button>
          </div>
        </div>

        {/* 3D Viewport */}
        <div className="flex-1 relative" onClick={handleViewportClick}>
          <ViewerCanvas />

          {/* Hotspot popup */}
          {activeHotspot && (
            <div className="absolute top-4 left-4 bg-white rounded-xl shadow-2xl border border-gray-200 max-w-sm z-20 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: activeHotspot.color || '#3b82f6' }} />
                  <h3 className="font-semibold text-sm text-gray-900">{activeHotspot.name}</h3>
                </div>
                <button onClick={(e) => { e.stopPropagation(); closeHotspot(); }}
                  className="p-1 rounded-md hover:bg-gray-100 text-gray-400">
                  <X size={14} />
                </button>
              </div>
              {activeHotspot.description && (
                <div className="px-4 py-3 text-sm text-gray-600">
                  {activeHotspot.description}
                </div>
              )}
              {activeHotspot.linkedImage && (
                <div className="border-t border-gray-100">
                  <img src={activeHotspot.linkedImage} alt={activeHotspot.name} className="w-full h-auto max-h-48 object-cover" />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right panel: PDF */}
        {pdfPanelOpen && presentation.pdfFilename && (
          <div className="w-80 bg-white border-l shadow-xl flex flex-col shrink-0 h-full">
            <div className="p-4 border-b flex items-center justify-between shrink-0">
              <h3 className="font-bold text-sm flex items-center gap-2">
                <FileText size={16} className="text-blue-600" />
                PDF Document
              </h3>
              <button onClick={() => setPdfPanelOpen(false)}
                className="p-1.5 hover:bg-gray-100 rounded transition-colors" title="Close panel">
                <PanelRightClose size={16} />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <iframe
                src={presentation.pdfUrl || `/api/share/${presentation.id}/files/${presentation.pdfFilename}`}
                className="w-full h-full border-0"
                title="PDF Document"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Main page component
export default function SharedPresentationPage() {
  const params = useParams();
  const id = params?.id as string;
  const [presentation, setPresentation] = useState<SharedPresentation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;

    fetch(`/api/share/${id}`)
      .then(res => {
        if (!res.ok) throw new Error('Presentation not found');
        return res.json();
      })
      .then((data: SharedPresentation) => {
        setPresentation(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-sm text-gray-500 font-medium">Loading presentation...</p>
        </div>
      </div>
    );
  }

  if (error || !presentation) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-center max-w-md mx-4">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <X size={32} className="text-red-500" />
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">Presentation Not Found</h1>
          <p className="text-sm text-gray-500">
            {error || 'This presentation may have been removed or the link may be incorrect.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <ViewerProvider>
      <SharedViewerContent presentation={presentation} />
    </ViewerProvider>
  );
}
