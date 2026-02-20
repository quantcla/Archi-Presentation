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
  const [panoramaImage, setPanoramaImage] = useState<string | null>(null);
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

            // Apply render-style materials and shadows
            group.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                child.castShadow = true;
                child.receiveShadow = true;

                // Apply clean render material using the mesh's existing color
                const existingMat = child.material as THREE.MeshStandardMaterial;
                const baseColor = existingMat?.color ? existingMat.color.clone() : new THREE.Color(0xffffff);
                const opacity = existingMat?.opacity ?? 1.0;

                const renderMat = new THREE.MeshStandardMaterial({
                  color: baseColor,
                  roughness: 0.7,
                  metalness: 0.0,
                  transparent: opacity < 1,
                  opacity: opacity,
                });
                child.material = renderMat;
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
      const box = new THREE.Box3();
      loadedModelsRef.current.forEach((group) => {
        box.expandByObject(group);
      });
      if (!box.isEmpty()) {
        fitToBox(box);
      }
      updateSlideVisibility(0);
    });

    return () => {
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

  // Section plane wrapper: applies clipping but removes grey cap meshes
  const applySectionCut = useCallback((y: number | null) => {
    setSectionPlane(y);
    // Remove the grey cap meshes created by ViewerContext — they look bad in shared view
    if (scene) {
      const capsToRemove: THREE.Object3D[] = [];
      scene.traverse((obj) => {
        if (obj.name === 'sectionCapMesh' || obj.name === 'sectionCapGroup') {
          capsToRemove.push(obj);
        }
      });
      capsToRemove.forEach((cap) => {
        scene.remove(cap);
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
    }
  }, [scene, setSectionPlane]);

  // Update model visibility when slide changes
  const updateSlideVisibility = useCallback((slideIndex: number) => {
    const slide = presentation.slides[slideIndex];
    if (!slide) return;

    const visibleIds = new Set(slide.modelIds);
    loadedModelsRef.current.forEach((group, modelId) => {
      group.visible = visibleIds.size === 0 || visibleIds.has(modelId);
    });

    if (slide.sectionCut?.enabled) {
      applySectionCut(slide.sectionCut.height);
    } else {
      applySectionCut(null);
    }
  }, [presentation.slides, applySectionCut]);

  // Update hotspot meshes when slide changes
  useEffect(() => {
    if (!scene) return;

    hotspotMeshesRef.current.forEach((mesh) => {
      scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    hotspotMeshesRef.current.clear();

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
        if (panoramaImage) {
          const container = document.querySelector('[data-pano-initialized="true"]') as any;
          if (container?._panoCleanup) container._panoCleanup();
          setPanoramaImage(null);
        } else {
          setActiveHotspotId(null);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSlideIndex, goToSlide, panoramaImage]);

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

    const hotspotMeshes = Array.from(hotspotMeshesRef.current.values());
    const intersects = raycaster.intersectObjects(hotspotMeshes);

    if (intersects.length > 0) {
      const hotspotId = intersects[0].object.userData.hotspotId;
      const hotspot = activeSlide?.hotspots.find(h => h.id === hotspotId);
      if (hotspot) {
        setActiveHotspotId(hotspotId);

        // Animate camera to saved view (skip if 360 — will open panorama instead)
        if (hotspot.savedView && controls && !hotspot.linked360Image) {
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
          applySectionCut(hotspot.sectionCutAction.height);
        }
      }
    } else {
      setActiveHotspotId(null);
    }
  }, [camera, scene, controls, activeSlide, applySectionCut]);

  // Close hotspot popup
  const closeHotspot = useCallback(() => {
    const hotspot = activeSlide?.hotspots.find(h => h.id === activeHotspotId);
    setActiveHotspotId(null);
    if (hotspot?.sectionCutAction?.enabled) {
      const slide = presentation.slides[activeSlideIndex];
      if (slide?.sectionCut?.enabled) {
        applySectionCut(slide.sectionCut.height);
      } else {
        applySectionCut(null);
      }
    }
  }, [activeHotspotId, activeSlide, activeSlideIndex, presentation.slides, applySectionCut]);

  const hasImage = activeHotspot ? !!activeHotspot.linkedImage : false;

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
        <div className="flex-1 relative min-w-0" onClick={handleViewportClick}>
          <ViewerCanvas />

          {/* Hotspot popup — centered at bottom, matching main app style */}
          {activeHotspot && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 bg-white rounded-xl shadow-xl border border-orange-200 overflow-hidden flex" style={{ minWidth: hasImage ? '560px' : '280px', maxWidth: '900px' }}>
              {/* Left Side - Info */}
              <div className="flex-1 min-w-[280px]">
                {/* Header */}
                <div className="bg-gradient-to-r from-orange-50 to-orange-100 px-4 py-3 border-b border-orange-200">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-5 h-5 rounded-full shadow-sm border border-white/50"
                        style={{ backgroundColor: activeHotspot.color || '#3b82f6' }}
                      />
                      <h3 className="font-semibold text-gray-800">{activeHotspot.name}</h3>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); closeHotspot(); }}
                      className="p-1 text-gray-400 hover:text-gray-600 hover:bg-white/50 rounded transition"
                    >
                      <X size={18} />
                    </button>
                  </div>
                </div>

                {/* Description */}
                {activeHotspot.description && (
                  <div className="px-4 py-2 border-b border-gray-100">
                    <p className="text-sm text-gray-600 whitespace-pre-wrap">{activeHotspot.description}</p>
                  </div>
                )}

                {/* Section Cut Info */}
                {activeHotspot.sectionCutAction?.enabled && (
                  <div className="px-4 py-3 space-y-2 border-b border-gray-100">
                    <div className="flex items-center gap-2 text-sm">
                      <div className="w-6 h-6 rounded bg-blue-100 flex items-center justify-center">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2">
                          <path d="M2 12h20"/>
                          <path d="M6 8l-4 4 4 4"/>
                          <path d="M18 8l4 4-4 4"/>
                        </svg>
                      </div>
                      <span className="text-gray-600">Section Cut</span>
                      <span className="ml-auto font-medium text-blue-600">
                        {activeHotspot.sectionCutAction.height.toFixed(1)}m
                      </span>
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="px-4 py-3 bg-gray-50 flex items-center justify-end gap-2">
                  {activeHotspot.linked360Image && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setPanoramaImage(activeHotspot.linked360Image!); }}
                      className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-medium rounded-lg transition flex items-center gap-2 shadow-sm"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M2 12h20"/>
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                      </svg>
                      View 360°
                    </button>
                  )}
                </div>
              </div>

              {/* Right Side - Image */}
              {hasImage && (
                <div
                  className="border-l border-gray-200 bg-gray-50 flex items-center justify-center p-3"
                  style={{ width: '280px', minWidth: '150px' }}
                >
                  <img
                    src={activeHotspot.linkedImage}
                    alt={activeHotspot.name}
                    className="max-w-full max-h-[200px] object-contain rounded-lg shadow-sm"
                    draggable={false}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right panel: PDF */}
        {pdfPanelOpen && presentation.pdfFilename && (
          <div className="w-[400px] bg-white border-l shadow-xl flex flex-col shrink-0" style={{ height: '100%' }}>
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
            <div className="flex-1 min-h-0 overflow-hidden">
              <iframe
                src={presentation.pdfUrl || `/api/share/${presentation.id}/files/${presentation.pdfFilename}`}
                className="w-full h-full border-0"
                title="PDF Document"
              />
            </div>
          </div>
        )}
      </div>

      {/* 360 Panorama Viewer */}
      {panoramaImage && (
        <div className="fixed inset-0 z-[110] bg-black">
          <div
            ref={(containerEl) => {
              if (!containerEl || containerEl.dataset.panoInitialized) return;
              containerEl.dataset.panoInitialized = 'true';

              const panoScene = new THREE.Scene();
              const panoCamera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
              panoCamera.position.set(0, 0, 0.01);

              const panoRenderer = new THREE.WebGLRenderer({ antialias: true });
              panoRenderer.setSize(window.innerWidth, window.innerHeight);
              panoRenderer.setPixelRatio(window.devicePixelRatio);
              containerEl.appendChild(panoRenderer.domElement);

              const geometry = new THREE.SphereGeometry(500, 60, 40);
              geometry.scale(-1, 1, 1);
              const texture = new THREE.TextureLoader().load(panoramaImage!);
              texture.colorSpace = THREE.SRGBColorSpace;
              const material = new THREE.MeshBasicMaterial({ map: texture });
              const sphere = new THREE.Mesh(geometry, material);
              panoScene.add(sphere);

              let lon = 0, lat = 0;
              let isDown = false;
              let startX = 0, startY = 0;
              let startLon = 0, startLat = 0;

              const onPointerDown = (e: PointerEvent) => {
                isDown = true;
                startX = e.clientX;
                startY = e.clientY;
                startLon = lon;
                startLat = lat;
              };
              const onPointerMove = (e: PointerEvent) => {
                if (!isDown) return;
                lon = (startX - e.clientX) * 0.2 + startLon;
                lat = (e.clientY - startY) * 0.2 + startLat;
                lat = Math.max(-85, Math.min(85, lat));
              };
              const onPointerUp = () => { isDown = false; };

              const onWheel = (e: WheelEvent) => {
                const fov = panoCamera.fov + e.deltaY * 0.05;
                panoCamera.fov = Math.max(30, Math.min(100, fov));
                panoCamera.updateProjectionMatrix();
              };

              const dom = panoRenderer.domElement;
              dom.addEventListener('pointerdown', onPointerDown);
              dom.addEventListener('pointermove', onPointerMove);
              dom.addEventListener('pointerup', onPointerUp);
              dom.addEventListener('pointerleave', onPointerUp);
              dom.addEventListener('wheel', onWheel);

              const onResize = () => {
                panoCamera.aspect = window.innerWidth / window.innerHeight;
                panoCamera.updateProjectionMatrix();
                panoRenderer.setSize(window.innerWidth, window.innerHeight);
              };
              window.addEventListener('resize', onResize);

              let animId = 0;
              const animate = () => {
                animId = requestAnimationFrame(animate);
                const phi = THREE.MathUtils.degToRad(90 - lat);
                const theta = THREE.MathUtils.degToRad(lon);
                const target = new THREE.Vector3(
                  500 * Math.sin(phi) * Math.cos(theta),
                  500 * Math.cos(phi),
                  500 * Math.sin(phi) * Math.sin(theta)
                );
                panoCamera.lookAt(target);
                panoRenderer.render(panoScene, panoCamera);
              };
              animate();

              (containerEl as any)._panoCleanup = () => {
                cancelAnimationFrame(animId);
                dom.removeEventListener('pointerdown', onPointerDown);
                dom.removeEventListener('pointermove', onPointerMove);
                dom.removeEventListener('pointerup', onPointerUp);
                dom.removeEventListener('pointerleave', onPointerUp);
                dom.removeEventListener('wheel', onWheel);
                window.removeEventListener('resize', onResize);
                panoRenderer.dispose();
                geometry.dispose();
                material.dispose();
                texture.dispose();
              };
            }}
            className="w-full h-full"
            style={{ cursor: 'grab' }}
            onMouseDown={(e) => { (e.target as HTMLElement).style.cursor = 'grabbing'; }}
            onMouseUp={(e) => { (e.target as HTMLElement).style.cursor = 'grab'; }}
          />
          {/* Close button */}
          <button
            onClick={() => {
              const container = document.querySelector('[data-pano-initialized="true"]') as any;
              if (container?._panoCleanup) container._panoCleanup();
              setPanoramaImage(null);
            }}
            className="absolute top-6 right-6 p-3 bg-black/50 hover:bg-black/70 text-white rounded-full transition-colors z-10"
            title="Close 360° view"
          >
            <X size={24} />
          </button>
          {/* 360 badge */}
          <div className="absolute top-6 left-6 px-3 py-1.5 bg-black/50 text-white rounded-full text-sm font-bold flex items-center gap-2 z-10">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M2 12h20"/>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
            </svg>
            360° Panorama
          </div>
          {/* Instructions */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-white/60 text-sm z-10">
            Drag to look around · Scroll to zoom · ESC to close
          </div>
        </div>
      )}
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
