"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { getProject, updateProject as updateProjectData } from './lib/projects';
import * as THREE from 'three';
import { 
  ArchitecturalElement, Wall, WindowElement, Door, 
  ToolType, WindowType, DoorType, WallJustification, ElementFactory, Point, 
  generateRectPolygon, getDistance, projectPointOnLine, 
  resizeElement, getLineIntersection, arePointsEqual 
} from './shapes'; 
import {
  MousePointer2, Square, DoorOpen, Component, PenTool,
  Upload, Settings, ArrowRight, Download, Ruler, ScanLine, AlignCenter, AlignLeft, AlignRight, Save, Check,
  Undo, Redo, Trash2, Crosshair, Type, Eye, EyeOff, Move,
  PenLine, Hammer, PlayCircle, ChevronRight, ChevronLeft, FileText, Box, File as FileIcon, Loader2,
  PanelRightOpen, PanelRightClose, FolderOpen, FileDown, Focus, X, List, Share2, Copy, CheckCircle
} from 'lucide-react';

// --- IMPORT VIEWER COMPONENTS ---
import { ViewerProvider, useViewer, ViewerCanvas } from './components/viewer/core/ViewerContext';
import { FloorManager } from './components/viewer/floors/FloorManager';
import { ViewerSidebar, MeasureToolMode } from './components/viewer/ui/Sidebar';
import { MeasurementManager, MeasurementPoint, Measurement } from './components/viewer/tools/MeasurementTool';
import { ObjectManager, PlacedObject } from './components/viewer/tools/ObjectManager';

// ===========================================
// CONSTANTS & HELPERS
// ===========================================
const SIZES = {
  A4: { w: 2970, h: 2100, label: "A4 (1:100)" }, 
  A3: { w: 4200, h: 2970, label: "A3 (1:100)" }
};
const PIXELS_PER_METER = 100;
enum MeasureMode { CENTER = 'CENTER', INNER = 'INNER', OUTER = 'OUTER' }

const getVisualWallLength = (target: Wall, allElements: ArchitecturalElement[], mode: MeasureMode): string => {
  if (mode === MeasureMode.CENTER) return (target.length / PIXELS_PER_METER).toFixed(2);
  const findNeighbor = (pt: Point) => allElements.find(el => el !== target && el instanceof Wall && (getDistance(el.start, pt) < 5 || getDistance(el.end, pt) < 5)) as Wall | undefined;
  const startNeighbor = findNeighbor(target.start);
  const endNeighbor = findNeighbor(target.end);
  let pStart = target.start;
  let pEnd = target.end;
  const getCornerPoint = (commonNode: Point, neighbor: Wall, isStartNode: boolean) => {
    const tCorners = target.corners;
    const nCorners = neighbor.corners;
    const linesT = [ {p1: tCorners[0], p2: tCorners[1]}, {p1: tCorners[3], p2: tCorners[2]} ];
    const linesN = [ {p1: nCorners[0], p2: nCorners[1]}, {p1: nCorners[3], p2: nCorners[2]} ];
    let inters: Point[] = [];
    for(let l1 of linesT) {
      for(let l2 of linesN) {
        const pt = getLineIntersection(l1.p1, l1.p2, l2.p1, l2.p2);
        if(pt) inters.push(pt);
      }
    }
    if (inters.length === 0) return commonNode;
    inters = inters.filter(p => getDistance(p, commonNode) < Math.max(target.thickness, neighbor.thickness) * 3);
    if (inters.length === 0) return commonNode;
    inters.sort((a,b) => getDistance(a, commonNode) - getDistance(b, commonNode));
    if (mode === MeasureMode.OUTER) return inters[inters.length - 1]; 
    if (mode === MeasureMode.INNER) return inters[0]; 
    return commonNode;
  };
  if (startNeighbor) pStart = getCornerPoint(target.start, startNeighbor, true);
  if (endNeighbor) pEnd = getCornerPoint(target.end, endNeighbor, false);
  return (getDistance(pStart, pEnd) / PIXELS_PER_METER).toFixed(2);
};

const CornerFixer = ({ elements, selectedId }: { elements: ArchitecturalElement[], selectedId: number | null }) => {
  const joints = useMemo(() => {
    const walls = elements.filter(el => el instanceof Wall) as Wall[];
    const patches: React.ReactElement[] = [];
    const vertexMap = new Map<string, { wall: Wall, isStart: boolean }[]>();
    walls.forEach(w => {
      const startKey = `${Math.round(w.start.x)},${Math.round(w.start.y)}`;
      const endKey = `${Math.round(w.end.x)},${Math.round(w.end.y)}`;
      if (!vertexMap.has(startKey)) vertexMap.set(startKey, []);
      if (!vertexMap.has(endKey)) vertexMap.set(endKey, []);
      vertexMap.get(startKey)?.push({ wall: w, isStart: true });
      vertexMap.get(endKey)?.push({ wall: w, isStart: false });
    });
    vertexMap.forEach((connections, key) => {
      if (connections.length === 2) {
        const c1 = connections[0];
        const c2 = connections[1];
        const poly1 = c1.wall.corners; 
        const poly2 = c2.wall.corners;
        const w1Top = { p1: poly1[0], p2: poly1[1] };
        const w1Bot = { p1: poly1[3], p2: poly1[2] };
        const w2Top = { p1: poly2[0], p2: poly2[1] };
        const w2Bot = { p1: poly2[3], p2: poly2[2] };
        const inters = [
          getLineIntersection(w1Top.p1, w1Top.p2, w2Top.p1, w2Top.p2),
          getLineIntersection(w1Top.p1, w1Top.p2, w2Bot.p1, w2Bot.p2),
          getLineIntersection(w1Bot.p1, w1Bot.p2, w2Top.p1, w2Top.p2),
          getLineIntersection(w1Bot.p1, w1Bot.p2, w2Bot.p1, w2Bot.p2) 
        ].filter(p => p !== null) as Point[];
        const [jx, jy] = key.split(',').map(Number);
        const center = { x: jx, y: jy };
        const validMiter = inters.filter(p => {
            const d = getDistance(p, center);
            return d > 0.1 && d < Math.max(c1.wall.thickness, c2.wall.thickness) * 2;
        });
        if (validMiter.length > 0) {
           const w1PointsAtJoint = c1.isStart ? [poly1[0], poly1[3]] : [poly1[1], poly1[2]];
           const w2PointsAtJoint = c2.isStart ? [poly2[0], poly2[3]] : [poly2[1], poly2[2]];
           const patchPoints = [...w1PointsAtJoint, ...w2PointsAtJoint, ...validMiter];
           patchPoints.sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
           const polyStr = patchPoints.map(p => `${p.x},${p.y}`).join(' ');
           const isSelected = c1.wall.id === selectedId || c2.wall.id === selectedId;
           const fill = isSelected ? '#334155' : '#000000';
           patches.push(<polygon key={`patch-${key}`} points={polyStr} fill={fill} stroke="none" />);
        }
      }
    });
    return patches;
  }, [elements, selectedId]);
  return <g id="corner-fixes">{joints}</g>;
};

const DimensionOverlay = ({ start, end, wall, fontSize }: { start: Point, end: Point, wall: Wall, fontSize: number }) => {
  const pStart = projectPointOnLine(start, wall.start, wall.end);
  const pEnd = projectPointOnLine(end, wall.start, wall.end);
  const dStartToWallStart = getDistance(pStart, wall.start);
  const dEndToWallStart = getDistance(pEnd, wall.start);
  let dist1 = 0; let dist2 = 0; let p1: Point, pAnchor1: Point; let p2: Point, pAnchor2: Point;
  if (dStartToWallStart < dEndToWallStart) {
     dist1 = dStartToWallStart; p1 = pStart; pAnchor1 = wall.start; dist2 = getDistance(pEnd, wall.end); p2 = pEnd; pAnchor2 = wall.end;
  } else {
     dist1 = dEndToWallStart; p1 = pEnd; pAnchor1 = wall.start; dist2 = getDistance(pStart, wall.end); p2 = pStart; pAnchor2 = wall.end;
  }
  const m1 = (dist1 / PIXELS_PER_METER).toFixed(2);
  const m2 = (dist2 / PIXELS_PER_METER).toFixed(2);
  return (
    <g pointerEvents="none">
        <line x1={pAnchor1.x} y1={pAnchor1.y} x2={p1.x} y2={p1.y} stroke="#2563eb" strokeWidth="1" strokeDasharray="4,2" />
        <circle cx={p1.x} cy={p1.y} r="2" fill="#2563eb" />
        <text x={(pAnchor1.x + p1.x)/2} y={(pAnchor1.y + p1.y)/2 - 5} fontSize={Math.max(10, fontSize - 2)} fill="#2563eb" fontWeight="bold" textAnchor="middle">{m1}m</text>
        <line x1={p2.x} y1={p2.y} x2={pAnchor2.x} y2={pAnchor2.y} stroke="#2563eb" strokeWidth="1" strokeDasharray="4,2" />
        <circle cx={p2.x} cy={p2.y} r="2" fill="#2563eb" />
        <text x={(p2.x + pAnchor2.x)/2} y={(p2.y + pAnchor2.y)/2 - 5} fontSize={Math.max(10, fontSize - 2)} fill="#2563eb" fontWeight="bold" textAnchor="middle">{m2}m</text>
    </g>
  );
};

// ===========================================
// PROJECT FILE TYPE & DRAG STATE
// ===========================================
// Module-level ref for drag-and-drop (dataTransfer only holds strings)
let draggedProjectFile: ProjectFile | null = null;

interface ProjectFile {
  id: string;
  name: string;
  type: 'dxf' | 'svg' | 'pdf' | 'png' | 'jpg' | 'glb' | 'ifc';
  content?: string; // base64 for images, text for others
  url?: string; // For blob URLs (GLB files)
  blob?: Blob; // For binary files
  createdAt: Date;
  source: 'construction' | 'simulation' | 'drawing' | 'elemente';
}

// ===========================================
// PROJECT FILES PANEL COMPONENT
// ===========================================
const ProjectFilesPanel: React.FC<{
  projectFiles: ProjectFile[];
  onRemoveFile?: (id: string) => void;
  onClose: () => void;
  // Optional: include generated files from construction tab (server-hosted files)
  generatedFiles?: Array<{ name: string; path: string }>;
  onDownloadGeneratedFile?: (file: { name: string; path: string }) => void;
}> = ({
  projectFiles,
  onRemoveFile,
  onClose,
  generatedFiles,
  onDownloadGeneratedFile
}) => {
  const [expandedImages, setExpandedImages] = useState<Set<string>>(new Set());

  const toggleImageExpanded = (id: string) => {
    setExpandedImages(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Helper to get download URL for a file
  const getDownloadUrl = (file: ProjectFile): string => {
    if (file.url) return file.url;
    if (file.content) {
      if (file.type === 'dxf') return `data:application/dxf;base64,${btoa(file.content)}`;
      if (file.type === 'svg') return `data:image/svg+xml;base64,${btoa(file.content)}`;
      return file.content; // Already a data URL for images
    }
    return '';
  };

  const imageFiles = projectFiles.filter(f => f.type === 'png' || f.type === 'jpg');
  const dxfFiles = projectFiles.filter(f => f.type === 'dxf');
  const modelFiles = projectFiles.filter(f => f.type === 'glb' || f.type === 'ifc');

  return (
    <div className="w-72 bg-white border-l shadow-xl flex flex-col shrink-0">
      <div className="p-4 border-b flex items-center justify-between">
        <h3 className="font-bold text-sm flex items-center gap-2">
          <FolderOpen size={16} />
          Project Files
        </h3>
        <button
          onClick={onClose}
          className="p-1.5 hover:bg-gray-100 rounded transition-colors"
          title="Close panel"
        >
          <PanelRightClose size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* 3D Model Files (from construction) */}
        {generatedFiles && generatedFiles.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-gray-500 uppercase mb-2">3D Models</h4>
            <div className="space-y-1">
              {generatedFiles.map((file, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between p-2 bg-gray-50 rounded border hover:bg-gray-100 transition-colors"
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <FileIcon size={14} className="shrink-0 text-gray-500" />
                    <span className="text-xs truncate">{file.name}</span>
                  </div>
                  {onDownloadGeneratedFile && (
                    <button
                      onClick={() => onDownloadGeneratedFile(file)}
                      className="p-1 hover:bg-gray-200 rounded text-blue-600"
                      title="Download"
                    >
                      <Download size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Screenshots */}
        {imageFiles.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-gray-500 uppercase mb-2">Screenshots ({imageFiles.length})</h4>
            <div className="space-y-1">
              {imageFiles.map(file => {
                const isExpanded = expandedImages.has(file.id);
                return (
                  <div
                    key={file.id}
                    className="rounded border border-gray-200 overflow-hidden"
                    draggable
                    onDragStart={(e) => {
                      // Pass full file data for hotspot image linking
                      e.dataTransfer.setData('application/project-file', JSON.stringify({
                        id: file.id,
                        name: file.name,
                        type: file.type,
                        content: file.content
                      }));
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                  >
                    {/* Collapsed view - just the name */}
                    <div
                      className="flex items-center justify-between p-2 bg-gray-50 hover:bg-gray-100 cursor-grab active:cursor-grabbing transition-colors"
                      onClick={() => toggleImageExpanded(file.id)}
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          className={`shrink-0 text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                        >
                          <path d="m9 18 6-6-6-6"/>
                        </svg>
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-blue-500">
                          <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
                          <circle cx="9" cy="9" r="2"/>
                          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
                        </svg>
                        <span className="text-xs truncate">{file.name}</span>
                      </div>
                      <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                        <a
                          href={getDownloadUrl(file)}
                          download={file.name}
                          className="p-1 hover:bg-gray-200 rounded text-blue-600"
                          title="Download"
                        >
                          <Download size={14} />
                        </a>
                        {onRemoveFile && (
                          <button
                            onClick={() => onRemoveFile(file.id)}
                            className="p-1 hover:bg-red-100 rounded text-red-500"
                            title="Delete"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Expanded view - show preview */}
                    {isExpanded && file.content && (
                      <div className="border-t border-gray-200">
                        <img
                          src={file.content}
                          alt={file.name}
                          className="w-full h-auto"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* DXF Files from project */}
        {dxfFiles.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-gray-500 uppercase mb-2">DXF Files ({dxfFiles.length})</h4>
            <div className="space-y-1">
              {dxfFiles.map(file => {
                const isElevation = file.name.startsWith('elevation_');
                return (
                  <div
                    key={file.id}
                    className={`flex items-center justify-between p-2 rounded border transition-colors ${
                      isElevation
                        ? 'bg-indigo-50 border-indigo-200 hover:bg-indigo-100'
                        : 'bg-gray-50 hover:bg-gray-100'
                    }`}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <FileIcon size={14} className={`shrink-0 ${isElevation ? 'text-indigo-500' : 'text-gray-500'}`} />
                      <span className={`text-xs truncate ${isElevation ? 'text-indigo-700' : ''}`}>{file.name}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <a
                        href={getDownloadUrl(file)}
                        download={file.name}
                        className={`p-1 rounded ${isElevation ? 'hover:bg-indigo-200 text-indigo-600' : 'hover:bg-gray-200 text-blue-600'}`}
                        title="Download"
                      >
                        <Download size={14} />
                      </a>
                      {onRemoveFile && (
                        <button
                          onClick={() => onRemoveFile(file.id)}
                          className="p-1 hover:bg-red-100 rounded text-red-500"
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* GLB/IFC Model Files */}
        {modelFiles.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-gray-500 uppercase mb-2">3D Models ({modelFiles.length})</h4>
            <div className="space-y-1">
              {modelFiles.map(file => (
                <div
                  key={file.id}
                  draggable
                  onDragStart={(e) => {
                    draggedProjectFile = file;
                    e.dataTransfer.setData('application/project-file', file.id);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onDragEnd={() => { draggedProjectFile = null; }}
                  className="flex items-center justify-between p-2 bg-purple-50 border border-purple-200 rounded hover:bg-purple-100 transition-colors cursor-grab active:cursor-grabbing"
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Box size={14} className="shrink-0 text-purple-500" />
                    <span className="text-xs truncate text-purple-700">{file.name}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <a
                      href={getDownloadUrl(file)}
                      download={file.name}
                      className="p-1 rounded hover:bg-purple-200 text-purple-600"
                      title="Download"
                    >
                      <Download size={14} />
                    </a>
                    {onRemoveFile && (
                      <button
                        onClick={() => onRemoveFile(file.id)}
                        className="p-1 hover:bg-red-100 rounded text-red-500"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {(!generatedFiles || generatedFiles.length === 0) &&
         imageFiles.length === 0 &&
         dxfFiles.length === 0 &&
         modelFiles.length === 0 && (
          <div className="text-center text-gray-400 text-sm py-8">
            No files yet.<br/>Generate models, create elevations, or capture images.
          </div>
        )}
      </div>
    </div>
  );
};

// ===========================================
// MAIN APP
// ===========================================
// Suspense wrapper for useSearchParams
export default function WorkflowAppWrapper() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen bg-gray-100"><div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>}>
      <WorkflowApp />
    </Suspense>
  );
}

function WorkflowApp() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get('project');
  const [projectName, setProjectName] = useState<string | null>(null);

  // Load project name from localStorage when projectId changes
  useEffect(() => {
    if (projectId) {
      const project = getProject(projectId);
      setProjectName(project?.name ?? null);
      // Update the project's updatedAt timestamp
      if (project) {
        updateProjectData(projectId, {});
      }
    } else {
      setProjectName(null);
    }
  }, [projectId]);

  const [activeTab, setActiveTab] = useState<1 | 2 | 3>(1);
  const [conversionResult, setConversionResult] = useState<any>(null);
  // State to pass building data from Konstruktion to Simulation
  const [simulationBuilding, setSimulationBuilding] = useState<THREE.Group | null>(null);

  // Shared project files state
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);

  // Refs for triggering actions from header
  const generateRef = useRef<(() => void) | null>(null);
  const sendToSimRef = useRef<(() => void) | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [hasFloors, setHasFloors] = useState(false);

  // Shared project files panel state (controlled from top bar)
  const [projectFilesPanelOpen, setProjectFilesPanelOpen] = useState(false);

  // Zoom control state for top bar
  const [zoomControl, setZoomControl] = useState<{ zoom: number; zoomIn: () => void; zoomOut: () => void } | null>(null);
  const [drawingSubTab, setDrawingSubTab] = useState<'grundriss' | 'elemente'>('grundriss');

  // Presentation mode state (for Präsentation tab)
  const [presentationMode, setPresentationMode] = useState(false);

  // Add file to project
  const addProjectFile = useCallback((file: Omit<ProjectFile, 'id' | 'createdAt'>) => {
    const newFile: ProjectFile = {
      ...file,
      id: `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      createdAt: new Date()
    };
    setProjectFiles(prev => [newFile, ...prev]);
    return newFile;
  }, []);

  // Remove file from project
  const removeProjectFile = useCallback((id: string) => {
    setProjectFiles(prev => prev.filter(f => f.id !== id));
  }, []);

  return (
    <div className="flex flex-col h-screen w-full bg-gray-100 text-gray-900 font-sans">
      {/* Top Navigation Bar */}
      <header className="bg-white border-b border-gray-200 h-12 flex items-center px-6 shrink-0 z-50">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-sm shadow-sm">P</div>
          <span className="font-bold text-base tracking-tight">Prototype</span>
        </div>
        <nav className="ml-8 flex items-center gap-6 text-sm">
          <a href="/" className="text-gray-600 hover:text-gray-900 font-medium">Home</a>
          <Link href="/projects" className="text-gray-600 hover:text-gray-900 font-medium">Projects</Link>
          <a href="#" className="text-gray-600 hover:text-gray-900 font-medium">Help</a>
        </nav>
        {/* Project name breadcrumb */}
        {projectName && (
          <div className="ml-auto flex items-center gap-2 text-sm text-gray-500">
            <span className="text-gray-300">/</span>
            <span className="font-medium text-gray-700 truncate max-w-[200px]" title={projectName}>{projectName}</span>
          </div>
        )}
      </header>

      {/* Workflow Tabs Bar */}
      <div className="bg-gray-50 border-b border-gray-200 h-12 flex items-center px-6 shrink-0 z-40">
        <div className="flex-1" /> {/* Left spacer */}
        <nav className="flex items-center gap-1 bg-gray-100 p-1 rounded-lg">
          <TabButton active={activeTab === 1} onClick={() => setActiveTab(1)} icon={<PenLine size={16}/>} label="1. Zeichnen" />
          <div className="text-gray-300"><ChevronRight size={16}/></div>
          <TabButton active={activeTab === 2} onClick={() => setActiveTab(2)} icon={<Hammer size={16}/>} label="2. Konstruktion" />
          <div className="text-gray-300"><ChevronRight size={16}/></div>
          <TabButton active={activeTab === 3} onClick={() => setActiveTab(3)} icon={<PlayCircle size={16}/>} label="3. Präsentation" />
        </nav>
        <div className="flex-1 flex justify-end gap-2 items-center"> {/* Right side with action buttons */}
          {/* Zoom Control - show when on Zeichnen tab */}
          {activeTab === 1 && zoomControl && (
            <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg px-2 py-1 mr-2">
              <button
                onClick={zoomControl.zoomOut}
                className="p-1 hover:bg-gray-100 rounded text-gray-600"
                title="Zoom out"
              >
                <span className="text-sm font-bold">−</span>
              </button>
              <span className="text-xs font-mono w-12 text-center text-gray-700">
                {Math.round(zoomControl.zoom * 100)}%
              </span>
              <button
                onClick={zoomControl.zoomIn}
                className="p-1 hover:bg-gray-100 rounded text-gray-600"
                title="Zoom in"
              >
                <span className="text-sm font-bold">+</span>
              </button>
            </div>
          )}
          {activeTab === 1 && (
            <button
              onClick={() => generateRef.current?.()}
              disabled={isProcessing}
              className={`px-4 py-1.5 rounded-lg flex items-center gap-2 text-sm font-medium transition-all text-white shadow ${
                isProcessing
                  ? 'bg-gray-400 cursor-not-allowed'
                  : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700'
              }`}
            >
              {isProcessing ? <Loader2 className="animate-spin" size={16}/> : <Box size={16}/>}
              {isProcessing ? "Processing..." : "Generate 3D"}
            </button>
          )}
          {activeTab === 2 && hasFloors && (
            <button
              onClick={() => sendToSimRef.current?.()}
              className="px-4 py-1.5 rounded-lg flex items-center gap-2 text-sm font-medium transition-all text-white shadow bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700"
            >
              <ChevronRight size={16}/>
              Send to Präsentation
            </button>
          )}
          {activeTab === 3 && (
            <button
              onClick={(e) => { setPresentationMode(!presentationMode); (e.target as HTMLElement).blur(); }}
              className={`px-4 py-1.5 rounded-lg flex items-center gap-2 text-sm font-medium transition-all shadow ${
                presentationMode
                  ? 'bg-red-500 hover:bg-red-600 text-white'
                  : 'bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white'
              }`}
            >
              <PlayCircle size={16}/>
              {presentationMode ? 'Exit Präsentation' : 'Start Präsentation'}
            </button>
          )}
          {/* Project Files Toggle Button - always visible */}
          <button
            onClick={() => setProjectFilesPanelOpen(!projectFilesPanelOpen)}
            className={`px-3 py-1.5 rounded-lg flex items-center gap-2 text-sm font-medium transition-all shadow ${
              projectFilesPanelOpen
                ? 'bg-gray-700 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-200'
            }`}
            title={projectFilesPanelOpen ? "Close Project Files" : "Open Project Files"}
          >
            <FolderOpen size={16}/>
            {projectFiles.length > 0 && <span className="text-xs">{projectFiles.length}</span>}
            {projectFilesPanelOpen ? <PanelRightClose size={14}/> : <PanelRightOpen size={14}/>}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden relative">
        <div className={`w-full h-full ${activeTab === 1 ? 'block' : 'hidden'}`}>
          <DrawingEditor
            onConversionComplete={(data: any) => {
               setConversionResult(data);
               setActiveTab(2);
            }}
            onGenerateRef={(fn) => { generateRef.current = fn; }}
            onProcessingChange={setIsProcessing}
            projectFiles={projectFiles}
            onAddProjectFile={addProjectFile}
            onRemoveProjectFile={removeProjectFile}
            projectFilesPanelOpen={projectFilesPanelOpen}
            onCloseProjectFilesPanel={() => setProjectFilesPanelOpen(false)}
            onZoomControlRef={setZoomControl}
            onSubTabChange={setDrawingSubTab}
          />
        </div>

        {activeTab === 2 && (
            <ViewerProvider>
                <ConstructionViewer
                  data={conversionResult}
                  onSendToSimulation={(building: THREE.Group) => {
                    setSimulationBuilding(building);
                    setActiveTab(3);
                  }}
                  onSendToSimRef={(fn) => { sendToSimRef.current = fn; }}
                  onFloorsChange={(hasFloors) => setHasFloors(hasFloors)}
                  projectFiles={projectFiles}
                  onAddProjectFile={addProjectFile}
                  onRemoveProjectFile={removeProjectFile}
                  projectFilesPanelOpen={projectFilesPanelOpen}
                  onCloseProjectFilesPanel={() => setProjectFilesPanelOpen(false)}
                />
            </ViewerProvider>
        )}

        {activeTab === 3 && (
            <ViewerProvider>
                <SimulationViewer
                  initialBuilding={simulationBuilding}
                  projectFiles={projectFiles}
                  onAddProjectFile={addProjectFile}
                  onRemoveProjectFile={removeProjectFile}
                  projectFilesPanelOpen={projectFilesPanelOpen}
                  onCloseProjectFilesPanel={() => setProjectFilesPanelOpen(false)}
                  presentationMode={presentationMode}
                  onPresentationModeChange={setPresentationMode}
                />
            </ViewerProvider>
        )}
      </div>
    </div>
  );
}

const TabButton = ({ active, onClick, icon, label }: any) => (
  <button onClick={onClick} className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${active ? 'bg-white text-blue-600 shadow-sm ring-1 ring-black/5' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-200/50'}`}>
    {icon} {label}
  </button>
);

// ===========================================
// TAB 2: KONSTRUKTION VIEWER
// ===========================================
const ConstructionViewer = ({ data, onSendToSimulation, onSendToSimRef, onFloorsChange, projectFiles, onAddProjectFile, onRemoveProjectFile, projectFilesPanelOpen, onCloseProjectFilesPanel }: {
  data: any;
  onSendToSimulation?: (building: THREE.Group) => void;
  onSendToSimRef?: (fn: () => void) => void;
  onFloorsChange?: (hasFloors: boolean) => void;
  projectFiles?: ProjectFile[];
  onAddProjectFile?: (file: Omit<ProjectFile, 'id' | 'createdAt'>) => ProjectFile;
  onRemoveProjectFile?: (id: string) => void;
  projectFilesPanelOpen?: boolean;
  onCloseProjectFilesPanel?: () => void;
}) => {
  const { scene, renderer, camera, controls, fitToBox, setSectionPlane } = useViewer();
  const [floorManager, setFloorManager] = useState<FloorManager | null>(null);
  const [floors, setFloors] = useState<any[]>([]);
  const [sectionY, setSectionY] = useState(1.5);
  const [sectionEnabled, setSectionEnabled] = useState(false);
  const [sectionMaxY, setSectionMaxY] = useState(10);
  const [sectionPreviewLines, setSectionPreviewLines] = useState<Array<{ x1: number; z1: number; x2: number; z2: number }>>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [edgesVisible, setEdgesVisible] = useState(false);

  // Measurement state
  const [measureToolMode, setMeasureToolMode] = useState<MeasureToolMode>('none');
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [selectedMeasurementId, setSelectedMeasurementId] = useState<string | null>(null);
  const [includeMeasurementsInExport, setIncludeMeasurementsInExport] = useState(true);
  const measurementManagerRef = useRef<MeasurementManager | null>(null);
  const pendingPointRef = useRef<MeasurementPoint | null>(null);
  const pendingPolygonPointsRef = useRef<MeasurementPoint[]>([]);

  // Object placement state
  const [placedObjects, setPlacedObjects] = useState<PlacedObject[]>([]);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const objectManagerRef = useRef<ObjectManager | null>(null);
  const isDraggingGizmoRef = useRef(false);

  // Generated elevation files state
  interface GeneratedFile {
    id: string;
    name: string;
    type: 'dxf' | 'svg' | 'pdf';
    content: string;
    createdAt: Date;
  }
  const [isGeneratingElevations, setIsGeneratingElevations] = useState(false);

  // Initialize FloorManager when scene is ready
  useEffect(() => {
    if (scene && !floorManager) {
      console.log('Creating FloorManager...');
      const fm = new FloorManager(scene);
      setFloorManager(fm);
    }
  }, [scene, floorManager]);

  // Initialize MeasurementManager when scene is ready
  useEffect(() => {
    if (scene && !measurementManagerRef.current) {
      console.log('Creating MeasurementManager...');
      measurementManagerRef.current = new MeasurementManager(scene);
    }
  }, [scene]);

  // Sync section cut to MeasurementManager for snap filtering
  useEffect(() => {
    if (measurementManagerRef.current) {
      measurementManagerRef.current.setSectionCutY(sectionEnabled ? sectionY : null);
    }
  }, [sectionEnabled, sectionY]);

  // Initialize ObjectManager when scene is ready
  useEffect(() => {
    if (scene && camera && !objectManagerRef.current) {
      console.log('Creating ObjectManager...');
      objectManagerRef.current = new ObjectManager(scene);
      objectManagerRef.current.setCamera(camera);
    }
  }, [scene, camera]);

  // Load IFC when data is available
  useEffect(() => {
    if (data && floorManager && !isLoaded) {
      const ifcFile = data.files.find((f: any) => f.name.endsWith('.ifc'));
      if (ifcFile) {
        console.log('Loading IFC file:', ifcFile.path);
        fetch(ifcFile.path)
          .then(res => res.blob())
          .then(blob => {
            const file = new File([blob], "Generated_Floor.ifc");
            return floorManager.addFloor(file, "Ground Floor (Draft)");
          })
          .then(() => {
            setFloors([...floorManager.floors]);
            setIsLoaded(true);
            // Fit camera to the loaded model after a short delay
            setTimeout(() => {
              const box = floorManager.getBoundingBox();
              console.log('Auto-fitting to box:', box);
              fitToBox(box);
            }, 200);
          })
          .catch(err => console.error("Failed to load IFC", err));
      }
    }
  }, [data, floorManager, isLoaded, fitToBox]);

  const handleUpdateFloor = (id: string, updates: any) => {
    if (!floorManager) return;
    const floor = floorManager.floors.find(f => f.id === id);
    if (floor) {
      Object.assign(floor, updates);
      floorManager.updateTransform(floor);
      setFloors([...floorManager.floors]);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0] && floorManager) {
      await floorManager.addFloor(e.target.files[0], `Floor ${floors.length + 1}`);
      setFloors([...floorManager.floors]);
      const box = floorManager.getBoundingBox();
      fitToBox(box);
    }
  };

  const handleFocusModel = () => {
    console.log('handleFocusModel called');
    if (floorManager && floorManager.floors.length > 0) {
      const box = floorManager.getBoundingBox();
      console.log('Fitting to box:', box.min?.toArray?.(), box.max?.toArray?.());
      fitToBox(box);
    } else {
      console.log('No floors to focus on');
    }
  };

  const handleExportGLB = async () => {
    if (!floorManager || floors.length === 0) {
      return alert("No floors to export");
    }

    try {
      console.log('Exporting floors as GLB...');
      const blob = await floorManager.exportAsGLB();

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = "stacked_building.glb";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      console.log('GLB export complete');
    } catch (e) {
      console.error('Export error:', e);
      alert("Error exporting GLB: " + e);
    }
  };

  const handleSendToSimulation = () => {
    if (!floorManager || floors.length === 0) {
      return alert("No building to send");
    }

    const buildingClone = floorManager.getStackedBuildingClone();
    if (onSendToSimulation) {
      onSendToSimulation(buildingClone);
    }
  };

  // Register sendToSimulation function for header button
  useEffect(() => {
    if (onSendToSimRef) {
      onSendToSimRef(handleSendToSimulation);
    }
  }, [onSendToSimRef, floorManager, floors, onSendToSimulation]);

  // Notify parent about floors state
  useEffect(() => {
    if (onFloorsChange) {
      onFloorsChange(floors.length > 0);
    }
  }, [floors.length, onFloorsChange]);

  // Generate section preview lines when section is enabled or Y changes
  useEffect(() => {
    if (!scene || !sectionEnabled) {
      setSectionPreviewLines([]);
      return;
    }

    const lines: Array<{ x1: number; z1: number; x2: number; z2: number }> = [];
    const planeY = sectionY;

    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.geometry && obj.name !== 'sectionCapMesh') {
        if (obj.parent?.name === 'sectionCapGroup') return;

        // Skip annotation objects
        const nameLower = (obj.name || '').toLowerCase();
        const parentNameLower = (obj.parent?.name || '').toLowerCase();
        if (nameLower.includes('annotation') || nameLower.includes('ifcannotation') ||
            nameLower.includes('storey plan') || nameLower.includes('storeyplan') ||
            parentNameLower.includes('annotation') || parentNameLower.includes('ifcannotation')) {
          return;
        }

        try {
          obj.updateWorldMatrix(true, false);
          const worldMatrix = obj.matrixWorld;
          const geometry = obj.geometry;
          const posAttr = geometry.getAttribute('position');
          const indexAttr = geometry.getIndex();

          if (!posAttr) return;

          const processTriangle = (i0: number, i1: number, i2: number) => {
            const v0 = new THREE.Vector3(posAttr.getX(i0), posAttr.getY(i0), posAttr.getZ(i0));
            const v1 = new THREE.Vector3(posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1));
            const v2 = new THREE.Vector3(posAttr.getX(i2), posAttr.getY(i2), posAttr.getZ(i2));

            v0.applyMatrix4(worldMatrix);
            v1.applyMatrix4(worldMatrix);
            v2.applyMatrix4(worldMatrix);

            const intersectionPoints: THREE.Vector3[] = [];
            const edges = [[v0, v1], [v1, v2], [v2, v0]];

            for (const [a, b] of edges) {
              if ((a.y <= planeY && b.y >= planeY) || (a.y >= planeY && b.y <= planeY)) {
                if (Math.abs(b.y - a.y) < 0.0001) continue;
                const t = (planeY - a.y) / (b.y - a.y);
                if (t >= 0 && t <= 1) {
                  intersectionPoints.push(new THREE.Vector3(
                    a.x + t * (b.x - a.x),
                    planeY,
                    a.z + t * (b.z - a.z)
                  ));
                }
              }
            }

            if (intersectionPoints.length === 2) {
              lines.push({
                x1: intersectionPoints[0].x,
                z1: intersectionPoints[0].z,
                x2: intersectionPoints[1].x,
                z2: intersectionPoints[1].z
              });
            }
          };

          if (indexAttr) {
            for (let i = 0; i < indexAttr.count; i += 3) {
              processTriangle(indexAttr.getX(i), indexAttr.getX(i + 1), indexAttr.getX(i + 2));
            }
          } else {
            for (let i = 0; i < posAttr.count; i += 3) {
              processTriangle(i, i + 1, i + 2);
            }
          }
        } catch (e) {
          // Skip failed meshes
        }
      }
    });

    setSectionPreviewLines(lines);
  }, [scene, sectionEnabled, sectionY]);

  const handleDownloadFile = (file: { name: string; path: string }) => {
    console.log('handleDownloadFile called:', file.name);
    fetch(file.path)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then(blob => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        console.log('Download initiated for:', file.name);
      })
      .catch(err => {
        console.error('Download failed:', err);
        window.open(file.path, '_blank');
      });
  };

  const handleClosePanel = () => {
    console.log('handleClosePanel called');
    onCloseProjectFilesPanel?.();
  };

  const handleToggleEdges = (visible: boolean) => {
    console.log('handleToggleEdges called:', visible);
    setEdgesVisible(visible);
    if (floorManager) {
      floorManager.setEdgesVisible(visible);
    }
  };

  // Update measurement geometry cache when model changes
  const updateMeasurementCache = useCallback(() => {
    if (measurementManagerRef.current) {
      measurementManagerRef.current.updateGeometryCache();
    }
  }, []);

  // Update cache when floors change
  useEffect(() => {
    if (isLoaded) {
      updateMeasurementCache();
    }
  }, [isLoaded, floors, updateMeasurementCache]);

  // Get world position from mouse event - raycasts onto model geometry
  const getWorldPositionFromMouse = useCallback((event: MouseEvent | React.MouseEvent): THREE.Vector3 | null => {
    if (!renderer || !camera || !scene) return null;

    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    // Collect meshes to raycast against (exclude helper objects)
    const meshes: THREE.Object3D[] = [];
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        // Exclude measurement helpers and section caps
        if (obj.name === 'measurementHelper' ||
            obj.name === 'measurementPoint' ||
            obj.name === 'sectionCapMesh' ||
            obj.parent?.name === 'sectionCapGroup' ||
            obj.parent?.name === 'measurementLine' ||
            obj.parent?.name === 'measurementPolygon' ||
            obj.parent?.name === 'measurementPreview' ||
            obj.parent?.name === 'measurementCursor' ||
            obj.parent?.name === 'pendingPolygonPoints') {
          return;
        }
        meshes.push(obj);
      }
    });

    // First try to hit actual model geometry
    const intersects = raycaster.intersectObjects(meshes, false);
    if (intersects.length > 0) {
      // Filter out hits above the section cut plane (clipped geometry is invisible but still raycasted)
      const validHit = sectionEnabled
        ? intersects.find(hit => hit.point.y <= sectionY + 0.01)
        : intersects[0];
      if (validHit) {
        return validHit.point.clone();
      }
    }

    // Fallback to plane ONLY if ray is pointing downward
    const rayDirection = raycaster.ray.direction;
    if (rayDirection.y < 0) {
      // Intersect with horizontal plane at section height or ground level
      const planeY = sectionEnabled ? sectionY : 0;
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY);
      const intersection = new THREE.Vector3();

      if (raycaster.ray.intersectPlane(plane, intersection)) {
        // Check that the intersection is within a reasonable distance (max 500 units)
        const distance = camera.position.distanceTo(intersection);
        if (distance < 500) {
          return intersection;
        }
      }
    }

    // No valid intersection - don't place point in air
    return null;
  }, [renderer, camera, scene, sectionEnabled, sectionY]);

  // Handle mouse move for cursor indicator and preview line
  const handleMouseMove = useCallback((event: MouseEvent) => {
    if (measureToolMode === 'none' || !measurementManagerRef.current) {
      measurementManagerRef.current?.setCursorVisible(false);
      return;
    }

    const worldPoint = getWorldPositionFromMouse(event);
    if (!worldPoint) {
      // No valid intersection - hide cursor and don't update previews
      measurementManagerRef.current.setCursorVisible(false);
      // Clear preview line when no valid point
      if (measureToolMode === 'line' && pendingPointRef.current) {
        measurementManagerRef.current.updatePreviewLine(pendingPointRef.current.position, null);
      }
      // Clear polygon preview cursor when no valid point
      if (measureToolMode === 'polygon' && pendingPolygonPointsRef.current.length > 0) {
        measurementManagerRef.current.updatePendingPoints(pendingPolygonPointsRef.current, null);
      }
      return;
    }

    const snapResult = measurementManagerRef.current.findSnapPoint(worldPoint);

    // Update cursor indicator
    measurementManagerRef.current.updateCursorPosition(snapResult.point, snapResult.type);

    // Update preview line for line mode
    if (measureToolMode === 'line' && pendingPointRef.current) {
      measurementManagerRef.current.updatePreviewLine(pendingPointRef.current.position, snapResult.point);
    }

    // Update pending polygon points display
    if (measureToolMode === 'polygon') {
      measurementManagerRef.current.updatePendingPoints(pendingPolygonPointsRef.current, snapResult.point);
    }
  }, [measureToolMode, getWorldPositionFromMouse]);

  // Handle double-click for placing measurement points
  const handleDoubleClick = useCallback((event: MouseEvent) => {
    if (measureToolMode === 'none' || !measurementManagerRef.current) return;

    const worldPoint = getWorldPositionFromMouse(event);
    if (!worldPoint) return;

    const snapResult = measurementManagerRef.current.findSnapPoint(worldPoint);
    const measurePoint: MeasurementPoint = {
      position: snapResult.point,
      snappedTo: snapResult.type,
      edgeInfo: snapResult.edgeInfo
    };

    if (measureToolMode === 'line') {
      if (!pendingPointRef.current) {
        // First point
        pendingPointRef.current = measurePoint;
        console.log('Line measurement: first point set at', snapResult.point.toArray());
      } else {
        // Second point - create measurement
        const measurement = measurementManagerRef.current.createLineMeasurement(
          pendingPointRef.current,
          measurePoint
        );
        console.log('Line measurement created:', measurement.distance.toFixed(2), 'm');
        setMeasurements([...measurementManagerRef.current.getMeasurements()]);
        pendingPointRef.current = null;
        // Clear preview line
        measurementManagerRef.current.updatePreviewLine(null, null);
      }
    } else if (measureToolMode === 'polygon') {
      const pendingPoints = pendingPolygonPointsRef.current;

      // Check if closing the polygon (clicking near first point)
      if (pendingPoints.length >= 3) {
        const firstPoint = pendingPoints[0].position;
        const distToFirst = snapResult.point.distanceTo(firstPoint);
        if (distToFirst < 0.3) {
          // Close the polygon
          const measurement = measurementManagerRef.current.createPolygonMeasurement(pendingPoints);
          console.log('Polygon measurement created:', measurement.area.toFixed(2), 'm²');
          setMeasurements([...measurementManagerRef.current.getMeasurements()]);
          pendingPolygonPointsRef.current = [];
          // Clear pending points display
          measurementManagerRef.current.updatePendingPoints([], null);
          return;
        }
      }

      // Add point to polygon
      pendingPolygonPointsRef.current = [...pendingPoints, measurePoint];
      console.log('Polygon point added, total points:', pendingPolygonPointsRef.current.length);
    }
  }, [measureToolMode, getWorldPositionFromMouse]);

  // Handle single-click for selecting measurements
  const handleSingleClick = useCallback((event: MouseEvent) => {
    if (measureToolMode === 'none' || !measurementManagerRef.current || !camera) return;

    // Skip if this was a double-click
    if (event.detail > 1) return;

    const rect = renderer!.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    const measurement = measurementManagerRef.current.findMeasurementAtPoint(raycaster);
    if (measurement) {
      measurementManagerRef.current.selectMeasurement(measurement.id);
      setSelectedMeasurementId(measurement.id);
    } else {
      measurementManagerRef.current.selectMeasurement(null);
      setSelectedMeasurementId(null);
    }
  }, [measureToolMode, camera, renderer]);

  // Set up event listeners for measurement
  useEffect(() => {
    if (!renderer) return;
    const domElement = renderer.domElement;

    domElement.addEventListener('dblclick', handleDoubleClick);
    domElement.addEventListener('click', handleSingleClick);
    domElement.addEventListener('mousemove', handleMouseMove);

    return () => {
      domElement.removeEventListener('dblclick', handleDoubleClick);
      domElement.removeEventListener('click', handleSingleClick);
      domElement.removeEventListener('mousemove', handleMouseMove);
    };
  }, [renderer, handleDoubleClick, handleSingleClick, handleMouseMove]);

  // Clear pending points and previews when tool mode changes
  useEffect(() => {
    pendingPointRef.current = null;
    pendingPolygonPointsRef.current = [];
    // Clear all preview elements
    if (measurementManagerRef.current) {
      measurementManagerRef.current.clearPreviews();
    }
  }, [measureToolMode]);

  // Measurement callbacks for sidebar
  const handleSelectMeasurement = useCallback((id: string | null) => {
    if (measurementManagerRef.current) {
      measurementManagerRef.current.selectMeasurement(id);
      setSelectedMeasurementId(id);
    }
  }, []);

  const handleDeleteMeasurement = useCallback((id: string) => {
    if (measurementManagerRef.current) {
      measurementManagerRef.current.deleteMeasurement(id);
      setMeasurements([...measurementManagerRef.current.getMeasurements()]);
      if (selectedMeasurementId === id) {
        setSelectedMeasurementId(null);
      }
    }
  }, [selectedMeasurementId]);

  const handleMoveMeasurement = useCallback((id: string, axis: 'x' | 'z', delta: number) => {
    if (measurementManagerRef.current) {
      measurementManagerRef.current.moveMeasurement(id, axis, delta);
      setMeasurements([...measurementManagerRef.current.getMeasurements()]);
    }
  }, []);

  // Object management callbacks
  const handleUploadObject = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !objectManagerRef.current) return;

    console.log('Uploading object:', file.name);
    const obj = await objectManagerRef.current.addObject(file);
    if (obj) {
      setPlacedObjects([...objectManagerRef.current.getObjects()]);
      setSelectedObjectId(obj.id);
    }
    // Reset input
    e.target.value = '';
  }, []);

  // Drop handlers for drag-and-drop from project files panel
  const handleDropFloor = useCallback(async () => {
    const pf = draggedProjectFile;
    if (!pf || !floorManager) return;
    if (pf.type !== 'ifc') { alert('Only IFC files can be used as floors'); return; }
    const blob = pf.blob || (pf.url ? await fetch(pf.url).then(r => r.blob()) : null);
    if (!blob) return;
    const file = new File([blob], pf.name, { type: blob.type });
    console.log('Drop: loading floor from', file.name);
    await floorManager.addFloor(file, pf.name.replace(/\.[^/.]+$/, ''));
    setFloors([...floorManager.floors]);
    const box = floorManager.getBoundingBox();
    fitToBox(box);
  }, [floorManager, fitToBox]);

  const handleDropObject = useCallback(async () => {
    const pf = draggedProjectFile;
    if (!pf || !objectManagerRef.current) return;
    if (!['glb', 'ifc'].includes(pf.type)) { alert('Only GLB/IFC files can be used as objects'); return; }
    const blob = pf.blob || (pf.url ? await fetch(pf.url).then(r => r.blob()) : null);
    if (!blob) return;
    const file = new File([blob], pf.name, { type: blob.type });
    console.log('Drop: loading object from', file.name);
    const obj = await objectManagerRef.current.addObject(file);
    if (obj) {
      setPlacedObjects([...objectManagerRef.current.getObjects()]);
      setSelectedObjectId(obj.id);
    }
  }, []);

  const handleSelectObject = useCallback((id: string | null) => {
    if (objectManagerRef.current) {
      objectManagerRef.current.selectObject(id);
      setSelectedObjectId(id);
    }
  }, []);

  const handleDeleteObject = useCallback((id: string) => {
    if (objectManagerRef.current) {
      objectManagerRef.current.deleteObject(id);
      setPlacedObjects([...objectManagerRef.current.getObjects()]);
      if (selectedObjectId === id) {
        setSelectedObjectId(null);
      }
    }
  }, [selectedObjectId]);

  const handleDuplicateObject = useCallback((id: string) => {
    if (objectManagerRef.current) {
      const newObj = objectManagerRef.current.duplicateObject(id);
      if (newObj) {
        setPlacedObjects([...objectManagerRef.current.getObjects()]);
        setSelectedObjectId(newObj.id);
      }
    }
  }, []);

  const handleUpdateObject = useCallback((id: string, updates: { position?: { x: number; y: number; z: number }; rotation?: { x: number; y: number; z: number }; scale?: number; visible?: boolean; name?: string }) => {
    if (!objectManagerRef.current) return;

    const updateData: any = {};
    if (updates.position) {
      updateData.position = new THREE.Vector3(updates.position.x, updates.position.y, updates.position.z);
    }
    if (updates.rotation) {
      updateData.rotation = new THREE.Euler(updates.rotation.x, updates.rotation.y, updates.rotation.z);
    }
    if (updates.scale !== undefined) {
      updateData.scale = new THREE.Vector3(updates.scale, updates.scale, updates.scale);
    }
    if (updates.visible !== undefined) {
      updateData.visible = updates.visible;
    }
    if (updates.name !== undefined) {
      updateData.name = updates.name;
    }

    objectManagerRef.current.updateObject(id, updateData);
    setPlacedObjects([...objectManagerRef.current.getObjects()]);
  }, []);

  // Handle object gizmo mouse events
  const handleObjectMouseDown = useCallback((event: MouseEvent) => {
    if (!objectManagerRef.current || !camera || !renderer) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    // Check if clicking on gizmo axis
    const axis = objectManagerRef.current.checkGizmoHit(raycaster);
    if (axis) {
      event.stopPropagation();
      event.preventDefault();
      isDraggingGizmoRef.current = true;

      // Get the plane intersection for drag start
      const selected = objectManagerRef.current.getSelectedObject();
      if (selected) {
        let planeNormal: THREE.Vector3;
        if (axis === 'x') planeNormal = new THREE.Vector3(0, 0, 1);
        else if (axis === 'y') planeNormal = new THREE.Vector3(0, 0, 1);
        else planeNormal = new THREE.Vector3(1, 0, 0);

        const startPos = objectManagerRef.current.getWorldPositionOnPlane(raycaster, planeNormal, selected.position);
        if (startPos) {
          objectManagerRef.current.startDrag(axis, startPos);
          // Disable orbit controls during drag
          if (controls) controls.enabled = false;
        }
      }
      return;
    }

    // If not clicking gizmo, check if clicking on an object
    if (measureToolMode === 'none') {
      const hitObject = objectManagerRef.current.findObjectAtPoint(raycaster);
      if (hitObject) {
        handleSelectObject(hitObject.id);
      }
    }
  }, [camera, renderer, controls, measureToolMode, handleSelectObject]);

  const handleObjectMouseMove = useCallback((event: MouseEvent) => {
    if (!isDraggingGizmoRef.current || !objectManagerRef.current || !camera || !renderer) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    const selected = objectManagerRef.current.getSelectedObject();
    if (selected) {
      // Get plane normal based on active axis
      let planeNormal: THREE.Vector3;
      const isDragging = objectManagerRef.current.isDragging();
      // Use vertical plane for most cases during drag
      if (isDragging) {
        planeNormal = new THREE.Vector3(0, 0, 1);
      } else {
        planeNormal = new THREE.Vector3(1, 0, 0);
      }

      const currentPos = objectManagerRef.current.getWorldPositionOnPlane(raycaster, planeNormal, selected.position);
      if (currentPos) {
        objectManagerRef.current.updateDrag(currentPos);
        setPlacedObjects([...objectManagerRef.current.getObjects()]);
      }
    }
  }, [camera, renderer]);

  const handleObjectMouseUp = useCallback(() => {
    if (isDraggingGizmoRef.current && objectManagerRef.current) {
      objectManagerRef.current.endDrag();
      isDraggingGizmoRef.current = false;
      // Re-enable orbit controls
      if (controls) controls.enabled = true;
      setPlacedObjects([...objectManagerRef.current.getObjects()]);
    }
  }, [controls]);

  // Set up object gizmo event listeners
  useEffect(() => {
    if (!renderer) return;
    const domElement = renderer.domElement;

    domElement.addEventListener('mousedown', handleObjectMouseDown);
    domElement.addEventListener('mousemove', handleObjectMouseMove);
    domElement.addEventListener('mouseup', handleObjectMouseUp);

    return () => {
      domElement.removeEventListener('mousedown', handleObjectMouseDown);
      domElement.removeEventListener('mousemove', handleObjectMouseMove);
      domElement.removeEventListener('mouseup', handleObjectMouseUp);
    };
  }, [renderer, handleObjectMouseDown, handleObjectMouseMove, handleObjectMouseUp]);

  const handleExportSectionDXF = () => {
    if (!scene || !sectionEnabled) {
      alert('Section cut must be enabled to export DXF');
      return;
    }

    console.log('Exporting section DXF at Y =', sectionY);

    // Collect all intersection lines from meshes at the section plane
    const lines: Array<{ x1: number; z1: number; x2: number; z2: number }> = [];
    const planeY = sectionY;

    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.geometry && obj.name !== 'sectionCapMesh') {
        if (obj.parent?.name === 'sectionCapGroup') return;

        // Skip annotation objects (IFC drawing boundaries, plan annotations, etc.)
        const nameLower = (obj.name || '').toLowerCase();
        const parentNameLower = (obj.parent?.name || '').toLowerCase();
        if (nameLower.includes('annotation') || nameLower.includes('ifcannotation') ||
            nameLower.includes('storey plan') || nameLower.includes('storeyplan') ||
            parentNameLower.includes('annotation') || parentNameLower.includes('ifcannotation')) {
          return; // Skip this mesh
        }

        try {
          // Get world matrix
          obj.updateWorldMatrix(true, false);
          const worldMatrix = obj.matrixWorld;

          // Get position attribute
          const geometry = obj.geometry;
          const posAttr = geometry.getAttribute('position');
          const indexAttr = geometry.getIndex();

          if (!posAttr) return;

          // Process each triangle
          const processTriangle = (i0: number, i1: number, i2: number) => {
            // Get vertices in local space
            const v0 = new THREE.Vector3(posAttr.getX(i0), posAttr.getY(i0), posAttr.getZ(i0));
            const v1 = new THREE.Vector3(posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1));
            const v2 = new THREE.Vector3(posAttr.getX(i2), posAttr.getY(i2), posAttr.getZ(i2));

            // Transform to world space
            v0.applyMatrix4(worldMatrix);
            v1.applyMatrix4(worldMatrix);
            v2.applyMatrix4(worldMatrix);

            // Find intersection with horizontal plane at planeY
            const intersectionPoints: THREE.Vector3[] = [];

            const edges = [
              [v0, v1],
              [v1, v2],
              [v2, v0]
            ];

            for (const [a, b] of edges) {
              // Check if edge crosses the plane
              if ((a.y <= planeY && b.y >= planeY) || (a.y >= planeY && b.y <= planeY)) {
                if (Math.abs(b.y - a.y) < 0.0001) continue; // Edge is parallel to plane

                const t = (planeY - a.y) / (b.y - a.y);
                if (t >= 0 && t <= 1) {
                  const intersection = new THREE.Vector3(
                    a.x + t * (b.x - a.x),
                    planeY,
                    a.z + t * (b.z - a.z)
                  );
                  intersectionPoints.push(intersection);
                }
              }
            }

            // If we have exactly 2 intersection points, we have a line segment
            if (intersectionPoints.length === 2) {
              lines.push({
                x1: intersectionPoints[0].x,
                z1: intersectionPoints[0].z,
                x2: intersectionPoints[1].x,
                z2: intersectionPoints[1].z
              });
            }
          };

          if (indexAttr) {
            for (let i = 0; i < indexAttr.count; i += 3) {
              processTriangle(indexAttr.getX(i), indexAttr.getX(i + 1), indexAttr.getX(i + 2));
            }
          } else {
            for (let i = 0; i < posAttr.count; i += 3) {
              processTriangle(i, i + 1, i + 2);
            }
          }
        } catch (e) {
          console.warn('Failed to process mesh for DXF export:', e);
        }
      }
    });

    console.log(`Found ${lines.length} line segments for DXF export`);

    if (lines.length === 0) {
      alert('No geometry intersects with the section plane at this height');
      return;
    }

    // Generate DXF content
    let dxf = '';

    // DXF Header
    dxf += '0\nSECTION\n2\nHEADER\n';
    dxf += '9\n$ACADVER\n1\nAC1015\n'; // AutoCAD 2000 format
    dxf += '0\nENDSEC\n';

    // DXF Tables (minimal)
    dxf += '0\nSECTION\n2\nTABLES\n';
    dxf += '0\nTABLE\n2\nLAYER\n70\n2\n';
    dxf += '0\nLAYER\n2\nSECTION\n70\n0\n62\n7\n6\nCONTINUOUS\n'; // Layer for section lines
    dxf += '0\nLAYER\n2\nMEASUREMENTS\n70\n0\n62\n3\n6\nCONTINUOUS\n'; // Layer for measurements (green)
    dxf += '0\nENDTAB\n';
    dxf += '0\nENDSEC\n';

    // DXF Entities
    dxf += '0\nSECTION\n2\nENTITIES\n';

    for (const line of lines) {
      // Use X and Z coordinates (plan view - looking down at Y)
      dxf += '0\nLINE\n';
      dxf += '8\nSECTION\n'; // Layer name
      dxf += `10\n${line.x1.toFixed(6)}\n`; // Start X
      dxf += `20\n${line.z1.toFixed(6)}\n`; // Start Y (Z in 3D becomes Y in 2D)
      dxf += '30\n0\n'; // Start Z (always 0 in 2D)
      dxf += `11\n${line.x2.toFixed(6)}\n`; // End X
      dxf += `21\n${line.z2.toFixed(6)}\n`; // End Y
      dxf += '31\n0\n'; // End Z
    }

    // Add measurements if enabled
    if (includeMeasurementsInExport && measurementManagerRef.current) {
      dxf += measurementManagerRef.current.exportToDXFLines(true);
    }

    dxf += '0\nENDSEC\n';
    dxf += '0\nEOF\n';

    // Download the DXF file
    const blob = new Blob([dxf], { type: 'application/dxf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `section_cut_${sectionY.toFixed(2)}m.dxf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log('DXF export complete');
  };

  // Create elevations as DXF files (front, back, left, right, top) - proper hard edge detection
  const handleCreateElevationsDXF = () => {
    if (!scene || floors.length === 0) {
      alert('No floors loaded to create elevations');
      return;
    }

    setIsGeneratingElevations(true);
    console.log('Creating elevation DXFs with hard edge detection...');

    // Types for edge detection
    interface Triangle {
      v0: THREE.Vector3;
      v1: THREE.Vector3;
      v2: THREE.Vector3;
      normal: THREE.Vector3;
      elementType: 'wall' | 'window' | 'door' | 'floor' | 'roof' | 'other';
    }

    interface HardEdge {
      start: THREE.Vector3;
      end: THREE.Vector3;
      elementType: Triangle['elementType'];
      edgeType: 'silhouette' | 'crease' | 'boundary';
    }

    // Collect all triangles with their normals
    const allTriangles: Triangle[] = [];
    let minY = Infinity, maxY = -Infinity;
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    // Debug: log all mesh names once to find the annotation object
    const debugMeshNames: string[] = [];

    floors.forEach((floor) => {
      floor.mesh.traverse((obj: THREE.Object3D) => {
        if (obj instanceof THREE.Mesh && obj.geometry) {
          const nameLower = (obj.name || '').toLowerCase();
          const parentNameLower = (obj.parent?.name || '').toLowerCase();

          // Debug log
          debugMeshNames.push(`"${obj.name}" (parent: "${obj.parent?.name}")`);

          // Skip annotation objects (IFC drawing boundaries, plan annotations, etc.)
          // Also skip objects with "my storey" since that's the IfcAnnotation name
          if (nameLower.includes('annotation') || nameLower.includes('ifcannotation') ||
              nameLower.includes('storey plan') || nameLower.includes('storeyplan') ||
              nameLower.includes('my storey') || nameLower.includes('mystorey') ||
              parentNameLower.includes('annotation') || parentNameLower.includes('ifcannotation') ||
              parentNameLower.includes('my storey') || parentNameLower.includes('mystorey')) {
            console.log('[DXF Export] Skipping annotation:', obj.name);
            return; // Skip this mesh
          }

          obj.updateWorldMatrix(true, false);
          const worldMatrix = obj.matrixWorld;
          const normalMatrix = new THREE.Matrix3().getNormalMatrix(worldMatrix);
          let elementType: Triangle['elementType'] = 'other';
          if (nameLower.includes('wall') || nameLower.includes('wand')) elementType = 'wall';
          else if (nameLower.includes('window') || nameLower.includes('fenster')) elementType = 'window';
          else if (nameLower.includes('door') || nameLower.includes('tür') || nameLower.includes('tur')) elementType = 'door';
          else if (nameLower.includes('slab') || nameLower.includes('floor') || nameLower.includes('boden')) elementType = 'floor';
          else if (nameLower.includes('roof') || nameLower.includes('dach')) elementType = 'roof';

          const geometry = obj.geometry;
          const posAttr = geometry.getAttribute('position');
          const indexAttr = geometry.getIndex();

          if (!posAttr) return;

          const getVertex = (idx: number): THREE.Vector3 => {
            return new THREE.Vector3(
              posAttr.getX(idx),
              posAttr.getY(idx),
              posAttr.getZ(idx)
            ).applyMatrix4(worldMatrix);
          };

          const processTriangle = (i0: number, i1: number, i2: number) => {
            const v0 = getVertex(i0);
            const v1 = getVertex(i1);
            const v2 = getVertex(i2);

            // Calculate face normal
            const edge1 = new THREE.Vector3().subVectors(v1, v0);
            const edge2 = new THREE.Vector3().subVectors(v2, v0);
            const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();

            allTriangles.push({ v0, v1, v2, normal, elementType });

            // Update bounds
            [v0, v1, v2].forEach(v => {
              minX = Math.min(minX, v.x);
              maxX = Math.max(maxX, v.x);
              minY = Math.min(minY, v.y);
              maxY = Math.max(maxY, v.y);
              minZ = Math.min(minZ, v.z);
              maxZ = Math.max(maxZ, v.z);
            });
          };

          if (indexAttr) {
            for (let i = 0; i < indexAttr.count; i += 3) {
              processTriangle(indexAttr.getX(i), indexAttr.getX(i + 1), indexAttr.getX(i + 2));
            }
          } else {
            for (let i = 0; i < posAttr.count; i += 3) {
              processTriangle(i, i + 1, i + 2);
            }
          }
        }
      });
    });

    console.log(`Collected ${allTriangles.length} triangles`);
    console.log('[DXF Export] All mesh names:', debugMeshNames);

    if (allTriangles.length === 0) {
      alert('No geometry found in the model');
      setIsGeneratingElevations(false);
      return;
    }

    // Build edge-to-triangles map for finding shared edges
    const edgeKey = (v1: THREE.Vector3, v2: THREE.Vector3): string => {
      const k1 = `${v1.x.toFixed(3)},${v1.y.toFixed(3)},${v1.z.toFixed(3)}`;
      const k2 = `${v2.x.toFixed(3)},${v2.y.toFixed(3)},${v2.z.toFixed(3)}`;
      return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
    };

    const edgeTriangleMap = new Map<string, { tri: Triangle; edge: [THREE.Vector3, THREE.Vector3] }[]>();

    allTriangles.forEach(tri => {
      const edges: [THREE.Vector3, THREE.Vector3][] = [
        [tri.v0, tri.v1],
        [tri.v1, tri.v2],
        [tri.v2, tri.v0]
      ];

      edges.forEach(edge => {
        const key = edgeKey(edge[0], edge[1]);
        if (!edgeTriangleMap.has(key)) {
          edgeTriangleMap.set(key, []);
        }
        edgeTriangleMap.get(key)!.push({ tri, edge });
      });
    });

    // View definitions
    type ViewDirection = 'front' | 'back' | 'left' | 'right' | 'top';
    interface ViewDef {
      name: ViewDirection;
      viewDir: THREE.Vector3;  // Direction camera is looking (into the scene)
      projectFn: (v: THREE.Vector3) => { x: number; y: number };
    }

    const views: ViewDef[] = [
      {
        // Front: observer at +Z looking toward -Z, sees faces with +Z normal
        // viewDir is INTO scene, so +Z means camera at +Z looking toward -Z
        name: 'front',
        viewDir: new THREE.Vector3(0, 0, 1),
        projectFn: (v) => ({ x: v.x, y: v.y })
      },
      {
        // Back: observer at -Z looking toward +Z, sees faces with -Z normal
        name: 'back',
        viewDir: new THREE.Vector3(0, 0, -1),
        projectFn: (v) => ({ x: -v.x, y: v.y })
      },
      {
        // Left: observer at -X looking toward +X, sees faces with -X normal
        name: 'left',
        viewDir: new THREE.Vector3(-1, 0, 0),
        projectFn: (v) => ({ x: v.z, y: v.y })
      },
      {
        // Right: observer at +X looking toward -X, sees faces with +X normal
        name: 'right',
        viewDir: new THREE.Vector3(1, 0, 0),
        projectFn: (v) => ({ x: -v.z, y: v.y })
      },
      {
        name: 'top',
        viewDir: new THREE.Vector3(0, -1, 0),
        projectFn: (v) => ({ x: v.x, y: -v.z })
      }
    ];

    // Line weights in mm (for DXF)
    const lineWeights: Record<Triangle['elementType'], number> = {
      wall: 50,      // 0.5mm
      window: 25,    // 0.25mm
      door: 25,      // 0.25mm
      floor: 35,     // 0.35mm
      roof: 35,      // 0.35mm
      other: 18      // 0.18mm
    };

    // DXF color codes (AutoCAD Color Index)
    const layerColors: Record<string, number> = {
      WALLS: 7,
      WINDOWS: 5,
      DOORS: 30,
      FLOORS: 8,
      ROOF: 3,
      OTHER: 9,
      GROUND: 8
    };

    const layerMap: Record<Triangle['elementType'], string> = {
      wall: 'WALLS',
      window: 'WINDOWS',
      door: 'DOORS',
      floor: 'FLOORS',
      roof: 'ROOF',
      other: 'OTHER'
    };

    // Crease angle threshold (in radians) - edges with angle > this are hard edges
    const creaseAngle = Math.PI / 12; // 15 degrees - more sensitive for architectural details

    // Find hard edges for a given view
    const findHardEdges = (viewDef: ViewDef): HardEdge[] => {
      const hardEdges: HardEdge[] = [];
      const viewDir = viewDef.viewDir;

      edgeTriangleMap.forEach((tris, key) => {
        if (tris.length === 0) return;

        const edge = tris[0].edge;
        const start = edge[0];
        const end = edge[1];

        // Skip very short edges
        if (start.distanceTo(end) < 0.001) return;

        // Get element type (prefer wall > window > door > floor > roof > other)
        const elementTypes = tris.map(t => t.tri.elementType);
        let elementType: Triangle['elementType'] = 'other';
        if (elementTypes.includes('wall')) elementType = 'wall';
        else if (elementTypes.includes('window')) elementType = 'window';
        else if (elementTypes.includes('door')) elementType = 'door';
        else if (elementTypes.includes('floor')) elementType = 'floor';
        else if (elementTypes.includes('roof')) elementType = 'roof';

        // Check if edge is at model boundary (at min/max of bounding box)
        const tolerance = 0.01;
        const isAtBoundary =
          Math.abs(start.x - minX) < tolerance || Math.abs(start.x - maxX) < tolerance ||
          Math.abs(end.x - minX) < tolerance || Math.abs(end.x - maxX) < tolerance ||
          Math.abs(start.z - minZ) < tolerance || Math.abs(start.z - maxZ) < tolerance ||
          Math.abs(end.z - minZ) < tolerance || Math.abs(end.z - maxZ) < tolerance;

        if (tris.length === 1) {
          // Boundary edge (only one triangle) - always include if front-facing OR at model boundary
          const tri = tris[0].tri;
          const dotProduct = tri.normal.dot(viewDir);
          if (dotProduct < 0.1) {  // Front-facing (with small tolerance)
            hardEdges.push({ start: start.clone(), end: end.clone(), elementType, edgeType: 'boundary' });
          }
        } else if (tris.length === 2) {
          // Shared edge - check for silhouette or crease
          const tri1 = tris[0].tri;
          const tri2 = tris[1].tri;

          const dot1 = tri1.normal.dot(viewDir);
          const dot2 = tri2.normal.dot(viewDir);

          // Check angle between the two face normals
          const normalDot = tri1.normal.dot(tri2.normal);
          const angleBetweenNormals = Math.acos(Math.max(-1, Math.min(1, normalDot)));

          // For top view, skip windows and doors entirely (they're inside the building)
          const isTopView = Math.abs(viewDir.y + 1) < 0.01; // viewDir is (0, -1, 0) for top
          const skipForTopView = isTopView && (elementType === 'window' || elementType === 'door');

          // Silhouette edge: one face front-facing, one back-facing
          if ((dot1 < 0 && dot2 >= 0) || (dot1 >= 0 && dot2 < 0)) {
            if (!skipForTopView) {
              hardEdges.push({ start: start.clone(), end: end.clone(), elementType, edgeType: 'silhouette' });
            }
          }
          // Hard edge: faces have opposing normals (nearly 180° apart) - this catches
          // vertical wall edges when viewed from the side (where both faces are edge-on)
          // Only apply to walls - windows/doors should be hidden when viewed edge-on
          else if (normalDot < -0.9 && elementType === 'wall') {
            hardEdges.push({ start: start.clone(), end: end.clone(), elementType, edgeType: 'silhouette' });
          }
          // Crease edge: both front-facing but angle between normals > threshold
          else if (dot1 < 0 && dot2 < 0) {
            if (angleBetweenNormals > creaseAngle && !skipForTopView) {
              hardEdges.push({ start: start.clone(), end: end.clone(), elementType, edgeType: 'crease' });
            }
          }
          // Also include edges where different element types meet (e.g., wall meets floor)
          else if (dot1 < 0 || dot2 < 0) {
            if (tri1.elementType !== tri2.elementType && !skipForTopView) {
              hardEdges.push({ start: start.clone(), end: end.clone(), elementType, edgeType: 'crease' });
            }
          }
          // Include sharp creases even when faces are edge-on - but only for walls
          else if (Math.abs(dot1) < 0.1 && Math.abs(dot2) < 0.1 && angleBetweenNormals > Math.PI / 4 && elementType === 'wall') {
            hardEdges.push({ start: start.clone(), end: end.clone(), elementType, edgeType: 'crease' });
          }
        }
        // Edges with more than 2 triangles are usually at corners - include them
        else if (tris.length > 2) {
          // For top view, skip windows and doors
          const isTopView = Math.abs(viewDir.y + 1) < 0.01;
          const skipForTopView = isTopView && (elementType === 'window' || elementType === 'door');

          const anyFrontFacing = tris.some(t => t.tri.normal.dot(viewDir) < 0);
          if (anyFrontFacing && !skipForTopView) {
            hardEdges.push({ start: start.clone(), end: end.clone(), elementType, edgeType: 'crease' });
          }
        }
      });

      return hardEdges;
    };

    // Depth-based visibility test - checks multiple points along edge
    const isEdgeVisible = (edge: HardEdge, viewDef: ViewDef): boolean => {
      // Get depth along view direction (higher = closer to camera)
      // viewDir points INTO the scene, so camera is at opposite side
      // Higher depth = closer to camera
      const getDepth = (p: THREE.Vector3): number => {
        // Depth = distance toward camera (higher = closer to camera = drawn on top)
        if (viewDef.name === 'front') return p.z;   // viewDir +Z means camera at +Z, closer = higher Z
        if (viewDef.name === 'back') return -p.z;   // viewDir -Z means camera at -Z, closer = lower Z
        if (viewDef.name === 'left') return -p.x;   // viewDir -X means camera at -X, closer = lower X
        if (viewDef.name === 'right') return p.x;   // viewDir +X means camera at +X, closer = higher X
        if (viewDef.name === 'top') return -p.y;
        return 0;
      };

      // Check if a point is inside a 2D triangle
      const pointInTriangle = (px: number, py: number, p0: {x:number,y:number}, p1: {x:number,y:number}, p2: {x:number,y:number}): boolean => {
        const sign = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
          (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
        const d1 = sign(px, py, p0.x, p0.y, p1.x, p1.y);
        const d2 = sign(px, py, p1.x, p1.y, p2.x, p2.y);
        const d3 = sign(px, py, p2.x, p2.y, p0.x, p0.y);
        const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
        const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
        return !(hasNeg && hasPos);
      };

      // Check if a single point is occluded by front-facing triangles
      const isPointOccluded = (point: THREE.Vector3): boolean => {
        const pointDepth = getDepth(point);
        const proj = viewDef.projectFn(point);

        for (const tri of allTriangles) {
          // Only front-facing triangles can occlude (back-facing are invisible)
          const facingDot = tri.normal.dot(viewDef.viewDir);
          if (facingDot >= -0.01) continue; // Skip back-facing and edge-on triangles

          // Project triangle vertices
          const p0 = viewDef.projectFn(tri.v0);
          const p1 = viewDef.projectFn(tri.v1);
          const p2 = viewDef.projectFn(tri.v2);

          // Check if projected point is inside triangle (2D)
          if (!pointInTriangle(proj.x, proj.y, p0, p1, p2)) continue;

          // Interpolate triangle depth at this point using barycentric coordinates
          const area = Math.abs((p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y));
          if (area < 0.0001) continue;

          const w0 = Math.abs((p1.x - proj.x) * (p2.y - proj.y) - (p2.x - proj.x) * (p1.y - proj.y)) / area;
          const w1 = Math.abs((p2.x - proj.x) * (p0.y - proj.y) - (p0.x - proj.x) * (p2.y - proj.y)) / area;
          const w2 = 1 - w0 - w1;

          if (w0 >= 0 && w1 >= 0 && w2 >= 0 && w0 <= 1 && w1 <= 1 && w2 <= 1) {
            const triDepth = w0 * getDepth(tri.v0) + w1 * getDepth(tri.v1) + w2 * getDepth(tri.v2);

            // Triangle is in front of point (with small tolerance to avoid self-occlusion)
            if (triDepth > pointDepth + 0.005) {
              return true; // Point is occluded
            }
          }
        }
        return false; // Point is visible
      };

      // Sample multiple points along the edge
      const sampleCount = 3;
      let visibleSamples = 0;

      for (let i = 0; i < sampleCount; i++) {
        const t = (i + 1) / (sampleCount + 1); // Sample at 0.25, 0.5, 0.75
        const samplePoint = new THREE.Vector3().lerpVectors(edge.start, edge.end, t);

        if (!isPointOccluded(samplePoint)) {
          visibleSamples++;
        }
      }

      // Edge is visible if ANY sample is visible (more permissive)
      return visibleSamples > 0;
    };

    // Generate DXF for a view
    const generateElevationDXF = (viewDef: ViewDef): string => {
      let dxf = '';
      const scale = 10; // 1:100 scale (meters to mm)

      // Find hard edges
      const hardEdges = findHardEdges(viewDef);
      console.log(`${viewDef.name}: Found ${hardEdges.length} hard edges`);

      // Filter visible edges (hidden line removal)
      const visibleEdges = hardEdges.filter(edge => isEdgeVisible(edge, viewDef));
      console.log(`${viewDef.name}: ${visibleEdges.length} visible edges after hidden line removal`);

      // DXF Header
      dxf += '0\nSECTION\n2\nHEADER\n';
      dxf += '9\n$ACADVER\n1\nAC1015\n';
      dxf += '9\n$INSUNITS\n70\n4\n';
      dxf += '0\nENDSEC\n';

      // Tables
      dxf += '0\nSECTION\n2\nTABLES\n';
      dxf += '0\nTABLE\n2\nLTYPE\n70\n2\n';
      dxf += '0\nLTYPE\n2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0\n';
      dxf += '0\nLTYPE\n2\nDASHED\n70\n0\n3\nDashed line\n72\n65\n73\n2\n40\n10.0\n49\n5.0\n49\n-5.0\n';
      dxf += '0\nENDTAB\n';

      dxf += '0\nTABLE\n2\nLAYER\n70\n7\n';
      Object.entries(layerColors).forEach(([layerName, color]) => {
        const lw = layerName === 'WALLS' ? 50 : 25;
        dxf += `0\nLAYER\n2\n${layerName}\n70\n0\n62\n${color}\n6\nCONTINUOUS\n370\n${lw}\n`;
      });
      dxf += '0\nENDTAB\n';
      dxf += '0\nENDSEC\n';

      // Entities
      dxf += '0\nSECTION\n2\nENTITIES\n';

      for (const edge of visibleEdges) {
        const p1 = viewDef.projectFn(edge.start);
        const p2 = viewDef.projectFn(edge.end);

        const layer = layerMap[edge.elementType];
        const lw = lineWeights[edge.elementType];

        dxf += '0\nLINE\n';
        dxf += `8\n${layer}\n`;
        dxf += `370\n${lw}\n`;
        dxf += `10\n${(p1.x * scale).toFixed(4)}\n`;
        dxf += `20\n${(p1.y * scale).toFixed(4)}\n`;
        dxf += '30\n0\n';
        dxf += `11\n${(p2.x * scale).toFixed(4)}\n`;
        dxf += `21\n${(p2.y * scale).toFixed(4)}\n`;
        dxf += '31\n0\n';
      }

      // Ground line for elevations (not top view)
      if (viewDef.name !== 'top') {
        let groundX1: number, groundX2: number;
        if (viewDef.name === 'front') {
          // Front: projectFn uses v.x directly
          groundX1 = (minX - 1) * scale;
          groundX2 = (maxX + 1) * scale;
        } else if (viewDef.name === 'back') {
          // Back: projectFn uses -v.x (mirrored)
          groundX1 = -(maxX + 1) * scale;
          groundX2 = -(minX - 1) * scale;
        } else if (viewDef.name === 'left') {
          // Left: projectFn uses v.z
          groundX1 = (minZ - 1) * scale;
          groundX2 = (maxZ + 1) * scale;
        } else if (viewDef.name === 'right') {
          // Right: projectFn uses -v.z (mirrored)
          groundX1 = -(maxZ + 1) * scale;
          groundX2 = -(minZ - 1) * scale;
        } else {
          groundX1 = 0;
          groundX2 = 0;
        }

        dxf += '0\nLINE\n';
        dxf += '8\nGROUND\n';
        dxf += '6\nDASHED\n';
        dxf += '370\n25\n';
        dxf += `10\n${groundX1.toFixed(4)}\n`;
        dxf += '20\n0\n';
        dxf += '30\n0\n';
        dxf += `11\n${groundX2.toFixed(4)}\n`;
        dxf += '21\n0\n';
        dxf += '31\n0\n';
      }

      dxf += '0\nENDSEC\n';
      dxf += '0\nEOF\n';

      return dxf;
    };

    // Generate files and add them to project files
    views.forEach(viewDef => {
      const dxfContent = generateElevationDXF(viewDef);
      if (onAddProjectFile) {
        onAddProjectFile({
          name: `elevation_${viewDef.name}.dxf`,
          type: 'dxf',
          content: dxfContent,
          source: 'construction'
        });
      }
    });

    setIsGeneratingElevations(false);
    console.log('Elevation DXF creation complete - 5 files added to project files');
  };

  // Download a generated file
  const handleDownloadGeneratedFile = (file: GeneratedFile) => {
    const blob = new Blob([file.content], { type: 'application/dxf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex w-full h-full overflow-hidden">
      {/* Left Sidebar */}
      <ViewerSidebar
        floors={floors}
        onUpload={handleUpload}
        onUpdateFloor={handleUpdateFloor}
        onExportGLB={handleExportGLB}
        onSendToSimulation={onSendToSimulation ? handleSendToSimulation : undefined}
        sectionEnabled={sectionEnabled}
        sectionY={sectionY}
        sectionMaxY={sectionMaxY}
        onSectionMaxYChange={setSectionMaxY}
        sectionPreviewLines={sectionPreviewLines}
        onExportSectionDXF={handleExportSectionDXF}
        onCreateElevationsDXF={handleCreateElevationsDXF}
        isGeneratingElevations={isGeneratingElevations}
        // Measurement props
        measureToolMode={measureToolMode}
        setMeasureToolMode={setMeasureToolMode}
        measurements={measurements}
        selectedMeasurementId={selectedMeasurementId}
        onSelectMeasurement={handleSelectMeasurement}
        onDeleteMeasurement={handleDeleteMeasurement}
        onMoveMeasurement={handleMoveMeasurement}
        includeMeasurementsInExport={includeMeasurementsInExport}
        setIncludeMeasurementsInExport={setIncludeMeasurementsInExport}
        // Object props
        placedObjects={placedObjects}
        selectedObjectId={selectedObjectId}
        onUploadObject={handleUploadObject}
        onDropFloor={handleDropFloor}
        onDropObject={handleDropObject}
        onSelectObject={handleSelectObject}
        onDeleteObject={handleDeleteObject}
        onDuplicateObject={handleDuplicateObject}
        onUpdateObject={handleUpdateObject}
      />

      {/* Main 3D Viewer Area */}
      <div className="flex-1 relative overflow-hidden">
        {/* 3D Canvas */}
        <ViewerCanvas
          edgesVisible={edgesVisible}
          onToggleEdges={handleToggleEdges}
          sectionEnabled={sectionEnabled}
          sectionY={sectionY}
          sectionMaxY={sectionMaxY}
          setSectionY={(y) => {
            if (y === null) {
              setSectionEnabled(false);
              setSectionPlane(null, (plane) => {
                if (floorManager) floorManager.setEdgeClipping(plane);
              });
            } else {
              setSectionEnabled(true);
              setSectionY(y);
              setSectionPlane(y, (plane) => {
                if (floorManager) floorManager.setEdgeClipping(plane);
              });
            }
          }}
        />

        {/* Toolbar Overlay */}
        <div className="absolute top-4 left-4 z-50 flex gap-2">
          <button
            type="button"
            onClick={handleFocusModel}
            className="p-2 bg-white rounded-lg shadow-md hover:bg-gray-100 active:bg-gray-200 transition-colors"
            title="Focus on model"
          >
            <Focus size={20} />
          </button>
        </div>

        {/* Empty State Message */}
        {!data && !isLoaded && floors.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center text-gray-400 bg-white/80 p-6 rounded-lg">
              <Hammer size={48} className="mx-auto mb-2 opacity-30" />
              <p>No model loaded. Go to "Zeichnen" and generate one.</p>
            </div>
          </div>
        )}
      </div>

      {/* Right Files Panel */}
      {projectFilesPanelOpen && (
        <ProjectFilesPanel
          projectFiles={projectFiles || []}
          onRemoveFile={onRemoveProjectFile}
          onClose={handleClosePanel}
          generatedFiles={data?.files}
          onDownloadGeneratedFile={handleDownloadFile}
        />
      )}
    </div>
  );
};

// ===========================================
// TAB 3: SIMULATION VIEWER
// ===========================================
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { SplatMesh, SplatEdit, SplatEditSdf, SplatEditSdfType, SplatEditRgbaBlendMode } from '@sparkjsdev/spark';
import { generateShareId, type SharedPresentation, type SharedModel, type SharedSlide, type SharedHotspot } from './lib/shared-presentation';

interface SimulationModel {
  id: string;
  name: string;
  type: 'building' | 'environment' | 'splat' | 'paired';
  mesh: THREE.Group | THREE.Object3D; // For paired: this is the collision mesh (invisible)
  position: THREE.Vector3;
  rotation: THREE.Euler;
  scale: THREE.Vector3;
  visible: boolean;
  splatMesh?: SplatMesh; // Reference to Spark splat mesh (for splat and paired types)
  collisionMeshVisible?: boolean; // For paired: show/hide the collision mesh for debugging
}

// Presentation slide - groups models together for PowerPoint-like presentation
interface PresentationSlide {
  id: string;
  name: string;
  modelIds: string[];  // References to SimulationModel.id
  hotspots: Hotspot[]; // Hotspots specific to this slide
  // Per-slide global section cut (off by default)
  sectionCut?: {
    enabled: boolean;
    height: number;
    showPlane: boolean;
  };
}

// Common RAL colors for architectural elements
const RAL_COLORS: { [key: string]: { name: string; hex: string } } = {
  '9010': { name: 'Pure White', hex: '#FFFFFF' },
  '9016': { name: 'Traffic White', hex: '#F6F6F6' },
  '9001': { name: 'Cream', hex: '#FDF4E3' },
  '7035': { name: 'Light Grey', hex: '#D7D7D7' },
  '7016': { name: 'Anthracite Grey', hex: '#293133' },
  '7015': { name: 'Slate Grey', hex: '#434B4D' },
  '3000': { name: 'Flame Red', hex: '#AF2B1E' },
  '5010': { name: 'Gentian Blue', hex: '#0E294B' },
  '6005': { name: 'Moss Green', hex: '#2F4538' },
  '8014': { name: 'Sepia Brown', hex: '#382C1E' },
  '1015': { name: 'Light Ivory', hex: '#E6D690' },
  '8017': { name: 'Chocolate Brown', hex: '#45322E' },
};

// Element type presets
const ELEMENT_PRESETS: { [key: string]: { ral: string; opacity: number } } = {
  wall: { ral: '9010', opacity: 1.0 },
  floor: { ral: '7035', opacity: 1.0 },
  door: { ral: '8014', opacity: 1.0 },
  window: { ral: '9010', opacity: 0.4 },
};

// Interface for selectable mesh parts
interface SelectableMeshPart {
  id: string;
  name: string;
  mesh: THREE.Mesh;
  originalColor: THREE.Color;
  originalOpacity: number;
  currentColor: string; // RAL code or hex
  currentOpacity: number;
  elementType: 'wall' | 'floor' | 'door' | 'window' | 'other';
}

// Interface for demolition volumes
interface DemolitionVolume {
  id: string;
  name: string;
  polygon: THREE.Vector2[]; // Base shape vertices (x, z coordinates)
  bottomY: number;
  topY: number;
  position: THREE.Vector3;
  rotation: THREE.Euler;
  scale: THREE.Vector3;
  affectedModels: string[] | 'all';
  visible: boolean;      // Whether the clipping effect is active
  showVolume: boolean;   // Whether to show the transparent volume mesh
  color: string;
}

// Interface for hotspots - interactive points on the model
interface Hotspot {
  id: string;
  name: string;
  description?: string;
  position: THREE.Vector3;  // 3D position in world space
  // Saved camera view to jump to when clicking
  savedView: {
    position: THREE.Vector3;
    target: THREE.Vector3;
  } | null;
  // Actions that can be triggered
  actions: {
    showDemolitionVolume?: string;  // ID of demolition volume to show
    showMeasurement?: string;        // ID of measurement to highlight
    activateSectionCut?: boolean;    // Activate global section cut
    sectionCutHeight?: number;       // Height for section cut
  };
  color: string;
  visible: boolean;
  // Optional linked image (data URL or project file reference)
  linkedImage?: string;
  // Optional 360 panoramic image (equirectangular, data URL)
  linked360Image?: string;
  // Linked demolition volume ID
  linkedDemolitionId?: string;
  // Linked measurement ID
  linkedMeasurementId?: string;
  // Section cut action triggered by this hotspot
  sectionCutAction?: { enabled: boolean; height: number };
}

// Interface for global section cut (horizontal plane cutting entire scene)
interface GlobalSectionCut {
  enabled: boolean;
  height: number;      // Y-coordinate of the cutting plane
  showPlane: boolean;  // Whether to visualize the cutting plane
}

// Common RAL colors for mesh part coloring
const ralColors = [
  { code: 'RAL 9010', hex: '#f1ece1' }, // Pure White
  { code: 'RAL 9016', hex: '#f7f7f2' }, // Traffic White
  { code: 'RAL 7035', hex: '#cbd0cc' }, // Light Grey
  { code: 'RAL 7016', hex: '#383e42' }, // Anthracite Grey
  { code: 'RAL 9005', hex: '#0e0e10' }, // Jet Black
  { code: 'RAL 3000', hex: '#a72920' }, // Flame Red
  { code: 'RAL 3003', hex: '#8d1d2c' }, // Ruby Red
  { code: 'RAL 5002', hex: '#00387b' }, // Ultramarine Blue
  { code: 'RAL 5010', hex: '#004f7c' }, // Gentian Blue
  { code: 'RAL 5015', hex: '#007cb0' }, // Sky Blue
  { code: 'RAL 6005', hex: '#0f4336' }, // Moss Green
  { code: 'RAL 6018', hex: '#48a43f' }, // Yellow Green
  { code: 'RAL 1015', hex: '#e6d2b5' }, // Light Ivory
  { code: 'RAL 1021', hex: '#eec900' }, // Rape Yellow
  { code: 'RAL 2004', hex: '#e25303' }, // Pure Orange
  { code: 'RAL 8001', hex: '#9c6b30' }, // Ochre Brown
  { code: 'RAL 8014', hex: '#4a3526' }, // Sepia Brown
  { code: 'RAL 8017', hex: '#44322d' }, // Chocolate Brown
];

const SimulationViewer = ({
  initialBuilding,
  projectFiles,
  onAddProjectFile,
  onRemoveProjectFile,
  projectFilesPanelOpen,
  onCloseProjectFilesPanel,
  presentationMode,
  onPresentationModeChange,
}: {
  initialBuilding: THREE.Group | null;
  projectFiles?: ProjectFile[];
  onAddProjectFile?: (file: Omit<ProjectFile, 'id' | 'createdAt'>) => ProjectFile;
  onRemoveProjectFile?: (id: string) => void;
  projectFilesPanelOpen?: boolean;
  onCloseProjectFilesPanel?: () => void;
  presentationMode?: boolean;
  onPresentationModeChange?: (mode: boolean) => void;
}) => {
  const { scene, renderer, camera, controls, fitToBox, setSectionPlane, setCustomRenderer } = useViewer();
  const [models, setModels] = useState<SimulationModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [sectionY, setSectionY] = useState(10);
  const [sectionEnabled, setSectionEnabled] = useState(false);
  const [splatLoadingProgress, setSplatLoadingProgress] = useState<number | null>(null);

  // Ribbon tab state (replaces old sidebar tabs)
  type RibbonTab = 'start' | 'import' | 'annotations' | 'presentation' | 'tools' | 'render';
  const [ribbonTab, setRibbonTab] = useState<RibbonTab>('start');
  const [slidePanelOpen, setSlidePanelOpen] = useState(true);
  type SidebarPanel = 'slides' | 'hotspots' | 'hotspot-editor' | 'measurements' | 'mesh-editor' | 'volumes' | 'volume-editor' | null;
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>('slides');

  const handleRibbonTabChange = useCallback((tab: RibbonTab) => {
    // Clear mode-specific state when leaving tabs
    if (tab !== 'render') {
      setSelectedMeshPartIds([]);
    }
    if (tab !== 'tools') {
      setDemolitionDrawMode('none');
      setPendingDemolitionPoints([]);
      setDemolitionGizmoEnabled(false);
      setSelectedDemolitionId(null);
    }
    if (tab !== 'annotations') {
      setMeasureToolMode('none');
      setHotspotPlacementMode(false);
    }
    setRibbonTab(tab);
  }, []);

  // Presentation slides state
  const [slides, setSlides] = useState<PresentationSlide[]>([
    { id: 'slide-1', name: 'Slide 1', modelIds: [], hotspots: [] }
  ]);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [compareMode, setCompareMode] = useState(false);
  const [comparePosition, setComparePosition] = useState(0.5); // 0-1, divider position
  const [isDraggingDivider, setIsDraggingDivider] = useState(false);
  // Compare mode snapshots: capture each slide as an image for true split-screen
  const [compareLeftSnapshot, setCompareLeftSnapshot] = useState<string | null>(null);
  const [compareRightSnapshot, setCompareRightSnapshot] = useState<string | null>(null);
  const [compareSnapshotsReady, setCompareSnapshotsReady] = useState(false);

  // Camera mode state
  const [cameraFrameEnabled, setCameraFrameEnabled] = useState(false);

  // Share presentation state
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [shareName, setShareName] = useState('');
  const [shareDescription, setShareDescription] = useState('');
  const [sharePdf, setSharePdf] = useState<File | null>(null);
  const [sharePdfDragOver, setSharePdfDragOver] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [shareResultUrl, setShareResultUrl] = useState<string | null>(null);
  const sharePdfInputRef = useRef<HTMLInputElement>(null);

  // Drag-and-drop state for simulation upload zone
  const [simModelDragOver, setSimModelDragOver] = useState(false);

  // Paired upload state: when user wants to combine mesh + splat
  const [pairedUploadMode, setPairedUploadMode] = useState<'none' | 'awaiting_splat'>('none');
  const [pendingCollisionMesh, setPendingCollisionMesh] = useState<{
    mesh: THREE.Group;
    name: string;
    url: string;
  } | null>(null);

  // Gaussian Splat mesh references
  const splatMeshesRef = useRef<Map<string, SplatMesh>>(new Map());

  // Models ref for use in render callbacks (avoids stale closure)
  const modelsRef = useRef<SimulationModel[]>([]);
  useEffect(() => {
    modelsRef.current = models;
  }, [models]);

  // Measurement state
  const [measureToolMode, setMeasureToolMode] = useState<MeasureToolMode>('none');
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [selectedMeasurementId, setSelectedMeasurementId] = useState<string | null>(null);
  const measurementManagerRef = useRef<MeasurementManager | null>(null);
  const pendingPointRef = useRef<MeasurementPoint | null>(null);
  const pendingPolygonPointsRef = useRef<MeasurementPoint[]>([]);

  // Transform gizmo state
  const [gizmoEnabled, setGizmoEnabled] = useState(false);
  const [gizmoMode, setGizmoMode] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const transformControlsRef = useRef<TransformControls | null>(null);

  // Render tab state
  const [meshParts, setMeshParts] = useState<SelectableMeshPart[]>([]);
  const [selectedMeshPartIds, setSelectedMeshPartIds] = useState<string[]>([]); // Support multi-select
  const outlineHelpersRef = useRef<Map<string, THREE.LineSegments>>(new Map());

  // Render environment state
  const [skyEnabled, setSkyEnabled] = useState(false);
  const [skyGroundLevel, setSkyGroundLevel] = useState(0); // Y position of horizon
  const [sunAzimuth, setSunAzimuth] = useState(45); // Horizontal angle (0-360)
  const [sunElevation, setSunElevation] = useState(45); // Height angle (0-90)
  const [floorPattern, setFloorPattern] = useState<'straight' | 'herringbone' | 'parquet' | 'chevron'>('straight');
  const [renderModeEnabled, setRenderModeEnabled] = useState(true);

  // Lighting refs
  const directionalLightRef = useRef<THREE.DirectionalLight | null>(null);
  const ambientLightRef = useRef<THREE.AmbientLight | null>(null);
  const hemiLightRef = useRef<THREE.HemisphereLight | null>(null);
  const skyMeshRef = useRef<THREE.Mesh | null>(null);
  const originalMaterialsRef = useRef<Map<string, THREE.Material>>(new Map());

  // Demolition volume state
  const [demolitionVolumes, setDemolitionVolumes] = useState<DemolitionVolume[]>([]);
  const [selectedDemolitionId, setSelectedDemolitionId] = useState<string | null>(null);
  const editingVolume = useMemo(() => selectedDemolitionId ? demolitionVolumes.find(v => v.id === selectedDemolitionId) ?? null : null, [demolitionVolumes, selectedDemolitionId]);
  const [demolitionDrawMode, setDemolitionDrawMode] = useState<'none' | 'drawing' | 'extruding'>('none');
  const [pendingDemolitionPoints, setPendingDemolitionPoints] = useState<THREE.Vector2[]>([]);
  const [demolitionGizmoEnabled, setDemolitionGizmoEnabled] = useState(false);
  const demolitionMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const demolitionPreviewRef = useRef<THREE.Group | null>(null);

  // Hotspot state - hotspots are now stored per-slide
  // Get current slide's hotspots
  const currentSlide = slides[activeSlideIndex];
  const hotspots = currentSlide?.hotspots || [];

  // Helper function to update hotspots for the current slide
  const setHotspots = useCallback((updater: Hotspot[] | ((prev: Hotspot[]) => Hotspot[])) => {
    setSlides(prev => prev.map((slide, idx) => {
      if (idx !== activeSlideIndex) return slide;
      const newHotspots = typeof updater === 'function'
        ? updater(slide.hotspots)
        : updater;
      return { ...slide, hotspots: newHotspots };
    }));
  }, [activeSlideIndex]);

  // Update a single hotspot by ID with partial data
  const updateHotspot = useCallback((hotspotId: string, updates: Partial<Hotspot>) => {
    setHotspots(prev => prev.map(h => h.id === hotspotId ? { ...h, ...updates } : h));
  }, [setHotspots]);

  // Delete a hotspot by ID
  const deleteHotspot = useCallback((hotspotId: string) => {
    setHotspots(prev => prev.filter(h => h.id !== hotspotId));
  }, [setHotspots]);

  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>(null);
  const [hotspotPlacementMode, setHotspotPlacementMode] = useState(false);
  const [editingHotspotId, setEditingHotspotId] = useState<string | null>(null);
  const editingHotspot = useMemo(() => editingHotspotId ? hotspots.find(h => h.id === editingHotspotId) ?? null : null, [hotspots, editingHotspotId]);
  const [activeHotspotId, setActiveHotspotId] = useState<string | null>(null); // Currently triggered hotspot
  const [hotspotImageSize, setHotspotImageSize] = useState<number>(280); // Width of image in popup
  const [fullViewImage, setFullViewImage] = useState<string | null>(null); // Full view image modal
  const [panoramaImage, setPanoramaImage] = useState<string | null>(null); // 360 panorama viewer
  const [panoramaTransition, setPanoramaTransition] = useState<{
    active: boolean;
    phase: 'zoom-in' | 'hold' | 'done';
    clickX: number;
    clickY: number;
    hotspotWorldPos: THREE.Vector3;
    imageUrl: string;
    startTime: number;
  } | null>(null);
  const panoramaTransitionRef = useRef(panoramaTransition);
  panoramaTransitionRef.current = panoramaTransition;
  const [isResizingImage, setIsResizingImage] = useState(false);
  const hotspotMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const hotspotGizmoEnabled = useRef(false);
  // Store initial camera state for reset
  const initialCameraState = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);

  // Global section cut state
  const [globalSectionCut, setGlobalSectionCut] = useState<GlobalSectionCut>({
    enabled: false,
    height: 5,
    showPlane: true
  });
  const globalSectionPlaneRef = useRef<THREE.Mesh | null>(null);

  // Presentation mode state - use prop if provided, otherwise internal state
  const [internalPresentationMode, setInternalPresentationMode] = useState(false);
  const isPresentationMode = presentationMode ?? internalPresentationMode;
  const setPresentationModeValue = useCallback((value: boolean) => {
    if (onPresentationModeChange) {
      onPresentationModeChange(value);
    } else {
      setInternalPresentationMode(value);
    }
  }, [onPresentationModeChange]);
  const [presentationSidebarVisible, setPresentationSidebarVisible] = useState(true);

  // Camera capture function
  const handleCaptureImage = useCallback(() => {
    if (!renderer || !scene || !camera) return;

    // Get the canvas dimensions
    const canvas = renderer.domElement;
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;

    // Calculate 16:9 frame dimensions centered in the canvas
    const targetAspect = 16 / 9;
    const canvasAspect = canvasWidth / canvasHeight;

    let frameWidth: number, frameHeight: number;
    let frameX: number, frameY: number;

    if (canvasAspect > targetAspect) {
      // Canvas is wider than 16:9, use full height
      frameHeight = canvasHeight;
      frameWidth = frameHeight * targetAspect;
      frameX = (canvasWidth - frameWidth) / 2;
      frameY = 0;
    } else {
      // Canvas is taller than 16:9, use full width
      frameWidth = canvasWidth;
      frameHeight = frameWidth / targetAspect;
      frameX = 0;
      frameY = (canvasHeight - frameHeight) / 2;
    }

    // Render the scene
    renderer.render(scene, camera);

    // Create a temporary canvas to crop the image
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = frameWidth;
    tempCanvas.height = frameHeight;
    const ctx = tempCanvas.getContext('2d');
    if (!ctx) return;

    // Draw the cropped portion
    ctx.drawImage(
      canvas,
      frameX, frameY, frameWidth, frameHeight,
      0, 0, frameWidth, frameHeight
    );

    // Convert to base64
    const imageData = tempCanvas.toDataURL('image/png');

    // Add to project files
    if (onAddProjectFile) {
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false }).replace(/:/g, '-');
      onAddProjectFile({
        name: `Capture_${timestamp}.png`,
        type: 'png',
        content: imageData,
        source: 'simulation'
      });
    }
  }, [renderer, scene, camera, onAddProjectFile]);

  // Export a single THREE.js model to GLB blob
  const exportModelToGLB = useCallback(async (model: SimulationModel): Promise<Blob> => {
    const exporter = new GLTFExporter();
    return new Promise((resolve, reject) => {
      exporter.parse(
        model.mesh,
        (result) => {
          resolve(new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' }));
        },
        (error) => reject(error),
        { binary: true }
      );
    });
  }, []);

  // Handle sharing the presentation
  const handleSharePresentation = useCallback(async () => {
    if (!shareName.trim() || isSharing) return;
    setIsSharing(true);

    try {
      const shareId = generateShareId();

      // Export mesh-based models to GLB
      const exportableModels = models.filter(m => m.type === 'building' || m.type === 'environment');
      const modelBlobs = new Map<string, Blob>();

      for (const model of exportableModels) {
        try {
          const blob = await exportModelToGLB(model);
          modelBlobs.set(model.id, blob);
        } catch (err) {
          console.warn(`Failed to export model ${model.name}:`, err);
        }
      }

      // Serialize models
      const sharedModels: SharedModel[] = exportableModels
        .filter(m => modelBlobs.has(m.id))
        .map(m => ({
          id: m.id,
          name: m.name,
          type: m.type,
          glbFilename: `model_${m.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}.glb`,
          position: { x: m.position.x, y: m.position.y, z: m.position.z },
          rotation: { x: m.rotation.x, y: m.rotation.y, z: m.rotation.z },
          scale: { x: m.scale.x, y: m.scale.y, z: m.scale.z },
        }));

      // Serialize slides & hotspots
      const sharedSlides: SharedSlide[] = slides.map(s => ({
        id: s.id,
        name: s.name,
        modelIds: s.modelIds.filter(id => sharedModels.some(m => m.id === id)),
        hotspots: s.hotspots.map((h): SharedHotspot => ({
          id: h.id,
          name: h.name,
          description: h.description,
          position: { x: h.position.x, y: h.position.y, z: h.position.z },
          savedView: h.savedView ? {
            position: { x: h.savedView.position.x, y: h.savedView.position.y, z: h.savedView.position.z },
            target: { x: h.savedView.target.x, y: h.savedView.target.y, z: h.savedView.target.z },
          } : null,
          color: h.color,
          sectionCutAction: h.sectionCutAction,
          linkedImage: h.linkedImage,
        })),
        sectionCut: s.sectionCut,
      }));

      const metadata: SharedPresentation = {
        id: shareId,
        name: shareName.trim(),
        description: shareDescription.trim(),
        createdAt: new Date().toISOString(),
        slides: sharedSlides,
        models: sharedModels,
        pdfFilename: null,
      };

      // Build FormData
      const formData = new FormData();
      formData.append('metadata', JSON.stringify(metadata));

      for (const model of sharedModels) {
        const blob = modelBlobs.get(model.id);
        if (blob) {
          formData.append(`model_${model.id}`, blob, model.glbFilename);
        }
      }

      if (sharePdf) {
        formData.append('pdf', sharePdf);
      }

      // Upload
      const response = await fetch('/api/share', { method: 'POST', body: formData });
      const result = await response.json();

      if (result.success) {
        setShareResultUrl(`${window.location.origin}/share/${shareId}`);
      } else {
        alert('Failed to share: ' + (result.error || 'Unknown error'));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      alert('Error sharing presentation: ' + message);
    } finally {
      setIsSharing(false);
    }
  }, [shareName, shareDescription, sharePdf, isSharing, models, slides, exportModelToGLB]);

  // Initialize MeasurementManager
  useEffect(() => {
    if (scene && !measurementManagerRef.current) {
      measurementManagerRef.current = new MeasurementManager(scene);
    }
  }, [scene]);

  // Sync global section cut to MeasurementManager for snap filtering
  useEffect(() => {
    if (measurementManagerRef.current) {
      measurementManagerRef.current.setSectionCutY(globalSectionCut.enabled ? globalSectionCut.height : null);
    }
  }, [globalSectionCut.enabled, globalSectionCut.height]);

  // Initialize TransformControls
  useEffect(() => {
    if (!scene || !camera || !renderer || !controls) return;

    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setSize(0.75);
    scene.add(transformControls.getHelper());
    transformControlsRef.current = transformControls;

    // Disable orbit controls while dragging the gizmo
    transformControls.addEventListener('dragging-changed', (event) => {
      controls.enabled = !event.value;
    });

    // Update model/demolition state when gizmo is used
    transformControls.addEventListener('objectChange', () => {
      const object = transformControls.object;
      if (!object) return;

      // Check if it's a demolition volume
      if (object.name.startsWith('demolition_')) {
        const volumeId = object.name.replace('demolition_', '');
        setDemolitionVolumes(prev => prev.map(v => {
          if (v.id !== volumeId) return v;
          return {
            ...v,
            position: object.position.clone(),
            rotation: object.rotation.clone(),
            scale: object.scale.clone()
          };
        }));
        return;
      }

      // Handle model gizmo
      if (selectedModelId) {
        const model = models.find(m => m.id === selectedModelId);
        if (model) {
          // For paired models, also update the splat mesh position
          if (model.type === 'paired' && model.splatMesh) {
            model.splatMesh.position.copy(object.position);
            model.splatMesh.rotation.copy(object.rotation);
            model.splatMesh.scale.copy(object.scale);
          }
          // Update model state
          setModels(prev => prev.map(m => {
            if (m.id !== selectedModelId) return m;
            return {
              ...m,
              position: object.position.clone(),
              rotation: object.rotation.clone(),
              scale: object.scale.clone()
            };
          }));
        }
      }
    });

    return () => {
      transformControls.detach(); // Detach before removing
      scene.remove(transformControls.getHelper());
      transformControls.dispose();
      transformControlsRef.current = null;
    };
  }, [scene, camera, renderer, controls]);

  // Helper function to check if object is in scene graph
  const isInScene = useCallback((obj: THREE.Object3D | undefined | null): boolean => {
    if (!obj || !scene) return false;
    let current: THREE.Object3D | null = obj;
    while (current) {
      if (current === scene) return true;
      current = current.parent;
    }
    return false;
  }, [scene]);

  // Safety: detach transform controls if attached object is no longer in scene
  useEffect(() => {
    if (!transformControlsRef.current) return;
    const attached = transformControlsRef.current.object;
    if (attached && !isInScene(attached)) {
      transformControlsRef.current.detach();
    }
  }, [models, demolitionVolumes, isInScene]);

  // Attach/detach gizmo based on selection and gizmoEnabled (for models)
  useEffect(() => {
    if (!transformControlsRef.current || !scene) return;

    // Never attach gizmos in presentation mode
    if (isPresentationMode) {
      transformControlsRef.current.detach();
      return;
    }

    // Don't attach to model if demolition gizmo is active
    if (demolitionGizmoEnabled) {
      // Detach from any model when switching to demolition mode
      if (transformControlsRef.current.object && !transformControlsRef.current.object.name.startsWith('demolition_')) {
        transformControlsRef.current.detach();
      }
      return;
    }

    if (gizmoEnabled && selectedModelId) {
      const model = models.find(m => m.id === selectedModelId);
      if (model) {
        // For splat-only models, attach to the splat mesh; for others, attach to mesh
        const targetObject = model.type === 'splat' ? model.splatMesh : model.mesh;
        // Only attach if the object exists and is actually in the scene graph
        if (targetObject && isInScene(targetObject)) {
          transformControlsRef.current.attach(targetObject as THREE.Object3D);
          transformControlsRef.current.setMode(gizmoMode);
        } else {
          transformControlsRef.current.detach();
        }
      } else {
        transformControlsRef.current.detach();
      }
    } else {
      transformControlsRef.current.detach();
    }
  }, [gizmoEnabled, selectedModelId, gizmoMode, models, demolitionGizmoEnabled, scene, isInScene, isPresentationMode]);

  // Attach/detach gizmo for demolition volumes
  useEffect(() => {
    if (!transformControlsRef.current || !scene) return;

    // Never attach gizmos in presentation mode
    if (isPresentationMode) {
      transformControlsRef.current.detach();
      return;
    }

    if (demolitionGizmoEnabled && selectedDemolitionId) {
      const mesh = demolitionMeshesRef.current.get(selectedDemolitionId);
      // Only attach if mesh exists and is actually in the scene graph
      if (mesh && isInScene(mesh)) {
        transformControlsRef.current.attach(mesh);
        transformControlsRef.current.setMode(gizmoMode);
      } else {
        transformControlsRef.current.detach();
      }
    } else {
      // Detach when demolition gizmo disabled or no selection
      transformControlsRef.current.detach();
    }
  }, [demolitionGizmoEnabled, selectedDemolitionId, gizmoMode, scene, isInScene, isPresentationMode]);

  // Attach/detach gizmo for hotspots
  useEffect(() => {
    if (!transformControlsRef.current || !scene) return;

    // Never attach gizmos in presentation mode
    if (isPresentationMode) {
      transformControlsRef.current.detach();
      return;
    }

    // Only handle hotspot gizmo when not handling models or demolition
    if (gizmoEnabled || demolitionGizmoEnabled) {
      // Don't interfere when other gizmos are active
      return;
    }

    if (selectedHotspotId) {
      const mesh = hotspotMeshesRef.current.get(selectedHotspotId);
      if (mesh && isInScene(mesh)) {
        transformControlsRef.current.attach(mesh);
        transformControlsRef.current.setMode('translate'); // Hotspots only support translate
      } else {
        // Mesh not in scene, detach
        transformControlsRef.current.detach();
      }
    } else {
      // No hotspot selected, detach
      transformControlsRef.current.detach();
    }
  }, [selectedHotspotId, gizmoEnabled, demolitionGizmoEnabled, scene, isInScene, isPresentationMode]);

  // Sync hotspot position when gizmo is used to move it
  useEffect(() => {
    if (!transformControlsRef.current) return;

    const handleChange = () => {
      if (selectedHotspotId) {
        const mesh = hotspotMeshesRef.current.get(selectedHotspotId);
        if (mesh) {
          setHotspots(prev => prev.map(h =>
            h.id === selectedHotspotId
              ? { ...h, position: mesh.position.clone() }
              : h
          ));
        }
      }
    };

    transformControlsRef.current.addEventListener('change', handleChange);
    return () => {
      transformControlsRef.current?.removeEventListener('change', handleChange);
    };
  }, [selectedHotspotId]);

  // Update gizmo mode when changed
  useEffect(() => {
    if (transformControlsRef.current) {
      transformControlsRef.current.setMode(gizmoMode);
    }
  }, [gizmoMode]);

  // Capture initial camera state for reset functionality
  useEffect(() => {
    if (camera && controls && !initialCameraState.current) {
      // Wait a bit for camera to be positioned
      const timeout = setTimeout(() => {
        initialCameraState.current = {
          position: camera.position.clone(),
          target: controls.target.clone()
        };
      }, 500);
      return () => clearTimeout(timeout);
    }
  }, [camera, controls]);

  // Reset function to restore initial camera and disable section cut
  const resetToInitialView = useCallback(() => {
    // Reset camera to initial position
    if (initialCameraState.current && camera && controls) {
      camera.position.copy(initialCameraState.current.position);
      controls.target.copy(initialCameraState.current.target);
      controls.update();
    }

    // Disable global section cut
    setGlobalSectionCut(prev => ({ ...prev, enabled: false }));

    // Clear active hotspot
    setActiveHotspotId(null);

    // Disable all demolition volumes (set visible: false to turn off clipping) AND remove global section cut volume
    setDemolitionVolumes(prev => prev
      .filter(v => v.id !== 'global-section-cut-volume')
      .map(v => ({ ...v, visible: false }))
    );

    // Immediately clear clipping planes from all scene meshes
    if (scene) {
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.material) {
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
          materials.forEach((mat) => {
            if (mat.clippingPlanes && mat.clippingPlanes.length > 0) {
              mat.clippingPlanes = [];
              mat.clipIntersection = false;
              mat.needsUpdate = true;
            }
          });
        }
      });
    }

    // Clear splat mesh edits
    models.forEach(model => {
      if ((model.type === 'splat' || model.type === 'paired') && model.splatMesh) {
        model.splatMesh.edits = null;
      }
    });

    // Clear measurement selection and hide measurements in presentation mode
    setSelectedMeasurementId(null);
    if (isPresentationMode && measurementManagerRef.current) {
      measurementManagerRef.current.setAllVisible(false);
    }
  }, [camera, controls, scene, models, isPresentationMode]);

  // Clear hotspot selection when active slide INDEX changes
  useEffect(() => {
    setSelectedHotspotId(null);
    setEditingHotspotId(null);
    setActiveHotspotId(null);
    // Hide all measurements when changing slides in presentation mode
    if (isPresentationMode && measurementManagerRef.current) {
      measurementManagerRef.current.setAllVisible(false);
    }
  }, [activeSlideIndex, isPresentationMode]);

  // Apply per-slide section cut when slide content or index changes
  const slideSectionCutRef = useRef(slides[activeSlideIndex]?.sectionCut);
  useEffect(() => {
    const slideSectionCut = slides[activeSlideIndex]?.sectionCut;
    // Only update global section cut if the section cut settings actually changed
    const prev = slideSectionCutRef.current;
    if (prev?.enabled !== slideSectionCut?.enabled || prev?.height !== slideSectionCut?.height || prev?.showPlane !== slideSectionCut?.showPlane) {
      slideSectionCutRef.current = slideSectionCut;
      if (slideSectionCut?.enabled) {
        setGlobalSectionCut({
          enabled: true,
          height: slideSectionCut.height,
          showPlane: slideSectionCut.showPlane
        });
      } else {
        setGlobalSectionCut(prev => ({ ...prev, enabled: false }));
      }
    }
  }, [activeSlideIndex, slides]);

  // Hide all measurements when entering presentation mode
  useEffect(() => {
    if (measurementManagerRef.current) {
      if (isPresentationMode) {
        // Hide all measurements in presentation mode
        measurementManagerRef.current.setAllVisible(false);
      } else {
        // Show all measurements when exiting presentation mode
        measurementManagerRef.current.setAllVisible(true);
      }
    }
  }, [isPresentationMode]);

  // Hide all gizmos and disable gizmo modes when in presentation mode
  useEffect(() => {
    if (isPresentationMode) {
      // Disable all gizmo modes
      setGizmoEnabled(false);
      setDemolitionGizmoEnabled(false);
      setSelectedModelId(null);
      setSelectedDemolitionId(null);
      setSelectedHotspotId(null);

      // Detach transform controls
      if (transformControlsRef.current) {
        transformControlsRef.current.detach();
      }
    }
  }, [isPresentationMode]);

  // Initialize enhanced lighting for simulation
  useEffect(() => {
    if (!scene || !renderer) return;

    // Set up tone mapping for better lighting response
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    // Ambient light - soft overall illumination
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    ambientLight.name = 'simulation_ambient';
    scene.add(ambientLight);
    ambientLightRef.current = ambientLight;

    // Hemisphere light - sky/ground gradient
    const hemiLight = new THREE.HemisphereLight(0x87CEEB, 0x8B7355, 0.3);
    hemiLight.name = 'simulation_hemisphere';
    scene.add(hemiLight);
    hemiLightRef.current = hemiLight;

    // Directional light - sun
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.name = 'simulation_sun';
    dirLight.position.set(50, 50, 50);
    scene.add(dirLight);
    directionalLightRef.current = dirLight;

    return () => {
      if (ambientLightRef.current) scene.remove(ambientLightRef.current);
      if (hemiLightRef.current) scene.remove(hemiLightRef.current);
      if (directionalLightRef.current) scene.remove(directionalLightRef.current);
    };
  }, [scene, renderer]);

  // Update model visibility based on active slide (not in compare mode)
  useEffect(() => {
    if (compareMode || !scene) return; // Compare mode handles visibility differently

    const activeSlide = slides[activeSlideIndex];
    if (!activeSlide) return;

    models.forEach(model => {
      const shouldBeVisible = activeSlide.modelIds.includes(model.id);
      if (model.mesh) {
        model.mesh.visible = shouldBeVisible;
      }
      // For splats, ensure they're in the scene when visible, removed when not
      if (model.splatMesh) {
        const isInScene = scene.children.includes(model.splatMesh);
        if (shouldBeVisible && !isInScene) {
          scene.add(model.splatMesh);
        } else if (!shouldBeVisible && isInScene) {
          scene.remove(model.splatMesh);
        }
        model.splatMesh.visible = shouldBeVisible;
      }
    });
  }, [activeSlideIndex, slides, models, compareMode, scene]);

  // Refs for compare mode to track slide data without re-creating callback
  const compareSlidesRef = useRef(slides);
  const compareActiveSlideIndexRef = useRef(activeSlideIndex);
  const comparePositionRef = useRef(comparePosition);

  useEffect(() => {
    compareSlidesRef.current = slides;
    compareActiveSlideIndexRef.current = activeSlideIndex;
    comparePositionRef.current = comparePosition;
  }, [slides, activeSlideIndex, comparePosition]);

  // Capture snapshots when compare mode is enabled
  // Uses snapshot-based split-screen since WebGL scissor doesn't work with Spark splats
  useEffect(() => {
    if (!compareMode || slides.length < 2 || !renderer || !scene || !camera) {
      setCompareSnapshotsReady(false);
      setCompareLeftSnapshot(null);
      setCompareRightSnapshot(null);
      return;
    }

    // Helper: build section cut clipping planes for a given height
    const buildSectionClipPlanes = (height: number): THREE.Plane[] => {
      const size = 500;
      const polygon = [
        new THREE.Vector2(-size, -size),
        new THREE.Vector2(size, -size),
        new THREE.Vector2(size, size),
        new THREE.Vector2(-size, size),
      ];
      const planes: THREE.Plane[] = [];
      // Side planes with outward normals (same logic as createGlobalSectionVolume + clipping effect)
      const centroidX = 0, centroidZ = 0;
      for (let i = 0; i < polygon.length; i++) {
        const p1 = polygon[i];
        const p2 = polygon[(i + 1) % polygon.length];
        const worldP1 = new THREE.Vector3(p1.x, 0, p1.y);
        const worldP2 = new THREE.Vector3(p2.x, 0, p2.y);
        const edge = new THREE.Vector3().subVectors(worldP2, worldP1);
        const midpoint = new THREE.Vector3().addVectors(worldP1, worldP2).multiplyScalar(0.5);
        const toCenter = new THREE.Vector3(centroidX - midpoint.x, 0, centroidZ - midpoint.z);
        let normal = new THREE.Vector3(edge.z, 0, -edge.x).normalize();
        if (normal.dot(toCenter) > 0) normal.negate();
        planes.push(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, worldP1));
      }
      // Top plane (clips above height)
      planes.push(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(height)));
      // Bottom plane
      planes.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), height));
      return planes;
    };

    // Helper: apply or clear clipping planes on all scene meshes
    const applySectionClip = (clipPlanes: THREE.Plane[]) => {
      scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh) || !obj.material) return;
        if (obj.name.includes('demolition') || obj.name.includes('section') || obj.name.includes('measurement')) return;
        if (obj.parent?.name?.includes('demolition') || obj.parent?.name?.includes('section')) return;
        if (obj.parent?.name?.includes('measurement') || obj.parent?.name?.includes('pending')) return;
        if (obj.name === 'globalSectionPlane') return;

        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        if (clipPlanes.length > 0) {
          materials.forEach((mat) => {
            mat.clippingPlanes = clipPlanes;
            mat.clipIntersection = true;
            mat.clipShadows = true;
            mat.side = THREE.DoubleSide;
            mat.needsUpdate = true;
          });
        } else {
          materials.forEach((mat) => {
            mat.clippingPlanes = [];
            mat.clipIntersection = false;
            mat.needsUpdate = true;
          });
        }
      });
    };

    const captureSnapshot = async (slide: PresentationSlide): Promise<string> => {
      // Set visibility for this slide's models
      let hasSplat = false;
      models.forEach(model => {
        const shouldBeVisible = slide.modelIds.includes(model.id);
        if (model.mesh) model.mesh.visible = shouldBeVisible;
        if (model.splatMesh) {
          hasSplat = hasSplat || shouldBeVisible;
          const isInScene = scene.children.includes(model.splatMesh);
          if (shouldBeVisible && !isInScene) {
            scene.add(model.splatMesh);
          } else if (!shouldBeVisible && isInScene) {
            scene.remove(model.splatMesh);
          }
          model.splatMesh.visible = shouldBeVisible;
        }
      });

      // Apply this slide's section cut (or clear if slide has no section cut)
      if (slide.sectionCut?.enabled) {
        const clipPlanes = buildSectionClipPlanes(slide.sectionCut.height);
        applySectionClip(clipPlanes);
        // Show/hide section plane visualization
        if (globalSectionPlaneRef.current) {
          globalSectionPlaneRef.current.visible = slide.sectionCut.showPlane;
          globalSectionPlaneRef.current.position.y = slide.sectionCut.height;
        }
      } else {
        applySectionClip([]);
        if (globalSectionPlaneRef.current) {
          globalSectionPlaneRef.current.visible = false;
        }
      }

      // Wait for multiple frames - splats need more time to render
      // Especially after being added to the scene
      const waitFrames = hasSplat ? 10 : 2;
      for (let i = 0; i < waitFrames; i++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        renderer.render(scene, camera);
      }

      // Final render and capture
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    };

    const captureSnapshots = async () => {
      setCompareSnapshotsReady(false);

      const activeSlide = slides[activeSlideIndex];
      const nextSlideIndex = Math.min(activeSlideIndex + 1, slides.length - 1);
      const nextSlide = slides[nextSlideIndex];

      if (!activeSlide || !nextSlide) return;

      // Detach TransformControls before capturing to avoid errors
      // when objects are removed from scene during snapshot capture
      const transformControls = transformControlsRef.current;
      const previouslyAttachedObject = transformControls?.object;
      if (transformControls && previouslyAttachedObject) {
        transformControls.detach();
      }

      // Capture left slide (active)
      const leftSnapshot = await captureSnapshot(activeSlide);

      // Capture right slide (next)
      const rightSnapshot = await captureSnapshot(nextSlide);

      setCompareLeftSnapshot(leftSnapshot);
      setCompareRightSnapshot(rightSnapshot);
      setCompareSnapshotsReady(true);

      // Restore active slide visibility
      models.forEach(model => {
        const shouldBeVisible = activeSlide.modelIds.includes(model.id);
        if (model.mesh) model.mesh.visible = shouldBeVisible;
        if (model.splatMesh) {
          const isInScene = scene.children.includes(model.splatMesh);
          if (shouldBeVisible && !isInScene) {
            scene.add(model.splatMesh);
          } else if (!shouldBeVisible && isInScene) {
            scene.remove(model.splatMesh);
          }
          model.splatMesh.visible = shouldBeVisible;
        }
      });

      // Restore active slide's section cut
      if (activeSlide.sectionCut?.enabled) {
        const clipPlanes = buildSectionClipPlanes(activeSlide.sectionCut.height);
        applySectionClip(clipPlanes);
        if (globalSectionPlaneRef.current) {
          globalSectionPlaneRef.current.visible = activeSlide.sectionCut.showPlane;
          globalSectionPlaneRef.current.position.y = activeSlide.sectionCut.height;
        }
      } else {
        applySectionClip([]);
        if (globalSectionPlaneRef.current) {
          globalSectionPlaneRef.current.visible = false;
        }
      }

      // Reattach TransformControls if it was previously attached
      // and the object is still in the scene - use the isInScene helper
      if (transformControls && previouslyAttachedObject) {
        // Check if object is in scene by walking up parent chain
        let current: THREE.Object3D | null = previouslyAttachedObject;
        let foundInScene = false;
        while (current) {
          if (current === scene) {
            foundInScene = true;
            break;
          }
          current = current.parent;
        }
        if (foundInScene) {
          transformControls.attach(previouslyAttachedObject);
        }
      }
    };

    captureSnapshots();
  }, [compareMode, slides, activeSlideIndex, models, scene, renderer, camera]);

  // Update sun position when azimuth/elevation changes
  useEffect(() => {
    if (!directionalLightRef.current) return;

    // Convert angles to radians
    const azimuthRad = (sunAzimuth * Math.PI) / 180;
    const elevationRad = (sunElevation * Math.PI) / 180;

    // Calculate sun position (spherical to cartesian)
    const distance = 100;
    const x = distance * Math.cos(elevationRad) * Math.sin(azimuthRad);
    const y = distance * Math.sin(elevationRad);
    const z = distance * Math.cos(elevationRad) * Math.cos(azimuthRad);

    directionalLightRef.current.position.set(x, y, z);
  }, [sunAzimuth, sunElevation]);

  // Create/update sky dome
  useEffect(() => {
    if (!scene) return;

    // Remove existing sky
    if (skyMeshRef.current) {
      scene.remove(skyMeshRef.current);
      skyMeshRef.current.geometry.dispose();
      (skyMeshRef.current.material as THREE.Material).dispose();
      skyMeshRef.current = null;
    }

    if (skyEnabled) {
      // Create sky dome with gradient shader
      const skyGeo = new THREE.SphereGeometry(500, 32, 32);
      const skyMat = new THREE.ShaderMaterial({
        uniforms: {
          topColor: { value: new THREE.Color(0x87CEEB) }, // Sky blue
          horizonColor: { value: new THREE.Color(0xE0E8F0) }, // Light horizon
          bottomColor: { value: new THREE.Color(0x3D3D3D) }, // Dark ground
          groundLevel: { value: skyGroundLevel },
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
          uniform vec3 horizonColor;
          uniform vec3 bottomColor;
          uniform float groundLevel;
          uniform float offset;
          uniform float exponent;
          varying vec3 vWorldPosition;
          void main() {
            float h = normalize(vWorldPosition + offset).y;
            float adjustedH = h - groundLevel * 0.002;
            if (adjustedH > 0.0) {
              // Above horizon: blend from horizon to sky
              float t = pow(adjustedH, exponent);
              gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0);
            } else {
              // Below horizon: blend from horizon to ground
              float t = pow(-adjustedH, exponent * 0.5);
              gl_FragColor = vec4(mix(horizonColor, bottomColor, min(t, 1.0)), 1.0);
            }
          }
        `,
        side: THREE.BackSide,
        depthWrite: false
      });

      const sky = new THREE.Mesh(skyGeo, skyMat);
      sky.name = 'sky_dome';
      sky.renderOrder = -1000;
      scene.add(sky);
      skyMeshRef.current = sky;

      // Update background
      scene.background = null;
    } else {
      // White background
      scene.background = new THREE.Color(0xf5f5f5);
    }
  }, [scene, skyEnabled, skyGroundLevel]);

  // Procedural material generators
  const createStuccoMaterial = useCallback((baseColor: THREE.Color, opacity: number = 1): THREE.MeshStandardMaterial => {
    // Create procedural stucco/plaster texture
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;

    // Base color fill
    const r = Math.floor(baseColor.r * 255);
    const g = Math.floor(baseColor.g * 255);
    const b = Math.floor(baseColor.b * 255);
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, 0, 256, 256);

    // Add stucco noise texture
    for (let i = 0; i < 3000; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const size = Math.random() * 3 + 1;
      const variation = Math.floor((Math.random() - 0.5) * 30);
      ctx.fillStyle = `rgb(${Math.max(0, Math.min(255, r + variation))}, ${Math.max(0, Math.min(255, g + variation))}, ${Math.max(0, Math.min(255, b + variation))})`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }

    // Add some larger grain
    for (let i = 0; i < 500; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const size = Math.random() * 4 + 2;
      const variation = Math.floor((Math.random() - 0.5) * 20);
      ctx.fillStyle = `rgba(${Math.max(0, Math.min(255, r + variation))}, ${Math.max(0, Math.min(255, g + variation))}, ${Math.max(0, Math.min(255, b + variation))}, 0.5)`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2, 2);

    // Create bump map for surface detail
    const bumpCanvas = document.createElement('canvas');
    bumpCanvas.width = 256;
    bumpCanvas.height = 256;
    const bumpCtx = bumpCanvas.getContext('2d')!;
    bumpCtx.fillStyle = '#808080';
    bumpCtx.fillRect(0, 0, 256, 256);

    // Random bumps
    for (let i = 0; i < 2000; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const size = Math.random() * 3 + 1;
      const brightness = Math.floor(128 + (Math.random() - 0.5) * 80);
      bumpCtx.fillStyle = `rgb(${brightness}, ${brightness}, ${brightness})`;
      bumpCtx.beginPath();
      bumpCtx.arc(x, y, size, 0, Math.PI * 2);
      bumpCtx.fill();
    }

    const bumpTexture = new THREE.CanvasTexture(bumpCanvas);
    bumpTexture.wrapS = THREE.RepeatWrapping;
    bumpTexture.wrapT = THREE.RepeatWrapping;
    bumpTexture.repeat.set(2, 2);

    const mat = new THREE.MeshStandardMaterial({
      map: texture,
      bumpMap: bumpTexture,
      bumpScale: 0.02,
      roughness: 0.85,
      metalness: 0.0,
      transparent: opacity < 1,
      opacity: opacity,
    });
    return mat;
  }, []);

  const createMetalMaterial = useCallback((baseColor: THREE.Color, opacity: number = 1): THREE.MeshStandardMaterial => {
    const mat = new THREE.MeshStandardMaterial({
      color: baseColor,
      roughness: 0.3,
      metalness: 0.8,
      transparent: opacity < 1,
      opacity: opacity,
    });
    return mat;
  }, []);

  const createGlassMaterial = useCallback((opacity: number = 0.4): THREE.MeshStandardMaterial => {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xadd8e6),
      roughness: 0.1,
      metalness: 0.0,
      transparent: true,
      opacity: opacity,
    });
    return mat;
  }, []);

  const createWoodFloorMaterial = useCallback((pattern: string, baseColor: THREE.Color): THREE.MeshStandardMaterial => {
    // Create a canvas for procedural wood texture
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;

    // Base wood color
    const r = Math.floor(baseColor.r * 255);
    const g = Math.floor(baseColor.g * 255);
    const b = Math.floor(baseColor.b * 255);

    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, 0, 512, 512);

    // Draw pattern
    ctx.strokeStyle = `rgb(${Math.max(0, r - 30)}, ${Math.max(0, g - 25)}, ${Math.max(0, b - 20)})`;
    ctx.lineWidth = 2;

    if (pattern === 'straight') {
      // Straight planks
      const plankWidth = 64;
      for (let x = 0; x < 512; x += plankWidth) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 512);
        ctx.stroke();
        // Add wood grain lines
        for (let y = 0; y < 512; y += 8 + Math.random() * 16) {
          ctx.beginPath();
          ctx.moveTo(x + 5, y);
          ctx.lineTo(x + plankWidth - 5, y + (Math.random() - 0.5) * 10);
          ctx.strokeStyle = `rgba(${Math.max(0, r - 20)}, ${Math.max(0, g - 15)}, ${Math.max(0, b - 10)}, 0.3)`;
          ctx.stroke();
        }
        ctx.strokeStyle = `rgb(${Math.max(0, r - 30)}, ${Math.max(0, g - 25)}, ${Math.max(0, b - 20)})`;
      }
    } else if (pattern === 'herringbone') {
      // Herringbone pattern
      const plankW = 40;
      const plankH = 120;
      for (let row = -2; row < 10; row++) {
        for (let col = -2; col < 10; col++) {
          const offsetX = (col * plankH);
          const offsetY = (row * plankW * 2) + (col % 2 === 0 ? 0 : plankW);
          ctx.save();
          ctx.translate(offsetX, offsetY);
          ctx.rotate((col % 2 === 0 ? 1 : -1) * Math.PI / 4);
          ctx.strokeRect(-plankH / 2, -plankW / 2, plankH, plankW);
          ctx.restore();
        }
      }
    } else if (pattern === 'parquet') {
      // Parquet squares
      const squareSize = 128;
      for (let x = 0; x < 512; x += squareSize) {
        for (let y = 0; y < 512; y += squareSize) {
          const horizontal = ((x + y) / squareSize) % 2 === 0;
          ctx.save();
          ctx.translate(x, y);
          if (horizontal) {
            for (let i = 0; i < squareSize; i += 32) {
              ctx.beginPath();
              ctx.moveTo(0, i);
              ctx.lineTo(squareSize, i);
              ctx.stroke();
            }
          } else {
            for (let i = 0; i < squareSize; i += 32) {
              ctx.beginPath();
              ctx.moveTo(i, 0);
              ctx.lineTo(i, squareSize);
              ctx.stroke();
            }
          }
          ctx.strokeRect(0, 0, squareSize, squareSize);
          ctx.restore();
        }
      }
    } else if (pattern === 'chevron') {
      // Chevron pattern
      const plankW = 30;
      const plankH = 100;
      for (let row = 0; row < 12; row++) {
        for (let col = 0; col < 12; col++) {
          const baseX = col * plankH * 0.7;
          const baseY = row * plankW * 2;
          ctx.save();
          ctx.translate(baseX, baseY);
          ctx.rotate(Math.PI / 6);
          ctx.strokeRect(0, 0, plankH, plankW);
          ctx.restore();
          ctx.save();
          ctx.translate(baseX + plankH * 0.6, baseY);
          ctx.rotate(-Math.PI / 6);
          ctx.strokeRect(0, 0, plankH, plankW);
          ctx.restore();
        }
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(4, 4);

    const mat = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.6,
      metalness: 0.0,
      transparent: false,
      opacity: 1,
    });
    return mat;
  }, []);

  // Apply render mode materials to meshes
  const applyRenderMaterials = useCallback(() => {
    if (!renderModeEnabled) return;

    meshParts.forEach(part => {
      // Store original material if not already stored
      if (!originalMaterialsRef.current.has(part.id)) {
        originalMaterialsRef.current.set(part.id, part.mesh.material as THREE.Material);
      }

      const baseColor = new THREE.Color(
        part.currentColor.startsWith('#') ? part.currentColor : (RAL_COLORS[part.currentColor]?.hex || '#ffffff')
      );

      // Use the user's current opacity setting
      const userOpacity = part.currentOpacity;

      let newMat: THREE.MeshStandardMaterial;

      switch (part.elementType) {
        case 'wall':
          newMat = createStuccoMaterial(baseColor, userOpacity);
          break;
        case 'floor':
          // Floors use wood texture - opacity from user
          newMat = createWoodFloorMaterial(floorPattern, new THREE.Color(0xDEB887));
          newMat.transparent = userOpacity < 1;
          newMat.opacity = userOpacity;
          break;
        case 'window':
          // Windows default to 40% opacity, but user can override
          newMat = createGlassMaterial(userOpacity < 1 ? userOpacity : 0.4);
          break;
        case 'door':
          newMat = createStuccoMaterial(baseColor, userOpacity);
          newMat.roughness = 0.5; // Smoother for painted doors
          break;
        default:
          newMat = new THREE.MeshStandardMaterial({
            color: baseColor,
            roughness: 0.7,
            transparent: userOpacity < 1,
            opacity: userOpacity
          });
      }

      part.mesh.material = newMat;
    });
  }, [renderModeEnabled, meshParts, floorPattern, createStuccoMaterial, createWoodFloorMaterial, createGlassMaterial]);

  // Restore original materials
  const restoreOriginalMaterials = useCallback(() => {
    meshParts.forEach(part => {
      const originalMat = originalMaterialsRef.current.get(part.id);
      if (originalMat) {
        part.mesh.material = originalMat;
      }
    });
  }, [meshParts]);

  // Toggle render mode
  useEffect(() => {
    if (renderModeEnabled) {
      applyRenderMaterials();
    } else {
      restoreOriginalMaterials();
    }
  }, [renderModeEnabled, applyRenderMaterials, restoreOriginalMaterials]);

  // Re-apply materials when floor pattern changes or when meshParts opacity/color changes
  useEffect(() => {
    if (renderModeEnabled) {
      applyRenderMaterials();
    }
  }, [floorPattern, renderModeEnabled, applyRenderMaterials]);

  // Track meshParts changes for opacity/color/elementType updates in render mode
  const meshPartsKey = meshParts.map(p => `${p.id}:${p.currentOpacity}:${p.currentColor}:${p.elementType}`).join('|');
  useEffect(() => {
    if (renderModeEnabled && meshParts.length > 0) {
      applyRenderMaterials();
    }
  }, [meshPartsKey, renderModeEnabled]);

  // Extract mesh parts from all models for render tab
  const extractMeshParts = useCallback(() => {
    const parts: SelectableMeshPart[] = [];

    models.forEach(model => {
      if (model.type === 'splat') return; // Skip splat-only models

      const meshToTraverse = model.type === 'paired' ? model.mesh : model.mesh;

      meshToTraverse.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material) {
          const mat = child.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
          const name = child.name || `Mesh_${parts.length}`;

          // Try to detect element type from name
          let elementType: 'wall' | 'floor' | 'door' | 'window' | 'other' = 'other';
          const nameLower = name.toLowerCase();
          if (nameLower.includes('wall') || nameLower.includes('wand')) elementType = 'wall';
          else if (nameLower.includes('floor') || nameLower.includes('boden') || nameLower.includes('ground')) elementType = 'floor';
          else if (nameLower.includes('door') || nameLower.includes('tür') || nameLower.includes('tur')) elementType = 'door';
          else if (nameLower.includes('window') || nameLower.includes('fenster') || nameLower.includes('glass')) elementType = 'window';

          const originalColor = mat.color ? mat.color.clone() : new THREE.Color(0xffffff);
          const originalOpacity = mat.opacity !== undefined ? mat.opacity : 1.0;

          parts.push({
            id: child.uuid,
            name: name,
            mesh: child,
            originalColor: originalColor,
            originalOpacity: originalOpacity,
            currentColor: '#' + originalColor.getHexString().toUpperCase(),
            currentOpacity: originalOpacity,
            elementType: elementType
          });
        }
      });
    });

    setMeshParts(parts);
  }, [models]);

  // Extract mesh parts when models change or entering render tab
  useEffect(() => {
    if (ribbonTab === 'render') {
      extractMeshParts();
    }
  }, [ribbonTab, models, extractMeshParts]);

  // Handle mesh part selection via raycasting (supports shift for multi-select)
  const handleRenderClick = useCallback((event: MouseEvent) => {
    if (!renderer || !camera || ribbonTab !== 'render') return;
    if (meshParts.length === 0) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    // Get all meshes from mesh parts
    const meshes = meshParts.map(p => p.mesh);
    const intersects = raycaster.intersectObjects(meshes, false);

    if (intersects.length > 0) {
      const hitMesh = intersects[0].object as THREE.Mesh;
      const part = meshParts.find(p => p.mesh === hitMesh);
      if (part) {
        if (event.shiftKey) {
          // Shift-click: toggle selection (add/remove from multi-select)
          setSelectedMeshPartIds(prev => {
            if (prev.includes(part.id)) {
              return prev.filter(id => id !== part.id);
            } else {
              return [...prev, part.id];
            }
          });
        } else {
          // Regular click: select only this one
          setSelectedMeshPartIds([part.id]);
        }
      }
    } else {
      // Clicked on empty space: deselect all (unless shift held)
      if (!event.shiftKey) {
        setSelectedMeshPartIds([]);
      }
    }
  }, [renderer, camera, ribbonTab, meshParts]);

  // Set up click listener for render mode
  useEffect(() => {
    if (!renderer || ribbonTab !== 'render') return;

    const domElement = renderer.domElement;
    domElement.addEventListener('click', handleRenderClick);

    return () => {
      domElement.removeEventListener('click', handleRenderClick);
    };
  }, [renderer, ribbonTab, handleRenderClick]);

  // Clear outlines helper function
  const clearAllOutlines = useCallback(() => {
    outlineHelpersRef.current.forEach((outline, id) => {
      if (outline.parent) {
        outline.parent.remove(outline);
      }
      outline.geometry.dispose();
      (outline.material as THREE.Material).dispose();
    });
    outlineHelpersRef.current.clear();
  }, []);

  // Highlight selected mesh parts with outlines
  useEffect(() => {
    if (!scene) return;

    // Clear all existing outlines first
    clearAllOutlines();

    // Only show outlines when in render tab
    if (ribbonTab !== 'render') return;

    // Add outlines for all selected mesh parts
    selectedMeshPartIds.forEach(partId => {
      const part = meshParts.find(p => p.id === partId);
      if (part && part.mesh && part.mesh.geometry) {
        const edges = new THREE.EdgesGeometry(part.mesh.geometry);
        const outline = new THREE.LineSegments(
          edges,
          new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 2, depthTest: false })
        );
        outline.name = `outline_${partId}`;
        outline.renderOrder = 999; // Render on top

        // Copy world transform
        part.mesh.updateWorldMatrix(true, false);
        outline.applyMatrix4(part.mesh.matrixWorld);

        scene.add(outline);
        outlineHelpersRef.current.set(partId, outline);
      }
    });

    // Cleanup on unmount or when leaving render tab
    return () => {
      if (ribbonTab !== 'render') {
        clearAllOutlines();
      }
    };
  }, [selectedMeshPartIds, ribbonTab, meshParts, scene, clearAllOutlines]);

  // Clean up outlines when leaving render tab
  useEffect(() => {
    if (ribbonTab !== 'render') {
      clearAllOutlines();
      setSelectedMeshPartIds([]);
    }
  }, [ribbonTab, clearAllOutlines]);

  // Apply color to selected mesh part
  const applyColorToMeshPart = useCallback((partId: string, ralCode: string | null, hexColor: string | null, opacity?: number) => {
    const part = meshParts.find(p => p.id === partId);
    if (!part) return;

    const mat = part.mesh.material as THREE.MeshStandardMaterial;
    if (!mat) return;

    // Determine color
    let color: string;
    if (ralCode && RAL_COLORS[ralCode]) {
      color = RAL_COLORS[ralCode].hex;
    } else if (hexColor) {
      color = hexColor;
    } else {
      return;
    }

    // Apply color
    mat.color.set(color);

    // Apply opacity if provided
    if (opacity !== undefined) {
      mat.opacity = opacity;
      mat.transparent = opacity < 1;
    }

    mat.needsUpdate = true;

    // Update state
    setMeshParts(prev => prev.map(p => {
      if (p.id !== partId) return p;
      return {
        ...p,
        currentColor: ralCode ? ralCode : color,
        currentOpacity: opacity !== undefined ? opacity : p.currentOpacity
      };
    }));
  }, [meshParts]);

  // Apply preset to element type
  const applyPresetToType = useCallback((elementType: 'wall' | 'floor' | 'door' | 'window') => {
    const preset = ELEMENT_PRESETS[elementType];
    const partsOfType = meshParts.filter(p => p.elementType === elementType);

    partsOfType.forEach(part => {
      applyColorToMeshPart(part.id, preset.ral, null, preset.opacity);
    });
  }, [meshParts, applyColorToMeshPart]);

  // Reset mesh part to original
  const resetMeshPart = useCallback((partId: string) => {
    const part = meshParts.find(p => p.id === partId);
    if (!part) return;

    const mat = part.mesh.material as THREE.MeshStandardMaterial;
    if (!mat) return;

    mat.color.copy(part.originalColor);
    mat.opacity = part.originalOpacity;
    mat.transparent = part.originalOpacity < 1;
    mat.needsUpdate = true;

    setMeshParts(prev => prev.map(p => {
      if (p.id !== partId) return p;
      return {
        ...p,
        currentColor: '#' + p.originalColor.getHexString().toUpperCase(),
        currentOpacity: p.originalOpacity
      };
    }));
  }, [meshParts]);

  const setMeshPartType = useCallback((partId: string, type: SelectableMeshPart['elementType']) => {
    setMeshParts(prev => prev.map(p => p.id === partId ? { ...p, elementType: type } : p));
  }, []);

  // Cleanup splat meshes on unmount
  useEffect(() => {
    return () => {
      splatMeshesRef.current.forEach((mesh, id) => {
        if (mesh.parent) {
          mesh.parent.remove(mesh);
        }
        mesh.dispose();
      });
      splatMeshesRef.current.clear();
    };
  }, []);

  // Add initial building from Konstruktion tab
  const initialBuildingAddedRef = useRef<THREE.Group | null>(null);
  useEffect(() => {
    if (initialBuilding && scene && initialBuilding !== initialBuildingAddedRef.current) {
      // Check if this building is already in the scene
      const isAlreadyInScene = scene.children.includes(initialBuilding);
      if (!isAlreadyInScene) {
        scene.add(initialBuilding);

        const newModel: SimulationModel = {
          id: crypto.randomUUID(),
          name: 'Designed Building',
          type: 'building',
          mesh: initialBuilding,
          position: initialBuilding.position.clone(),
          rotation: initialBuilding.rotation.clone(),
          scale: initialBuilding.scale.clone(),
          visible: true
        };

        setModels(prev => [...prev, newModel]);
        initialBuildingAddedRef.current = initialBuilding;

        // Add model to active slide
        setSlides(prev => prev.map((slide, idx) =>
          idx === activeSlideIndex
            ? { ...slide, modelIds: [...slide.modelIds, newModel.id] }
            : slide
        ));

        // Fit camera to the building
        setTimeout(() => {
          const box = new THREE.Box3().setFromObject(initialBuilding);
          fitToBox(box);
        }, 100);
      }
    }
  }, [initialBuilding, scene, fitToBox, activeSlideIndex]);

  // Helper function to process GLTF materials for proper PBR rendering
  const processGLTFMaterials = useCallback((object: THREE.Object3D) => {
    object.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];

        materials.forEach((material) => {
          // Ensure proper color space for textures
          if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhysicalMaterial) {
            // Enable environment map influence
            material.envMapIntensity = 1.0;

            // Ensure textures use correct color space
            if (material.map) {
              material.map.colorSpace = THREE.SRGBColorSpace;
            }
            if (material.emissiveMap) {
              material.emissiveMap.colorSpace = THREE.SRGBColorSpace;
            }

            // Normal, roughness, metalness, AO maps should be in Linear space (default)
            // They are typically loaded correctly by GLTFLoader

            // Ensure material updates
            material.needsUpdate = true;
          }
        });

        // Enable shadows for realistic rendering
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
  }, []);

  // Handle environment model upload
  const handleUploadEnvironment = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !scene || !renderer || !camera) return;

    console.log('Loading environment model:', file.name);

    const ext = file.name.split('.').pop()?.toLowerCase();
    const url = URL.createObjectURL(file);

    try {
      const isSplatFile = ext === 'ply' || ext === 'splat' || ext === 'ksplat' || ext === 'spz';
      const isMeshFile = ext === 'glb' || ext === 'gltf' || ext === 'obj' || ext === 'fbx';

      // If we're in paired mode awaiting splat, and user uploads a splat file
      if (pairedUploadMode === 'awaiting_splat' && isSplatFile && pendingCollisionMesh) {
        console.log('Completing paired upload with splat file...');
        setSplatLoadingProgress(0);

        try {
          const splatMesh = new SplatMesh({ url });
          splatMesh.name = file.name;

          setSplatLoadingProgress(50);
          scene.add(splatMesh);

          const modelId = crypto.randomUUID();
          splatMeshesRef.current.set(modelId, splatMesh);

          // Make collision mesh invisible but keep it for raycasting
          pendingCollisionMesh.mesh.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.material = new THREE.MeshBasicMaterial({
                transparent: true,
                opacity: 0,
                depthWrite: false,
              });
            }
          });
          scene.add(pendingCollisionMesh.mesh);

          setSplatLoadingProgress(100);
          await new Promise(resolve => setTimeout(resolve, 100));
          setSplatLoadingProgress(null);

          const newModel: SimulationModel = {
            id: modelId,
            name: `${pendingCollisionMesh.name} + ${file.name} (Paired)`,
            type: 'paired',
            mesh: pendingCollisionMesh.mesh, // Collision mesh for raycasting
            position: new THREE.Vector3(0, 0, 0),
            rotation: new THREE.Euler(0, 0, 0),
            scale: new THREE.Vector3(1, 1, 1),
            visible: true,
            splatMesh: splatMesh,
            collisionMeshVisible: false
          };

          setModels(prev => [...prev, newModel]);
          setSelectedModelId(newModel.id);

          // Add model to active slide
          setSlides(prev => prev.map((slide, idx) =>
            idx === activeSlideIndex
              ? { ...slide, modelIds: [...slide.modelIds, newModel.id] }
              : slide
          ));

          // Cleanup paired mode state
          URL.revokeObjectURL(pendingCollisionMesh.url);
          setPendingCollisionMesh(null);
          setPairedUploadMode('none');

          // Fit camera
          setTimeout(() => {
            const box = new THREE.Box3().setFromObject(splatMesh);
            if (!box.isEmpty()) {
              fitToBox(box);
            }
          }, 500);

          console.log('Paired model (mesh + splat) loaded successfully');
        } catch (splatError) {
          console.error('Failed to load splat for paired mode:', splatError);
          setSplatLoadingProgress(null);
          alert('Failed to load Gaussian Splat: ' + (splatError as Error).message);
        }
        return;
      }

      // Handle PLY files (Gaussian Splatting) - standalone
      if (isSplatFile) {
        console.log('Loading Gaussian Splat file with Spark...', file.name);
        setSplatLoadingProgress(0);

        try {
          const splatMesh = new SplatMesh({ url });
          splatMesh.name = file.name;

          setSplatLoadingProgress(50);
          scene.add(splatMesh);

          const modelId = crypto.randomUUID();
          splatMeshesRef.current.set(modelId, splatMesh);

          setSplatLoadingProgress(100);
          await new Promise(resolve => setTimeout(resolve, 100));
          setSplatLoadingProgress(null);

          const newModel: SimulationModel = {
            id: modelId,
            name: file.name,
            type: 'splat',
            mesh: splatMesh,
            position: splatMesh.position.clone(),
            rotation: splatMesh.rotation.clone(),
            scale: splatMesh.scale.clone(),
            visible: true,
            splatMesh: splatMesh
          };

          setModels(prev => [...prev, newModel]);
          setSelectedModelId(newModel.id);

          // Add model to active slide
          setSlides(prev => prev.map((slide, idx) =>
            idx === activeSlideIndex
              ? { ...slide, modelIds: [...slide.modelIds, newModel.id] }
              : slide
          ));

          setTimeout(() => {
            const box = new THREE.Box3().setFromObject(splatMesh);
            if (!box.isEmpty()) {
              fitToBox(box);
            }
          }, 500);

          console.log('Gaussian Splat loaded successfully with Spark');
        } catch (splatError) {
          console.error('Failed to load Gaussian Splat:', splatError);
          setSplatLoadingProgress(null);
          alert('Failed to load Gaussian Splat: ' + (splatError as Error).message);
        }
        return;
      }

      // Handle regular mesh files
      if (!isMeshFile) {
        alert('Unsupported file format. Please use GLB, GLTF, OBJ, FBX, or PLY/SPLAT (Gaussian Splat).');
        return;
      }

      let loadedGroup: THREE.Group | null = null;

      if (ext === 'glb' || ext === 'gltf') {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(url);
        loadedGroup = new THREE.Group();
        loadedGroup.add(gltf.scene);
        // Process materials for proper PBR rendering
        processGLTFMaterials(gltf.scene);
      } else if (ext === 'obj') {
        const loader = new OBJLoader();
        loadedGroup = await loader.loadAsync(url);
      } else if (ext === 'fbx') {
        const loader = new FBXLoader();
        const object = await loader.loadAsync(url);
        loadedGroup = new THREE.Group();
        loadedGroup.add(object);
      }

      if (loadedGroup) {
        loadedGroup.name = file.name;
        scene.add(loadedGroup);

        const newModel: SimulationModel = {
          id: crypto.randomUUID(),
          name: file.name,
          type: 'environment',
          mesh: loadedGroup,
          position: loadedGroup.position.clone(),
          rotation: loadedGroup.rotation.clone(),
          scale: loadedGroup.scale.clone(),
          visible: true
        };

        setModels(prev => [...prev, newModel]);
        setSelectedModelId(newModel.id);

        // Add model to active slide
        setSlides(prev => prev.map((slide, idx) =>
          idx === activeSlideIndex
            ? { ...slide, modelIds: [...slide.modelIds, newModel.id] }
            : slide
        ));

        // Fit camera
        const box = new THREE.Box3().setFromObject(loadedGroup);
        fitToBox(box);
      }
    } catch (err) {
      console.error('Failed to load model:', err);
      setSplatLoadingProgress(null);
      alert('Failed to load model: ' + (err as Error).message);
    } finally {
      URL.revokeObjectURL(url);
      e.target.value = '';
    }
  };

  // Handle drop from project files panel onto simulation upload
  const handleDropSimulationModel = async () => {
    const pf = draggedProjectFile;
    if (!pf || !scene || !renderer || !camera) return;
    if (!['glb', 'ifc'].includes(pf.type)) { alert('Only GLB/IFC files can be loaded here'); return; }
    const blob = pf.blob || (pf.url ? await fetch(pf.url).then(r => r.blob()) : null);
    if (!blob) return;
    const file = new File([blob], pf.name, { type: blob.type });

    console.log('Drop: loading simulation model from', file.name);
    const ext = file.name.split('.').pop()?.toLowerCase();
    const url = URL.createObjectURL(file);

    try {
      let loadedGroup: THREE.Group | null = null;

      if (ext === 'glb' || ext === 'gltf') {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(url);
        loadedGroup = new THREE.Group();
        loadedGroup.add(gltf.scene);
        // Process materials for proper PBR rendering
        processGLTFMaterials(gltf.scene);
      } else if (ext === 'obj') {
        const loader = new OBJLoader();
        loadedGroup = await loader.loadAsync(url);
      } else if (ext === 'fbx') {
        const loader = new FBXLoader();
        const object = await loader.loadAsync(url);
        loadedGroup = new THREE.Group();
        loadedGroup.add(object);
      } else if (ext === 'ifc') {
        // For IFC, load as GLB after conversion or directly via GLTFLoader if pre-converted
        // For now, treat IFC blob URLs same as GLB (the blob is the raw IFC)
        // IFC files need the web-ifc loader - skip for now, show message
        alert('IFC files can be loaded as floors in Konstruktion. For Simulation, use GLB format.');
        URL.revokeObjectURL(url);
        return;
      }

      if (loadedGroup) {
        loadedGroup.name = file.name;
        scene.add(loadedGroup);

        const newModel: SimulationModel = {
          id: crypto.randomUUID(),
          name: file.name,
          type: 'environment',
          mesh: loadedGroup,
          position: loadedGroup.position.clone(),
          rotation: loadedGroup.rotation.clone(),
          scale: loadedGroup.scale.clone(),
          visible: true
        };

        setModels(prev => [...prev, newModel]);
        setSelectedModelId(newModel.id);

        // Add model to active slide
        setSlides(prev => prev.map((slide, idx) =>
          idx === activeSlideIndex
            ? { ...slide, modelIds: [...slide.modelIds, newModel.id] }
            : slide
        ));

        const box = new THREE.Box3().setFromObject(loadedGroup);
        fitToBox(box);
      }
    } catch (err) {
      console.error('Failed to load dropped model:', err);
      alert('Failed to load model: ' + (err as Error).message);
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  // Start paired upload: first upload a mesh file, then a splat file
  const handleStartPairedUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !scene) return;

    const ext = file.name.split('.').pop()?.toLowerCase();
    const isMeshFile = ext === 'glb' || ext === 'gltf' || ext === 'obj' || ext === 'fbx';

    if (!isMeshFile) {
      alert('Please select a mesh file (GLB, GLTF, OBJ, FBX) for the collision geometry.');
      e.target.value = '';
      return;
    }

    const url = URL.createObjectURL(file);

    try {
      let loadedGroup: THREE.Group | null = null;

      if (ext === 'glb' || ext === 'gltf') {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(url);
        loadedGroup = new THREE.Group();
        loadedGroup.add(gltf.scene);
        // Process materials for proper PBR rendering
        processGLTFMaterials(gltf.scene);
      } else if (ext === 'obj') {
        const loader = new OBJLoader();
        loadedGroup = await loader.loadAsync(url);
      } else if (ext === 'fbx') {
        const loader = new FBXLoader();
        const object = await loader.loadAsync(url);
        loadedGroup = new THREE.Group();
        loadedGroup.add(object);
      }

      if (loadedGroup) {
        loadedGroup.name = file.name;
        setPendingCollisionMesh({ mesh: loadedGroup, name: file.name, url });
        setPairedUploadMode('awaiting_splat');
        console.log('Collision mesh loaded, awaiting splat file...');
      }
    } catch (err) {
      console.error('Failed to load collision mesh:', err);
      URL.revokeObjectURL(url);
      alert('Failed to load mesh: ' + (err as Error).message);
    }
    e.target.value = '';
  };

  // Cancel paired upload mode
  const handleCancelPairedUpload = () => {
    if (pendingCollisionMesh) {
      URL.revokeObjectURL(pendingCollisionMesh.url);
    }
    setPendingCollisionMesh(null);
    setPairedUploadMode('none');
  };

  // Update model transform
  const handleUpdateModel = (id: string, updates: Partial<SimulationModel>) => {
    setModels(prev => prev.map(model => {
      if (model.id !== id) return model;

      const updated = { ...model, ...updates };

      // For paired models, sync both the collision mesh and splat mesh
      if (model.type === 'paired' && model.splatMesh) {
        if (updates.position) {
          model.mesh.position.copy(updates.position);
          model.splatMesh.position.copy(updates.position);
          updated.position = updates.position;
        }
        if (updates.rotation) {
          model.mesh.rotation.copy(updates.rotation);
          model.splatMesh.rotation.copy(updates.rotation);
          updated.rotation = updates.rotation;
        }
        if (updates.scale) {
          model.mesh.scale.copy(updates.scale);
          model.splatMesh.scale.copy(updates.scale);
          updated.scale = updates.scale;
        }
        if (updates.visible !== undefined) {
          // For paired: splat visibility controlled by 'visible', mesh always exists for raycasting
          model.splatMesh.visible = updates.visible;
          updated.visible = updates.visible;
        }
        if (updates.collisionMeshVisible !== undefined) {
          // Toggle collision mesh visibility for debugging
          model.mesh.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              const mat = child.material as THREE.MeshBasicMaterial;
              mat.opacity = updates.collisionMeshVisible ? 0.3 : 0;
              mat.needsUpdate = true;
            }
          });
          updated.collisionMeshVisible = updates.collisionMeshVisible;
        }
      } else {
        // Regular models (building, environment, splat)
        if (updates.position) {
          model.mesh.position.copy(updates.position);
          updated.position = updates.position;
        }
        if (updates.rotation) {
          model.mesh.rotation.copy(updates.rotation);
          updated.rotation = updates.rotation;
        }
        if (updates.scale) {
          model.mesh.scale.copy(updates.scale);
          updated.scale = updates.scale;
        }
        if (updates.visible !== undefined) {
          model.mesh.visible = updates.visible;
          updated.visible = updates.visible;
        }
      }

      return updated;
    }));
  };

  // Delete model
  const handleDeleteModel = (id: string) => {
    const model = models.find(m => m.id === id);
    if (model && scene) {
      scene.remove(model.mesh);

      // If it's a splat or paired, dispose the SplatMesh and remove from refs
      if ((model.type === 'splat' || model.type === 'paired') && model.splatMesh) {
        scene.remove(model.splatMesh);
        model.splatMesh.dispose();
        splatMeshesRef.current.delete(id);
      }

      setModels(prev => prev.filter(m => m.id !== id));
      if (selectedModelId === id) {
        setSelectedModelId(null);
      }
    }
  };

  // Focus on all models
  const handleFocusAll = () => {
    const box = new THREE.Box3();
    models.forEach(model => {
      if (model.visible) {
        const modelBox = new THREE.Box3().setFromObject(model.mesh);
        box.union(modelBox);
      }
    });
    if (!box.isEmpty()) {
      fitToBox(box);
    }
  };

  // Get world position from mouse for measurement
  // ONLY allows hits on: grid plane (y=0), environment meshes, building meshes, paired collision meshes
  // Does NOT allow hits on: splat files, measurement helpers, or empty space
  const getWorldPositionFromMouse = useCallback((event: MouseEvent | React.MouseEvent): THREE.Vector3 | null => {
    if (!renderer || !camera || !scene) return null;

    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    // Build list of valid raycast targets from our models
    // Only include: environment, building, and paired (collision mesh only)
    // Exclude: splat-only models (they don't have geometry for raycasting)
    const validMeshes: THREE.Object3D[] = [];

    // Add meshes from valid model types
    models.forEach(model => {
      if (model.type === 'environment' || model.type === 'building' || model.type === 'paired') {
        // For these types, model.mesh is a valid raycast target
        model.mesh.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            validMeshes.push(obj);
          }
        });
      }
      // Skip 'splat' type - no valid geometry for raycasting
    });

    // Also add the grid helper if it exists (look for GridHelper in scene)
    scene.traverse((obj) => {
      if (obj.type === 'GridHelper' || obj.name === 'grid' || obj.name === 'groundGrid') {
        // GridHelper isn't a mesh, so we'll use the ground plane instead
      }
    });

    // Try to hit valid model meshes first
    if (validMeshes.length > 0) {
      const intersects = raycaster.intersectObjects(validMeshes, false);
      if (intersects.length > 0) {
        // Filter out hits above the global section cut plane (clipped geometry is invisible but still raycasted)
        const validHit = globalSectionCut.enabled
          ? intersects.find(hit => hit.point.y <= globalSectionCut.height + 0.01 && hit.point.y >= -10)
          : intersects.find(hit => hit.point.y >= -10);
        if (validHit) {
          return validHit.point.clone();
        }
      }
    }

    // Fallback to ground plane at y=0 (the white grid)
    // ONLY if ray is pointing downward
    const rayDirection = raycaster.ray.direction;
    if (rayDirection.y < 0) {
      const fallbackY = globalSectionCut.enabled ? globalSectionCut.height : 0;
      const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -fallbackY);
      const intersection = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(groundPlane, intersection)) {
        // Check reasonable distance
        const distance = camera.position.distanceTo(intersection);
        if (distance < 1000) {
          return intersection;
        }
      }
    }

    // No valid intersection - don't place point
    return null;
  }, [renderer, camera, scene, models, globalSectionCut.enabled, globalSectionCut.height]);

  // Handle mouse events for measurement
  const handleMouseMove = useCallback((event: MouseEvent) => {
    if (measureToolMode === 'none' || !measurementManagerRef.current) {
      measurementManagerRef.current?.setCursorVisible(false);
      return;
    }

    const worldPoint = getWorldPositionFromMouse(event);
    if (!worldPoint) {
      // No valid intersection - hide cursor and don't update previews
      measurementManagerRef.current.setCursorVisible(false);
      // Clear preview line when no valid point
      if (measureToolMode === 'line' && pendingPointRef.current) {
        measurementManagerRef.current.updatePreviewLine(pendingPointRef.current.position, null);
      }
      // Clear polygon preview cursor when no valid point
      if (measureToolMode === 'polygon' && pendingPolygonPointsRef.current.length > 0) {
        measurementManagerRef.current.updatePendingPoints(pendingPolygonPointsRef.current, null);
      }
      return;
    }

    const snapResult = measurementManagerRef.current.findSnapPoint(worldPoint);
    measurementManagerRef.current.updateCursorPosition(snapResult.point, snapResult.type);

    if (measureToolMode === 'line' && pendingPointRef.current) {
      measurementManagerRef.current.updatePreviewLine(pendingPointRef.current.position, snapResult.point);
    }

    if (measureToolMode === 'polygon') {
      measurementManagerRef.current.updatePendingPoints(pendingPolygonPointsRef.current, snapResult.point);
    }
  }, [measureToolMode, getWorldPositionFromMouse]);

  const handleDoubleClick = useCallback((event: MouseEvent) => {
    if (measureToolMode === 'none' || !measurementManagerRef.current) return;

    const worldPoint = getWorldPositionFromMouse(event);
    if (!worldPoint) return;

    const snapResult = measurementManagerRef.current.findSnapPoint(worldPoint);
    const measurePoint: MeasurementPoint = {
      position: snapResult.point,
      snappedTo: snapResult.type,
      edgeInfo: snapResult.edgeInfo
    };

    if (measureToolMode === 'line') {
      if (!pendingPointRef.current) {
        pendingPointRef.current = measurePoint;
      } else {
        const measurement = measurementManagerRef.current.createLineMeasurement(pendingPointRef.current, measurePoint);
        setMeasurements([...measurementManagerRef.current.getMeasurements()]);
        pendingPointRef.current = null;
        measurementManagerRef.current.updatePreviewLine(null, null);
      }
    } else if (measureToolMode === 'polygon') {
      const pendingPoints = pendingPolygonPointsRef.current;

      if (pendingPoints.length >= 3) {
        const firstPoint = pendingPoints[0].position;
        if (snapResult.point.distanceTo(firstPoint) < 0.3) {
          const measurement = measurementManagerRef.current.createPolygonMeasurement(pendingPoints);
          setMeasurements([...measurementManagerRef.current.getMeasurements()]);
          pendingPolygonPointsRef.current = [];
          measurementManagerRef.current.updatePendingPoints([], null);
          return;
        }
      }

      pendingPolygonPointsRef.current = [...pendingPoints, measurePoint];
    }
  }, [measureToolMode, getWorldPositionFromMouse]);

  // Set up event listeners
  useEffect(() => {
    if (!renderer) return;
    const domElement = renderer.domElement;

    domElement.addEventListener('dblclick', handleDoubleClick);
    domElement.addEventListener('mousemove', handleMouseMove);

    return () => {
      domElement.removeEventListener('dblclick', handleDoubleClick);
      domElement.removeEventListener('mousemove', handleMouseMove);
    };
  }, [renderer, handleDoubleClick, handleMouseMove]);

  // Clear pending on tool change
  useEffect(() => {
    pendingPointRef.current = null;
    pendingPolygonPointsRef.current = [];
    if (measurementManagerRef.current) {
      measurementManagerRef.current.clearPreviews();
    }
  }, [measureToolMode]);

  // Measurement callbacks
  const handleSelectMeasurement = useCallback((id: string | null) => {
    if (measurementManagerRef.current) {
      measurementManagerRef.current.selectMeasurement(id);
      setSelectedMeasurementId(id);
    }
  }, []);

  const handleDeleteMeasurement = useCallback((id: string) => {
    if (measurementManagerRef.current) {
      measurementManagerRef.current.deleteMeasurement(id);
      setMeasurements([...measurementManagerRef.current.getMeasurements()]);
      if (selectedMeasurementId === id) {
        setSelectedMeasurementId(null);
      }
    }
  }, [selectedMeasurementId]);

  const handleMoveMeasurement = useCallback((id: string, axis: 'x' | 'z', delta: number) => {
    if (measurementManagerRef.current) {
      measurementManagerRef.current.moveMeasurement(id, axis, delta);
      setMeasurements([...measurementManagerRef.current.getMeasurements()]);
    }
  }, []);

  // Demolition volume functions
  const handleDeleteDemolitionVolume = useCallback((id: string) => {
    // Remove the 3D mesh
    const mesh = demolitionMeshesRef.current.get(id);
    if (mesh && scene) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach(m => m.dispose());
      } else {
        mesh.material.dispose();
      }
      demolitionMeshesRef.current.delete(id);
    }

    setDemolitionVolumes(prev => prev.filter(v => v.id !== id));
    if (selectedDemolitionId === id) {
      setSelectedDemolitionId(null);
    }
  }, [scene, selectedDemolitionId]);

  // Create demolition volume mesh from polygon
  const createDemolitionMesh = useCallback((volume: DemolitionVolume): THREE.Mesh => {
    const shape = new THREE.Shape();

    // polygon stores Vector2(worldX, worldZ)
    // Shape is 2D, then extruded in Z, then rotated to stand upright
    // To fix mirroring, negate Z coordinate in shape
    if (volume.polygon.length > 0) {
      shape.moveTo(volume.polygon[0].x, -volume.polygon[0].y);
      for (let i = 1; i < volume.polygon.length; i++) {
        shape.lineTo(volume.polygon[i].x, -volume.polygon[i].y);
      }
      shape.closePath();
    }

    const height = volume.topY - volume.bottomY;
    const extrudeSettings = {
      depth: height,
      bevelEnabled: false,
    };

    const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    // Rotate to make it vertical (extrude goes in Z, we want Y)
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, volume.bottomY, 0);

    const material = new THREE.MeshBasicMaterial({
      color: 0xff4444,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `demolition_${volume.id}`;
    mesh.renderOrder = 999; // Render on top

    // Apply volume transform
    mesh.position.copy(volume.position);
    mesh.rotation.copy(volume.rotation);
    mesh.scale.copy(volume.scale);

    // Add wireframe
    const edges = new THREE.EdgesGeometry(geometry);
    const wireframe = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 })
    );
    mesh.add(wireframe);

    return mesh;
  }, []);

  // Update demolition volume mesh when volume changes
  useEffect(() => {
    if (!scene) return;

    // Track if we need to reattach gizmo after updating meshes
    let reattachToVolumeId: string | null = null;

    demolitionVolumes.forEach(volume => {
      let mesh = demolitionMeshesRef.current.get(volume.id);

      if (!mesh) {
        // Create new mesh
        mesh = createDemolitionMesh(volume);
        scene.add(mesh);
        demolitionMeshesRef.current.set(volume.id, mesh);
      } else {
        // Check if gizmo is attached to this mesh - if so, detach first
        if (transformControlsRef.current?.object === mesh) {
          transformControlsRef.current.detach();
          reattachToVolumeId = volume.id;
        }

        // Update existing mesh
        scene.remove(mesh);
        mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach(m => m.dispose());
        } else {
          mesh.material.dispose();
        }

        mesh = createDemolitionMesh(volume);
        scene.add(mesh);
        demolitionMeshesRef.current.set(volume.id, mesh);
      }

      mesh.visible = volume.showVolume;
    });

    // Remove meshes for deleted volumes
    demolitionMeshesRef.current.forEach((mesh, id) => {
      if (!demolitionVolumes.find(v => v.id === id)) {
        // Detach gizmo if attached to this mesh
        if (transformControlsRef.current?.object === mesh) {
          transformControlsRef.current.detach();
        }
        scene.remove(mesh);
        mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach(m => m.dispose());
        } else {
          mesh.material.dispose();
        }
        demolitionMeshesRef.current.delete(id);
      }
    });

    // Reattach gizmo to the new mesh if needed
    if (reattachToVolumeId && demolitionGizmoEnabled && transformControlsRef.current) {
      const newMesh = demolitionMeshesRef.current.get(reattachToVolumeId);
      if (newMesh) {
        transformControlsRef.current.attach(newMesh);
      }
    }
  }, [scene, demolitionVolumes, createDemolitionMesh, demolitionGizmoEnabled]);

  // Create hotspot mesh (sphere marker)
  const createHotspotMesh = useCallback((hotspot: Hotspot): THREE.Mesh => {
    const geometry = new THREE.SphereGeometry(0.15, 16, 16);
    const material = new THREE.MeshBasicMaterial({
      color: hotspot.color,
      transparent: true,
      opacity: 0.9,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(hotspot.position);
    mesh.name = `hotspot_${hotspot.id}`;
    mesh.userData.hotspotId = hotspot.id;
    mesh.userData.originalColor = hotspot.color;

    // Add a ring around the hotspot for visibility
    const ringGeometry = new THREE.TorusGeometry(0.25, 0.03, 8, 32);
    const ringMaterial = new THREE.MeshBasicMaterial({ color: hotspot.color });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.name = 'hotspot_ring';
    ring.userData.originalColor = hotspot.color;
    mesh.add(ring);

    return mesh;
  }, []);

  // Track hovered hotspot for hover effect
  const [hoveredHotspotId, setHoveredHotspotId] = useState<string | null>(null);

  // Handle hotspot hover effect (change ring color to blue)
  useEffect(() => {
    hotspotMeshesRef.current.forEach((mesh, id) => {
      const ring = mesh.children.find(c => c.name === 'hotspot_ring') as THREE.Mesh | undefined;
      if (ring && ring.material instanceof THREE.MeshBasicMaterial) {
        if (id === hoveredHotspotId) {
          // Hovered - set ring to blue
          ring.material.color.set('#3b82f6');
        } else {
          // Not hovered - restore original color
          ring.material.color.set(ring.userData.originalColor || mesh.userData.originalColor);
        }
      }
    });
  }, [hoveredHotspotId]);

  // Handle mouse move for hotspot hover in presentation mode
  const handleHotspotHover = useCallback((event: MouseEvent) => {
    if (!renderer || !camera || !scene) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    const hotspotMeshes: THREE.Object3D[] = [];
    hotspotMeshesRef.current.forEach((mesh) => {
      hotspotMeshes.push(mesh);
    });

    const hotspotIntersects = raycaster.intersectObjects(hotspotMeshes, true);
    if (hotspotIntersects.length > 0) {
      let hitObject: THREE.Object3D | null = hotspotIntersects[0].object;
      while (hitObject) {
        if (hitObject.userData.hotspotId) {
          setHoveredHotspotId(hitObject.userData.hotspotId);
          renderer.domElement.style.cursor = 'pointer';
          return;
        }
        hitObject = hitObject.parent;
      }
    }

    setHoveredHotspotId(null);
    // Only reset cursor if not in other modes that need special cursors
    if (!hotspotPlacementMode && measureToolMode === 'none' && demolitionDrawMode !== 'drawing') {
      renderer.domElement.style.cursor = 'default';
    }
  }, [renderer, camera, scene, hotspotPlacementMode, measureToolMode, demolitionDrawMode]);

  // Update hotspot meshes when hotspots change
  useEffect(() => {
    if (!scene) return;

    hotspots.forEach(hotspot => {
      let mesh = hotspotMeshesRef.current.get(hotspot.id);

      if (!mesh) {
        // Create new mesh
        mesh = createHotspotMesh(hotspot);
        scene.add(mesh);
        hotspotMeshesRef.current.set(hotspot.id, mesh);
      } else {
        // Update existing mesh
        mesh.position.copy(hotspot.position);
        mesh.visible = hotspot.visible;
        (mesh.material as THREE.MeshBasicMaterial).color.set(hotspot.color);
      }
    });

    // Remove meshes for deleted hotspots
    hotspotMeshesRef.current.forEach((mesh, id) => {
      if (!hotspots.find(h => h.id === id)) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        hotspotMeshesRef.current.delete(id);
      }
    });
  }, [scene, hotspots, createHotspotMesh]);

  // Handle hotspot placement
  const handleHotspotPlacement = useCallback((event: MouseEvent) => {
    if (!hotspotPlacementMode || !renderer || !camera || !scene) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    // Collect only valid model meshes (exclude helpers, demolition volumes, hotspots, measurements, etc.)
    const validMeshes: THREE.Object3D[] = [];
    models.forEach(model => {
      if (model.type === 'environment' || model.type === 'building' || model.type === 'paired') {
        model.mesh.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            validMeshes.push(obj);
          }
        });
      }
    });

    const intersects = raycaster.intersectObjects(validMeshes, false);

    // Filter out hits above the section cut plane
    const validHit = globalSectionCut.enabled
      ? intersects.find(hit => hit.point.y <= globalSectionCut.height + 0.01)
      : intersects[0];

    if (validHit) {
      const point = validHit.point;

      const newHotspot: Hotspot = {
        id: crypto.randomUUID(),
        name: `Hotspot ${hotspots.length + 1}`,
        position: point.clone(),
        savedView: camera && controls ? {
          position: camera.position.clone(),
          target: controls.target.clone()
        } : null,
        actions: {},
        color: '#ff6b00',
        visible: true
      };

      setHotspots(prev => [...prev, newHotspot]);
      setEditingHotspotId(newHotspot.id);
      setHotspotPlacementMode(false);
    }
  }, [hotspotPlacementMode, renderer, camera, scene, hotspots.length, controls, globalSectionCut.enabled, globalSectionCut.height, models]);

  // Add hotspot placement event listener
  useEffect(() => {
    if (!renderer) return;
    const domElement = renderer.domElement;

    if (hotspotPlacementMode) {
      domElement.addEventListener('dblclick', handleHotspotPlacement);
    }

    return () => {
      domElement.removeEventListener('dblclick', handleHotspotPlacement);
    };
  }, [renderer, hotspotPlacementMode, handleHotspotPlacement]);

  // Global section cut is implemented as a special demolition volume
  // We create a very large box that clips everything above the cut height
  const globalSectionVolumeId = 'global-section-cut-volume';

  // Helper function to create the global section volume
  const createGlobalSectionVolume = useCallback((height: number): DemolitionVolume => {
    const size = 500; // 500m x 500m should cover any scene
    const polygon = [
      new THREE.Vector2(-size, -size),
      new THREE.Vector2(size, -size),
      new THREE.Vector2(size, size),
      new THREE.Vector2(-size, size),
    ];

    return {
      id: globalSectionVolumeId,
      name: '🔪 Global Section Cut',
      polygon,
      bottomY: height,  // Cut starts at this height
      topY: height + 1000, // Extends 1000m up (clips everything above)
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
      affectedModels: 'all',
      visible: true,
      showVolume: false, // Don't show the volume mesh
      color: '#00aaff',
    };
  }, []);

  // Update global section cut volume when enabled/height changes
  useEffect(() => {
    if (!scene) return;

    // Remove existing global section plane visualization
    if (globalSectionPlaneRef.current) {
      scene.remove(globalSectionPlaneRef.current);
      globalSectionPlaneRef.current.geometry.dispose();
      (globalSectionPlaneRef.current.material as THREE.Material).dispose();
      globalSectionPlaneRef.current = null;
    }

    if (globalSectionCut.enabled) {
      const globalVolume = createGlobalSectionVolume(globalSectionCut.height);

      // Use functional update to check if volume exists and add/update accordingly
      setDemolitionVolumes(prev => {
        const existingIndex = prev.findIndex(v => v.id === globalSectionVolumeId);
        if (existingIndex >= 0) {
          // Update existing
          return prev.map(v => v.id === globalSectionVolumeId ? globalVolume : v);
        } else {
          // Add new
          return [...prev, globalVolume];
        }
      });

      // Create visualization plane if showPlane is enabled
      if (globalSectionCut.showPlane) {
        const planeGeometry = new THREE.PlaneGeometry(100, 100);
        const planeMaterial = new THREE.MeshBasicMaterial({
          color: 0x00aaff,
          transparent: true,
          opacity: 0.2,
          side: THREE.DoubleSide,
          depthWrite: false
        });
        const planeMesh = new THREE.Mesh(planeGeometry, planeMaterial);
        planeMesh.rotation.x = -Math.PI / 2;
        planeMesh.position.y = globalSectionCut.height;
        planeMesh.name = 'globalSectionPlane';
        planeMesh.raycast = () => {}; // Exclude from raycasting — visual only
        scene.add(planeMesh);
        globalSectionPlaneRef.current = planeMesh;
      }
    } else {
      // Remove the global section volume when disabled
      setDemolitionVolumes(prev => prev.filter(v => v.id !== globalSectionVolumeId));
    }

    return () => {
      if (globalSectionPlaneRef.current) {
        scene.remove(globalSectionPlaneRef.current);
        globalSectionPlaneRef.current = null;
      }
    };
  }, [scene, globalSectionCut.enabled, globalSectionCut.height, globalSectionCut.showPlane, createGlobalSectionVolume]);

  // Close hotspot popup and reverse all linked effects
  const closeHotspotPopup = useCallback(() => {
    const hotspot = hotspots.find(h => h.id === activeHotspotId);
    setActiveHotspotId(null);

    if (!hotspot) return;

    // Hide linked demolition volume
    if (hotspot.linkedDemolitionId || hotspot.actions.showDemolitionVolume) {
      setDemolitionVolumes(prev => prev.map(v => ({ ...v, visible: false })));
      setSelectedDemolitionId(null);
    }

    // Hide linked measurement
    const linkedMeasId = hotspot.linkedMeasurementId || hotspot.actions.showMeasurement;
    if (linkedMeasId && measurementManagerRef.current) {
      measurementManagerRef.current.setMeasurementVisible(linkedMeasId, false);
      setSelectedMeasurementId(null);
    }

    // Disable section cut if hotspot activated it
    if (hotspot.sectionCutAction?.enabled || hotspot.actions.activateSectionCut) {
      setGlobalSectionCut(prev => ({ ...prev, enabled: false }));
    }
  }, [hotspots, activeHotspotId]);

  // Handle hotspot click to execute actions
  const executeHotspotActions = useCallback((hotspot: Hotspot, clickEvent?: { clientX: number; clientY: number }) => {
    // Track active hotspot for reset popup
    setActiveHotspotId(hotspot.id);

    // Jump to saved view (skip if 360 — camera will animate toward hotspot instead)
    if (hotspot.savedView && camera && controls && !hotspot.linked360Image) {
      camera.position.copy(hotspot.savedView.position);
      controls.target.copy(hotspot.savedView.target);
      controls.update();
    }

    // Show linked demolition volume (new linkedDemolitionId field OR legacy actions field)
    const demId = hotspot.linkedDemolitionId || hotspot.actions.showDemolitionVolume;
    if (demId) {
      setDemolitionVolumes(prev => prev.map(v => ({
        ...v,
        visible: v.id === demId
      })));
      setSelectedDemolitionId(demId);
    }

    // Show linked measurement (new linkedMeasurementId field OR legacy actions field)
    const measId = hotspot.linkedMeasurementId || hotspot.actions.showMeasurement;
    if (measId && measurementManagerRef.current) {
      measurementManagerRef.current.setMeasurementVisible(measId, true);
      setSelectedMeasurementId(measId);
    }

    // Activate section cut (new sectionCutAction field OR legacy actions field)
    if (hotspot.sectionCutAction?.enabled || hotspot.actions.activateSectionCut) {
      setGlobalSectionCut(prev => ({
        ...prev,
        enabled: true,
        height: hotspot.sectionCutAction?.height ?? hotspot.actions.sectionCutHeight ?? prev.height
      }));
    }

    // Open 360 panorama viewer with zoom-in transition
    if (hotspot.linked360Image) {
      const cx = clickEvent?.clientX ?? window.innerWidth / 2;
      const cy = clickEvent?.clientY ?? window.innerHeight / 2;

      // Start the zoom-in transition
      setPanoramaTransition({
        active: true,
        phase: 'zoom-in',
        clickX: cx,
        clickY: cy,
        hotspotWorldPos: hotspot.position.clone(),
        imageUrl: hotspot.linked360Image,
        startTime: performance.now(),
      });

      // Animate camera toward hotspot position
      if (camera && controls) {
        const startPos = camera.position.clone();
        const startTarget = controls.target.clone();
        const endTarget = hotspot.position.clone();
        // Move camera to just 0.3m from hotspot
        const dir = new THREE.Vector3().subVectors(hotspot.position, camera.position).normalize();
        const dist = camera.position.distanceTo(hotspot.position);
        const endPos = new THREE.Vector3().copy(camera.position).addScaledVector(dir, dist - 0.3);

        const duration = 900; // ms
        const startTime = performance.now();

        const animateZoom = () => {
          const elapsed = performance.now() - startTime;
          const raw = Math.min(elapsed / duration, 1);
          // Ease-in-out cubic
          const t = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;

          camera.position.lerpVectors(startPos, endPos, t);
          controls.target.lerpVectors(startTarget, endTarget, t);
          // Narrow FOV for zoom effect
          if (camera instanceof THREE.PerspectiveCamera) {
            camera.fov = THREE.MathUtils.lerp(camera.fov, 20, t * 0.3);
            camera.updateProjectionMatrix();
          }
          controls.update();

          if (raw < 1) {
            requestAnimationFrame(animateZoom);
          } else {
            // Zoom done — open panorama after a brief hold
            setTimeout(() => {
              // Restore FOV
              if (camera instanceof THREE.PerspectiveCamera) {
                camera.fov = 75;
                camera.updateProjectionMatrix();
              }
              // Restore camera to original position
              camera.position.copy(startPos);
              controls.target.copy(startTarget);
              controls.update();
              setPanoramaImage(hotspot.linked360Image!);
              setPanoramaTransition(null);
            }, 150);
          }
        };
        requestAnimationFrame(animateZoom);
      } else {
        // No camera — just open directly
        setPanoramaImage(hotspot.linked360Image);
        setPanoramaTransition(null);
      }
    }
  }, [camera, controls, setSelectedMeasurementId]);

  // Handle single click for hotspots in presentation mode
  const handleHotspotClick = useCallback((event: MouseEvent) => {
    if (!isPresentationMode) return;
    if (!renderer || !camera || !scene) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    const hotspotMeshes: THREE.Object3D[] = [];
    hotspotMeshesRef.current.forEach((mesh) => {
      hotspotMeshes.push(mesh);
    });

    const hotspotIntersects = raycaster.intersectObjects(hotspotMeshes, true);
    if (hotspotIntersects.length > 0) {
      let hitObject: THREE.Object3D | null = hotspotIntersects[0].object;
      while (hitObject) {
        if (hitObject.userData.hotspotId) {
          const hotspot = hotspots.find(h => h.id === hitObject!.userData.hotspotId);
          if (hotspot) {
            setSelectedHotspotId(hotspot.id);
            executeHotspotActions(hotspot, { clientX: event.clientX, clientY: event.clientY });
            return;
          }
        }
        hitObject = hitObject.parent;
      }
    }
  }, [isPresentationMode, renderer, camera, scene, hotspots, executeHotspotActions]);

  // Handle demolition polygon drawing
  const handleDemolitionDoubleClick = useCallback((event: MouseEvent) => {
    if (demolitionDrawMode !== 'drawing' || !renderer || !camera) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    // Intersect with ground plane (y = 0)
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const intersection = new THREE.Vector3();
    raycaster.ray.intersectPlane(groundPlane, intersection);

    if (intersection) {
      const newPoint = new THREE.Vector2(intersection.x, intersection.z);

      // Check if clicking near the first point to close the polygon
      if (pendingDemolitionPoints.length >= 3) {
        const firstPoint = pendingDemolitionPoints[0];
        const dist = newPoint.distanceTo(firstPoint);
        if (dist < 0.5) { // Close threshold: 0.5 meters
          // Close the polygon and create the volume
          const newVolume: DemolitionVolume = {
            id: crypto.randomUUID(),
            name: `Volume ${demolitionVolumes.length + 1}`,
            polygon: [...pendingDemolitionPoints],
            bottomY: 0,
            topY: 2, // Default 2m height
            position: new THREE.Vector3(0, 0, 0),
            rotation: new THREE.Euler(0, 0, 0),
            scale: new THREE.Vector3(1, 1, 1),
            affectedModels: 'all',
            visible: true,
            showVolume: true,
            color: '#ff4444',
          };

          setDemolitionVolumes(prev => [...prev, newVolume]);
          setSelectedDemolitionId(newVolume.id);
          setDemolitionDrawMode('none');
          setPendingDemolitionPoints([]);
          return;
        }
      }

      // Add new point
      setPendingDemolitionPoints(prev => [...prev, newPoint]);
    }
  }, [demolitionDrawMode, renderer, camera, pendingDemolitionPoints, demolitionVolumes.length]);

  // Add demolition drawing event listener
  useEffect(() => {
    if (!renderer) return;
    const domElement = renderer.domElement;

    domElement.addEventListener('dblclick', handleDemolitionDoubleClick);

    return () => {
      domElement.removeEventListener('dblclick', handleDemolitionDoubleClick);
    };
  }, [renderer, handleDemolitionDoubleClick]);

  // Handle double-click to select models/splats/hotspots
  const handleModelDoubleClick = useCallback((event: MouseEvent) => {
    // Don't handle if measurement tools or demolition drawing or hotspot placement is active
    if (measureToolMode !== 'none' || demolitionDrawMode === 'drawing' || hotspotPlacementMode) return;
    if (!renderer || !camera || !scene) return;

    // In presentation mode, don't enable gizmos - only handle hotspots via single click
    if (isPresentationMode) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    // First check for hotspot hits
    const hotspotMeshes: THREE.Object3D[] = [];
    hotspotMeshesRef.current.forEach((mesh) => {
      hotspotMeshes.push(mesh);
    });

    const hotspotIntersects = raycaster.intersectObjects(hotspotMeshes, true);
    if (hotspotIntersects.length > 0) {
      // Find the hotspot by walking up the parent chain
      let hitObject: THREE.Object3D | null = hotspotIntersects[0].object;
      while (hitObject) {
        if (hitObject.userData.hotspotId) {
          const hotspot = hotspots.find(h => h.id === hitObject!.userData.hotspotId);
          if (hotspot) {
            setSelectedHotspotId(hotspot.id);
            executeHotspotActions(hotspot);
            return;
          }
        }
        hitObject = hitObject.parent;
      }
    }

    // Collect all model meshes for intersection
    const meshesToTest: THREE.Object3D[] = [];
    const meshToModelId = new Map<THREE.Object3D, string>();

    models.forEach(model => {
      if (model.mesh && model.visible !== false) {
        meshesToTest.push(model.mesh);
        meshToModelId.set(model.mesh, model.id);
        // Also add all children for group objects
        model.mesh.traverse((child) => {
          if (child !== model.mesh) {
            meshToModelId.set(child, model.id);
          }
        });
      }
      if (model.splatMesh && model.visible !== false) {
        meshesToTest.push(model.splatMesh);
        meshToModelId.set(model.splatMesh, model.id);
      }
    });

    const intersects = raycaster.intersectObjects(meshesToTest, true);

    if (intersects.length > 0) {
      // Find the model ID for the intersected object
      let hitObject: THREE.Object3D | null = intersects[0].object;
      let foundModelId: string | null = null;

      // Walk up the parent chain to find the model
      while (hitObject && !foundModelId) {
        foundModelId = meshToModelId.get(hitObject) || null;
        hitObject = hitObject.parent;
      }

      if (foundModelId) {
        setSelectedModelId(foundModelId);
        setGizmoEnabled(true);
      }
    } else {
      // Clicked on empty space - deselect
      setSelectedModelId(null);
      setGizmoEnabled(false);
      setSelectedHotspotId(null);
    }
  }, [renderer, camera, scene, models, measureToolMode, demolitionDrawMode, hotspotPlacementMode, hotspots, executeHotspotActions, isPresentationMode]);

  // Add model selection double-click event listener
  useEffect(() => {
    if (!renderer) return;
    const domElement = renderer.domElement;

    domElement.addEventListener('dblclick', handleModelDoubleClick);

    return () => {
      domElement.removeEventListener('dblclick', handleModelDoubleClick);
    };
  }, [renderer, handleModelDoubleClick]);

  // Add hotspot hover and click event listeners
  useEffect(() => {
    if (!renderer) return;
    const domElement = renderer.domElement;

    // Always listen for hover to show blue ring
    domElement.addEventListener('mousemove', handleHotspotHover);

    // In presentation mode, single click triggers hotspot
    if (isPresentationMode) {
      domElement.addEventListener('click', handleHotspotClick);
    }

    return () => {
      domElement.removeEventListener('mousemove', handleHotspotHover);
      domElement.removeEventListener('click', handleHotspotClick);
    };
  }, [renderer, handleHotspotHover, handleHotspotClick, isPresentationMode]);

  // ESC to close panorama viewer
  useEffect(() => {
    if (!panoramaImage) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const container = document.querySelector('[data-initialized="true"]') as any;
        if (container?._panoCleanup) container._panoCleanup();
        setPanoramaImage(null);
      }
    };
    window.addEventListener('keydown', handleEsc, true); // capture phase
    return () => window.removeEventListener('keydown', handleEsc, true);
  }, [panoramaImage]);

  // Presentation mode keyboard controls
  useEffect(() => {
    if (!isPresentationMode) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Arrow keys for slide navigation
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveSlideIndex(prev => Math.min(prev + 1, slides.length - 1));
        // Disable compare mode when changing slides
        setCompareMode(false);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveSlideIndex(prev => Math.max(prev - 1, 0));
        // Disable compare mode when changing slides
        setCompareMode(false);
      }
      // Spacebar toggles compare mode
      else if (e.key === ' ') {
        e.preventDefault();
        // Only toggle compare mode if there's a next slide to compare with
        if (activeSlideIndex < slides.length - 1) {
          setCompareMode(prev => !prev);
        }
      }
      // Escape exits presentation mode
      else if (e.key === 'Escape') {
        e.preventDefault();
        setPresentationModeValue(false);
      }
      // Tab toggles sidebar visibility
      else if (e.key === 'Tab') {
        e.preventDefault();
        setPresentationSidebarVisible(prev => !prev);
      }
    };

    // Must also handle keyup to prevent spacebar from triggering click on focused buttons
    // (browsers fire click on keyup for focused buttons, even if keydown called preventDefault)
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [isPresentationMode, slides.length, activeSlideIndex, setPresentationModeValue]);

  // Preview demolition polygon while drawing
  useEffect(() => {
    if (!scene) return;

    // Remove old preview
    if (demolitionPreviewRef.current) {
      scene.remove(demolitionPreviewRef.current);
      demolitionPreviewRef.current = null;
    }

    if (demolitionDrawMode === 'drawing' && pendingDemolitionPoints.length > 0) {
      const group = new THREE.Group();
      group.name = 'demolition_preview';

      // Draw points
      const pointGeometry = new THREE.SphereGeometry(0.1);
      const pointMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });

      pendingDemolitionPoints.forEach((pt, idx) => {
        const sphere = new THREE.Mesh(pointGeometry, pointMaterial);
        sphere.position.set(pt.x, 0.05, pt.y);
        group.add(sphere);
      });

      // Draw lines
      if (pendingDemolitionPoints.length > 1) {
        const linePoints = pendingDemolitionPoints.map(pt => new THREE.Vector3(pt.x, 0.05, pt.y));
        const lineGeometry = new THREE.BufferGeometry().setFromPoints(linePoints);
        const lineMaterial = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 });
        const line = new THREE.Line(lineGeometry, lineMaterial);
        group.add(line);
      }

      // Draw preview fill if 3+ points
      if (pendingDemolitionPoints.length >= 3) {
        const shape = new THREE.Shape();
        shape.moveTo(pendingDemolitionPoints[0].x, pendingDemolitionPoints[0].y);
        for (let i = 1; i < pendingDemolitionPoints.length; i++) {
          shape.lineTo(pendingDemolitionPoints[i].x, pendingDemolitionPoints[i].y);
        }
        shape.closePath();

        const fillGeometry = new THREE.ShapeGeometry(shape);
        fillGeometry.rotateX(-Math.PI / 2);
        fillGeometry.translate(0, 0.02, 0);

        const fillMaterial = new THREE.MeshBasicMaterial({
          color: 0xff4444,
          transparent: true,
          opacity: 0.2,
          side: THREE.DoubleSide,
        });
        const fill = new THREE.Mesh(fillGeometry, fillMaterial);
        group.add(fill);
      }

      scene.add(group);
      demolitionPreviewRef.current = group;
    }

    return () => {
      if (demolitionPreviewRef.current && scene) {
        scene.remove(demolitionPreviewRef.current);
        demolitionPreviewRef.current = null;
      }
    };
  }, [scene, demolitionDrawMode, pendingDemolitionPoints]);

  // Apply clipping to meshes based on demolition volumes
  // Uses the same approach as section cut in ViewerContext
  useEffect(() => {
    if (!scene || !renderer) return;

    // Make sure clipping is enabled
    renderer.localClippingEnabled = true;

    // Get all visible demolition volumes
    const visibleVolumes = demolitionVolumes.filter(v => v.visible);

    // If no volumes, clear all clipping
    if (visibleVolumes.length === 0) {
      scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh) || !obj.material) return;
        if (obj.name.includes('demolition') || obj.name.includes('section')) return;
        if (obj.parent?.name?.includes('demolition')) return;

        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach((mat) => {
          mat.clippingPlanes = [];
          mat.clipIntersection = false;
          mat.needsUpdate = true;
        });
      });
      return;
    }

    // Build clipping planes from all visible volumes
    // For clipping INSIDE a convex prism:
    // - Use planes with normals pointing INWARD (toward center of prism)
    // - With clipIntersection = false, geometry on negative side of ANY plane is clipped
    // - But we want to clip ONLY the interior, not everything outside
    //
    // Alternative: Use OUTWARD normals with clipIntersection = true
    // - clipIntersection = true means clip where ALL planes have point on negative side
    // - With OUTWARD normals, inside the prism ALL distances are negative
    // - So geometry inside gets clipped

    const clippingPlanes: THREE.Plane[] = [];

    visibleVolumes.forEach(volume => {
      const offsetX = volume.position.x;
      const offsetY = volume.position.y;
      const offsetZ = volume.position.z;

      // Calculate polygon centroid
      // polygon.x = world X, polygon.y = world Z
      let centroidX = 0, centroidZ = 0;
      volume.polygon.forEach(p => {
        centroidX += p.x;
        centroidZ += p.y;
      });
      centroidX = centroidX / volume.polygon.length + offsetX;
      centroidZ = centroidZ / volume.polygon.length + offsetZ;

      // Side planes with OUTWARD normals
      // With clipIntersection=true, geometry where ALL planes have negative distance gets clipped
      // With OUTWARD normals, points INSIDE the volume have negative distance to all planes
      for (let i = 0; i < volume.polygon.length; i++) {
        const p1 = volume.polygon[i];
        const p2 = volume.polygon[(i + 1) % volume.polygon.length];

        // World positions
        const worldP1 = new THREE.Vector3(p1.x + offsetX, 0, p1.y + offsetZ);
        const worldP2 = new THREE.Vector3(p2.x + offsetX, 0, p2.y + offsetZ);

        // Edge vector (from p1 to p2)
        const edge = new THREE.Vector3().subVectors(worldP2, worldP1);

        // To ensure OUTWARD normal, use edge midpoint to centroid direction
        const midpoint = new THREE.Vector3().addVectors(worldP1, worldP2).multiplyScalar(0.5);
        const toCenter = new THREE.Vector3(centroidX - midpoint.x, 0, centroidZ - midpoint.z);

        // Perpendicular to edge
        let normal = new THREE.Vector3(edge.z, 0, -edge.x).normalize();

        // If normal points TOWARD center, flip it to point OUTWARD
        if (normal.dot(toCenter) > 0) {
          normal.negate();
        }

        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, worldP1);
        clippingPlanes.push(plane);
      }

      // Top plane (pointing UP = outward from top)
      clippingPlanes.push(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(volume.topY + offsetY)));

      // Bottom plane (pointing DOWN = outward from bottom)
      clippingPlanes.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), volume.bottomY + offsetY));
    });

    // Helper function to find which model a mesh belongs to
    const findModelForMesh = (mesh: THREE.Object3D): SimulationModel | null => {
      let current: THREE.Object3D | null = mesh;
      while (current) {
        const foundModel = models.find(m => m.mesh === current);
        if (foundModel) return foundModel;
        current = current.parent;
      }
      return null;
    };

    // Helper function to build clipping planes for a specific set of volumes
    const buildClippingPlanesForVolumes = (volumes: DemolitionVolume[]): THREE.Plane[] => {
      const planes: THREE.Plane[] = [];

      volumes.forEach(volume => {
        const offsetX = volume.position.x;
        const offsetY = volume.position.y;
        const offsetZ = volume.position.z;

        // Calculate polygon centroid
        let centroidX = 0, centroidZ = 0;
        volume.polygon.forEach(p => {
          centroidX += p.x;
          centroidZ += p.y;
        });
        centroidX = centroidX / volume.polygon.length + offsetX;
        centroidZ = centroidZ / volume.polygon.length + offsetZ;

        // Side planes with OUTWARD normals
        for (let i = 0; i < volume.polygon.length; i++) {
          const p1 = volume.polygon[i];
          const p2 = volume.polygon[(i + 1) % volume.polygon.length];

          const worldP1 = new THREE.Vector3(p1.x + offsetX, 0, p1.y + offsetZ);
          const worldP2 = new THREE.Vector3(p2.x + offsetX, 0, p2.y + offsetZ);
          const edge = new THREE.Vector3().subVectors(worldP2, worldP1);
          const midpoint = new THREE.Vector3().addVectors(worldP1, worldP2).multiplyScalar(0.5);
          const toCenter = new THREE.Vector3(centroidX - midpoint.x, 0, centroidZ - midpoint.z);

          let normal = new THREE.Vector3(edge.z, 0, -edge.x).normalize();
          if (normal.dot(toCenter) > 0) {
            normal.negate();
          }

          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, worldP1);
          planes.push(plane);
        }

        // Top and bottom planes
        planes.push(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(volume.topY + offsetY)));
        planes.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), volume.bottomY + offsetY));
      });

      return planes;
    };

    console.log('Demolition clipping: applying', clippingPlanes.length, 'planes from', visibleVolumes.length, 'volumes');

    // Apply to all meshes in scene, respecting affectedModels
    let appliedCount = 0;
    scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || !obj.material) return;

      // Skip helper/UI objects
      if (obj.name.includes('demolition') || obj.name.includes('section') || obj.name.includes('measurement')) return;
      if (obj.parent?.name?.includes('demolition') || obj.parent?.name?.includes('section')) return;
      if (obj.parent?.name?.includes('measurement') || obj.parent?.name?.includes('pending')) return;
      if (obj.parent instanceof THREE.GridHelper) return;

      // Find which model this mesh belongs to
      const parentModel = findModelForMesh(obj);

      // Filter volumes to only those that affect this model
      let applicableVolumes: DemolitionVolume[];
      if (parentModel) {
        applicableVolumes = visibleVolumes.filter(v =>
          v.affectedModels === 'all' || (v.affectedModels as string[]).includes(parentModel.id)
        );
      } else {
        // For meshes not belonging to any model (like floors from construction), apply 'all' volumes only
        applicableVolumes = visibleVolumes.filter(v => v.affectedModels === 'all');
      }

      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];

      if (applicableVolumes.length === 0) {
        // No volumes affect this mesh, clear clipping
        materials.forEach((mat) => {
          mat.clippingPlanes = [];
          mat.clipIntersection = false;
          mat.needsUpdate = true;
        });
      } else {
        // Build clipping planes only for applicable volumes
        const meshClippingPlanes = buildClippingPlanesForVolumes(applicableVolumes);

        materials.forEach((mat) => {
          mat.clippingPlanes = meshClippingPlanes;
          mat.clipIntersection = true; // Clip where ALL planes have negative distance (inside volume)
          mat.clipShadows = true;
          mat.side = THREE.DoubleSide; // Ensure both sides render for cross-section visibility
          mat.needsUpdate = true;
        });
        appliedCount++;
      }
    });

    console.log('Demolition clipping: applied to', appliedCount, 'meshes');
  }, [scene, renderer, demolitionVolumes, models]);

  // Apply clipping to splat meshes using Spark's SplatEdit system
  useEffect(() => {
    if (!scene) return;

    // Get visible demolition volumes
    const visibleVolumes = demolitionVolumes.filter(v => v.visible);

    // For each splat mesh, apply edits
    models.forEach(model => {
      if (model.type !== 'splat' && model.type !== 'paired') return;
      if (!model.splatMesh) return;

      const splatMesh = model.splatMesh;

      // Check if this model should be affected
      const applicableVolumes = visibleVolumes.filter(v =>
        v.affectedModels === 'all' || (v.affectedModels as string[]).includes(model.id)
      );

      if (applicableVolumes.length === 0) {
        // Clear any existing edits
        splatMesh.edits = null;
        return;
      }

      // Create SplatEdit for each demolition volume
      const edits: SplatEdit[] = [];

      applicableVolumes.forEach(volume => {
        // Calculate bounding box of the polygon for BOX SDF approximation
        let minX = Infinity, maxX = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        volume.polygon.forEach(pt => {
          minX = Math.min(minX, pt.x);
          maxX = Math.max(maxX, pt.x);
          minZ = Math.min(minZ, pt.y); // pt.y is actually Z in world space
          maxZ = Math.max(maxZ, pt.y);
        });

        // Add volume position offset
        const offsetX = volume.position.x;
        const offsetY = volume.position.y;
        const offsetZ = volume.position.z;

        const centerX = (minX + maxX) / 2 + offsetX;
        const centerY = (volume.bottomY + volume.topY) / 2 + offsetY;
        const centerZ = (minZ + maxZ) / 2 + offsetZ;

        const sizeX = (maxX - minX) / 2;
        const sizeY = (volume.topY - volume.bottomY) / 2;
        const sizeZ = (maxZ - minZ) / 2;

        // Create a SplatEdit with MULTIPLY and opacity=0 to hide splats inside the box
        const edit = new SplatEdit({
          name: `demolition_${volume.id}`,
          rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
          softEdge: 0.1, // Small soft edge for smoother clipping
        });

        // Create a BOX SDF
        const boxSdf = new SplatEditSdf({
          type: SplatEditSdfType.BOX,
          opacity: 0, // Make splats inside fully transparent
          invert: false, // Affect inside of the box
        });

        // Position the box at the center of the volume (with offset)
        boxSdf.position.set(centerX, centerY, centerZ);

        // Set the box size using scale
        boxSdf.scale.set(sizeX, sizeY, sizeZ);

        edit.addSdf(boxSdf);
        edits.push(edit);
      });

      // Apply edits to the splat mesh
      splatMesh.edits = edits.length > 0 ? edits : null;
    });
  }, [scene, models, demolitionVolumes]);

  // Enable clipping in renderer
  useEffect(() => {
    if (renderer) {
      renderer.localClippingEnabled = true;
    }
  }, [renderer]);

  return (
    <div className="flex flex-col w-full h-full overflow-hidden">
      {/* Presentation Mode Label - Top Right */}
      {isPresentationMode && (
        <div className="absolute top-4 right-4 z-50 flex items-center gap-2 bg-black/70 text-white px-4 py-2 rounded-lg text-sm">
          <span className="font-medium">Präsentation Mode</span>
        </div>
      )}

      {/* ===== RIBBON BAR (hidden in presentation mode) ===== */}
      {!isPresentationMode && (
        <>
          {/* Ribbon Tab Buttons */}
          <div className="h-9 bg-white border-b border-gray-200 flex items-end px-4 shrink-0">
            {([
              { key: 'start' as RibbonTab, label: 'Start' },
              { key: 'import' as RibbonTab, label: 'Import' },
              { key: 'annotations' as RibbonTab, label: 'Annotations' },
              { key: 'presentation' as RibbonTab, label: 'Presentation' },
              { key: 'tools' as RibbonTab, label: 'Tools' },
              { key: 'render' as RibbonTab, label: 'Render' },
            ]).map(tab => (
              <button
                key={tab.key}
                onClick={() => handleRibbonTabChange(tab.key)}
                className={`px-4 py-1.5 text-xs font-medium transition-all border-b-2 ${
                  ribbonTab === tab.key
                    ? 'text-blue-600 border-blue-500 bg-blue-50/50'
                    : 'text-gray-500 border-transparent hover:text-gray-700 hover:bg-gray-50'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Ribbon Content — PowerPoint-style groups */}
          <div className="h-[90px] bg-gradient-to-b from-white to-gray-50 border-b border-gray-200 shrink-0 px-2 flex items-stretch">

            {/* ===== START TAB ===== */}
            {ribbonTab === 'start' && (
              <>
                {/* Slides group — stacked: New Slide on top, list on bottom */}
                <div className="flex flex-col px-3 py-1.5 gap-1">
                  <button onClick={() => { const ns: PresentationSlide = { id: `slide-${Date.now()}`, name: `Slide ${slides.length + 1}`, modelIds: [], hotspots: [] }; setSlides([...slides, ns]); }}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-gray-200 hover:bg-purple-50 hover:border-purple-300 transition cursor-pointer bg-white shadow-sm">
                    <span className="text-base">➕</span>
                    <span className="text-xs font-medium text-gray-700">New Slide</span>
                  </button>
                  <button onClick={() => setSidebarPanel(sidebarPanel === 'slides' ? null : 'slides')}
                    className={`flex items-center justify-center gap-1.5 px-3 py-1 rounded-md border transition cursor-pointer text-[11px] ${sidebarPanel === 'slides' ? 'bg-purple-100 border-purple-300 text-purple-700' : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100 hover:border-gray-300'}`}>
                    <List size={12} />
                    <span>Slides ({slides.length})</span>
                  </button>
                  <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider text-center">Slides</span>
                </div>
                <div className="w-px bg-gray-200 my-2" />
                {/* Section Cut group */}
                <div className="flex flex-col px-3 py-1.5 gap-1">
                  <div className="flex items-center gap-1">
                    <button onClick={() => { const slide = slides[activeSlideIndex]; const c = slide?.sectionCut; const ne = !c?.enabled; setSlides(p => p.map((s, i) => i === activeSlideIndex ? { ...s, sectionCut: { enabled: ne, height: c?.height ?? 1.5, showPlane: c?.showPlane ?? true } } : s)); setGlobalSectionCut({ enabled: ne, height: c?.height ?? 1.5, showPlane: c?.showPlane ?? true }); }}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md border transition cursor-pointer shadow-sm flex-1 ${slides[activeSlideIndex]?.sectionCut?.enabled ? 'bg-cyan-100 border-cyan-300' : 'bg-white border-gray-200 hover:bg-gray-50'}`}>
                      <span className="text-base">✂️</span>
                      <span className="text-xs font-medium text-gray-700">{slides[activeSlideIndex]?.sectionCut?.enabled ? 'Cut ON' : 'Section Cut'}</span>
                    </button>
                    {slides[activeSlideIndex]?.sectionCut?.enabled && (
                      <button onClick={() => { const sp = !(slides[activeSlideIndex]?.sectionCut?.showPlane ?? true); setSlides(p => p.map((s, i) => i === activeSlideIndex ? { ...s, sectionCut: { ...s.sectionCut!, showPlane: sp } } : s)); setGlobalSectionCut(p => ({ ...p, showPlane: sp })); }}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border transition cursor-pointer shadow-sm ${slides[activeSlideIndex]?.sectionCut?.showPlane ? 'bg-white border-gray-200 hover:bg-gray-50' : 'bg-gray-200 border-gray-300'}`}
                        title={slides[activeSlideIndex]?.sectionCut?.showPlane ? 'Hide section plane' : 'Show section plane'}>
                        {slides[activeSlideIndex]?.sectionCut?.showPlane ? <Eye size={14} className="text-gray-600" /> : <EyeOff size={14} className="text-gray-400" />}
                      </button>
                    )}
                  </div>
                  {slides[activeSlideIndex]?.sectionCut?.enabled && (
                    <div className="flex items-center gap-2">
                      <input type="range" min="-5" max="20" step="0.1" value={slides[activeSlideIndex]?.sectionCut?.height ?? 1.5} onChange={(e) => { const h = parseFloat(e.target.value); setSlides(p => p.map((s, i) => i === activeSlideIndex ? { ...s, sectionCut: { ...s.sectionCut!, height: h } } : s)); setGlobalSectionCut(p => ({ ...p, height: h })); }} className="w-20 h-1 accent-cyan-500" />
                      <span className="text-[9px] text-gray-500">{(slides[activeSlideIndex]?.sectionCut?.height ?? 1.5).toFixed(1)}m</span>
                    </div>
                  )}
                  <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider text-center mt-auto">Section</span>
                </div>
                <div className="w-px bg-gray-200 my-2" />
                {/* Share group */}
                <div className="flex flex-col items-center px-3 py-1.5 justify-center">
                  <button onClick={() => { setShowShareDialog(true); setShareResultUrl(null); setShareName(''); setShareDescription(''); setSharePdf(null); }}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-gray-200 hover:bg-blue-50 hover:border-blue-300 transition cursor-pointer bg-white shadow-sm">
                    <Share2 size={16} className="text-blue-600" />
                    <span className="text-xs font-medium text-gray-700">Share</span>
                  </button>
                  <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider mt-auto">Share</span>
                </div>
              </>
            )}

            {/* ===== IMPORT TAB ===== */}
            {ribbonTab === 'import' && (
              <>
                {/* Upload group — stacked buttons */}
                <div className="flex flex-col px-3 py-1.5 gap-1">
                  {pairedUploadMode === 'awaiting_splat' && pendingCollisionMesh ? (
                    <>
                      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-amber-300 bg-amber-50 shadow-sm">
                        <span className="text-base">⏳</span>
                        <div className="flex flex-col">
                          <span className="text-[10px] text-amber-700">Mesh: <strong>{pendingCollisionMesh.name}</strong></span>
                          <label className="text-xs font-medium text-amber-700 cursor-pointer hover:underline">+ Add Splat<input type="file" accept=".ply,.splat,.ksplat,.spz" className="hidden" onChange={handleUploadEnvironment} /></label>
                        </div>
                      </div>
                      <button onClick={handleCancelPairedUpload} className="flex items-center justify-center gap-1.5 px-3 py-1 rounded-md border border-amber-200 bg-amber-50 text-amber-600 hover:bg-amber-100 text-[11px] cursor-pointer transition">
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-1">
                        <label className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-gray-200 bg-white shadow-sm hover:bg-green-50 hover:border-green-300 transition cursor-pointer flex-1"
                          onDragOver={(e) => { if (e.dataTransfer.types.includes('application/project-file')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setSimModelDragOver(true); } }}
                          onDragEnter={(e) => { if (e.dataTransfer.types.includes('application/project-file')) { e.preventDefault(); setSimModelDragOver(true); } }}
                          onDragLeave={() => setSimModelDragOver(false)}
                          onDrop={(e) => { e.preventDefault(); setSimModelDragOver(false); handleDropSimulationModel(); }}>
                          <span className="text-base">📁</span>
                          <span className="text-xs font-medium text-gray-700">{simModelDragOver ? 'Drop here' : 'Upload'}</span>
                          <input type="file" accept=".gltf,.glb,.obj,.fbx,.ply,.splat,.ksplat,.spz" className="hidden" onChange={handleUploadEnvironment} />
                        </label>
                        <label className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-gray-200 bg-white shadow-sm hover:bg-purple-50 hover:border-purple-300 transition cursor-pointer flex-1">
                          <span className="text-base">🔗</span>
                          <span className="text-xs font-medium text-gray-700">Paired</span>
                          <input type="file" accept=".gltf,.glb,.obj,.fbx" className="hidden" onChange={handleStartPairedUpload} />
                        </label>
                      </div>
                    </>
                  )}
                  <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider text-center mt-auto">Upload</span>
                </div>
                {splatLoadingProgress !== null && (
                  <>
                    <div className="w-px bg-gray-200 my-2" />
                    <div className="flex flex-col items-center justify-center px-3 py-1.5">
                      <div className="flex items-center gap-2 text-xs text-blue-700">
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/></svg>
                        {splatLoadingProgress}%
                      </div>
                      <div className="w-16 h-1.5 bg-blue-200 rounded-full overflow-hidden mt-1"><div className="h-full bg-blue-500 transition-all" style={{ width: `${splatLoadingProgress}%` }} /></div>
                      <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider mt-1">Loading</span>
                    </div>
                  </>
                )}
              </>
            )}

            {/* ===== ANNOTATIONS TAB ===== */}
            {ribbonTab === 'annotations' && (
              <>
                {/* Measurements group — stacked: tools on top, list on bottom */}
                <div className="flex flex-col px-3 py-1.5 gap-1">
                  <div className="flex items-center gap-1">
                    <button onClick={() => setMeasureToolMode(measureToolMode === 'line' ? 'none' : 'line')}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md border transition cursor-pointer shadow-sm flex-1 ${measureToolMode === 'line' ? 'bg-green-100 border-green-300' : 'bg-white border-gray-200 hover:bg-green-50 hover:border-green-300'}`}>
                      <span className="text-base">📏</span>
                      <span className="text-xs font-medium text-gray-700">Distance</span>
                    </button>
                    <button onClick={() => setMeasureToolMode(measureToolMode === 'polygon' ? 'none' : 'polygon')}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md border transition cursor-pointer shadow-sm flex-1 ${measureToolMode === 'polygon' ? 'bg-blue-100 border-blue-300' : 'bg-white border-gray-200 hover:bg-blue-50 hover:border-blue-300'}`}>
                      <span className="text-base">📐</span>
                      <span className="text-xs font-medium text-gray-700">Area</span>
                    </button>
                  </div>
                  <button onClick={() => setSidebarPanel(sidebarPanel === 'measurements' ? null : 'measurements')}
                    className={`flex items-center justify-center gap-1.5 px-3 py-1 rounded-md border transition cursor-pointer text-[11px] ${sidebarPanel === 'measurements' ? 'bg-green-100 border-green-300 text-green-700' : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100 hover:border-gray-300'}`}>
                    <List size={12} />
                    <span>Measurements ({measurements.length})</span>
                  </button>
                  <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider text-center">Measurements</span>
                </div>
                <div className="w-px bg-gray-200 my-2" />
                {/* Hotspots group — stacked: Add on top, list on bottom */}
                <div className="flex flex-col px-3 py-1.5 gap-1">
                  <button onClick={() => setHotspotPlacementMode(!hotspotPlacementMode)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-md border transition cursor-pointer shadow-sm ${hotspotPlacementMode ? 'bg-orange-100 border-orange-300' : 'bg-white border-gray-200 hover:bg-orange-50 hover:border-orange-300'}`}>
                    <span className="text-base">📍</span>
                    <span className="text-xs font-medium text-gray-700">{hotspotPlacementMode ? 'Placing...' : 'Add Hotspot'}</span>
                  </button>
                  <button onClick={() => setSidebarPanel(sidebarPanel === 'hotspots' ? null : 'hotspots')}
                    className={`flex items-center justify-center gap-1.5 px-3 py-1 rounded-md border transition cursor-pointer text-[11px] ${sidebarPanel === 'hotspots' ? 'bg-orange-100 border-orange-300 text-orange-700' : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100 hover:border-gray-300'}`}>
                    <List size={12} />
                    <span>Hotspots ({hotspots.length})</span>
                  </button>
                  <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider text-center">Hotspots</span>
                </div>
              </>
            )}

            {/* ===== PRESENTATION TAB ===== */}
            {ribbonTab === 'presentation' && (
              <>
                {/* Compare group */}
                <div className="flex flex-col items-center px-3 py-1.5 justify-center">
                  <button onClick={() => slides.length >= 2 && setCompareMode(!compareMode)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-md border transition cursor-pointer shadow-sm ${compareMode ? 'bg-blue-100 border-blue-300' : slides.length < 2 ? 'opacity-40 cursor-not-allowed border-gray-200 bg-white' : 'bg-white border-gray-200 hover:bg-blue-50 hover:border-blue-300'}`}>
                    <span className="text-base">⚖️</span>
                    <span className="text-xs font-medium text-gray-700">{compareMode ? 'Compare ON' : 'Compare'}</span>
                  </button>
                  <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider mt-auto">Compare</span>
                </div>
                <div className="w-px bg-gray-200 my-2" />
                {/* Present group */}
                <div className="flex flex-col items-center px-3 py-1.5 justify-center">
                  <button onClick={() => onPresentationModeChange?.(!isPresentationMode)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all shadow cursor-pointer ${isPresentationMode ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-gradient-to-b from-green-500 to-emerald-600 text-white hover:from-green-600 hover:to-emerald-700'}`}>
                    <PlayCircle size={18} />
                    <span className="text-xs font-medium">{isPresentationMode ? 'Exit' : 'Present'}</span>
                  </button>
                  <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider mt-auto">Present</span>
                </div>
              </>
            )}

            {/* ===== TOOLS TAB ===== */}
            {ribbonTab === 'tools' && (
              <>
                {/* Demolition group — stacked: New on top, list on bottom */}
                <div className="flex flex-col px-3 py-1.5 gap-1">
                  <button onClick={() => { if (demolitionDrawMode !== 'none') { setDemolitionDrawMode('none'); setPendingDemolitionPoints([]); } else { setDemolitionDrawMode('drawing'); } }}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-md border transition cursor-pointer shadow-sm ${demolitionDrawMode !== 'none' ? 'bg-red-100 border-red-300' : 'bg-white border-gray-200 hover:bg-red-50 hover:border-red-300'}`}>
                    <span className="text-base">🏗️</span>
                    <span className="text-xs font-medium text-gray-700">{demolitionDrawMode !== 'none' ? 'Drawing...' : 'New Volume'}</span>
                  </button>
                  <button onClick={() => setSidebarPanel(sidebarPanel === 'volumes' ? null : 'volumes')}
                    className={`flex items-center justify-center gap-1.5 px-3 py-1 rounded-md border transition cursor-pointer text-[11px] ${sidebarPanel === 'volumes' ? 'bg-red-100 border-red-300 text-red-700' : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100 hover:border-gray-300'}`}>
                    <List size={12} />
                    <span>Volumes ({demolitionVolumes.length})</span>
                  </button>
                  <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider text-center">Demolition</span>
                </div>
              </>
            )}

            {/* ===== RENDER TAB ===== */}
            {ribbonTab === 'render' && (
              <>
                {/* Sun group */}
                <div className="flex flex-col px-3 py-1.5 gap-1">
                  <div className="flex items-center gap-2 px-2 py-1 rounded-md border border-gray-200 bg-white shadow-sm">
                    <span className="text-base">☀️</span>
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-1">
                        <span className="text-[9px] text-gray-400 w-6">Az</span>
                        <input type="range" min="0" max="360" step="5" value={sunAzimuth} onChange={(e) => setSunAzimuth(parseFloat(e.target.value))} className="w-16 h-1 accent-yellow-500" title={`Azimuth: ${sunAzimuth}°`} />
                        <span className="text-[9px] text-gray-500 w-7">{sunAzimuth}°</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-[9px] text-gray-400 w-6">El</span>
                        <input type="range" min="5" max="90" step="5" value={sunElevation} onChange={(e) => setSunElevation(parseFloat(e.target.value))} className="w-16 h-1 accent-orange-500" title={`Elevation: ${sunElevation}°`} />
                        <span className="text-[9px] text-gray-500 w-7">{sunElevation}°</span>
                      </div>
                    </div>
                  </div>
                  <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider text-center">Sun</span>
                </div>
                <div className="w-px bg-gray-200 my-2" />
                {/* Environment group */}
                <div className="flex flex-col px-3 py-1.5 gap-1 justify-center">
                  <button onClick={() => setSkyEnabled(!skyEnabled)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-md border transition cursor-pointer shadow-sm ${skyEnabled ? 'bg-blue-100 border-blue-300' : 'bg-white border-gray-200 hover:bg-blue-50 hover:border-blue-300'}`}>
                    <span className="text-base">🌤️</span>
                    <span className="text-xs font-medium text-gray-700">Sky {skyEnabled ? 'ON' : 'OFF'}</span>
                  </button>
                  {skyEnabled && (
                    <div className="flex items-center gap-2 px-1">
                      <span className="text-[9px] text-gray-400">Ground</span>
                      <input type="range" min="-10" max="10" step="0.5" value={skyGroundLevel} onChange={(e) => setSkyGroundLevel(parseFloat(e.target.value))} className="w-14 h-1 accent-green-500" />
                      <span className="text-[9px] text-gray-500">{skyGroundLevel.toFixed(1)}</span>
                    </div>
                  )}
                  <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider text-center mt-auto">Environment</span>
                </div>
                <div className="w-px bg-gray-200 my-2" />
                {/* Camera group — stacked: 16:9 + Capture on top, no list */}
                <div className="flex flex-col px-3 py-1.5 gap-1">
                  <div className="flex items-center gap-1">
                    <button onClick={() => setCameraFrameEnabled(!cameraFrameEnabled)}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md border transition cursor-pointer shadow-sm flex-1 ${cameraFrameEnabled ? 'bg-indigo-100 border-indigo-300' : 'bg-white border-gray-200 hover:bg-indigo-50 hover:border-indigo-300'}`}>
                      <span className="text-base">📷</span>
                      <span className="text-xs font-medium text-gray-700">16:9</span>
                    </button>
                    <button onClick={handleCaptureImage} disabled={!cameraFrameEnabled}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md border transition cursor-pointer shadow-sm flex-1 ${cameraFrameEnabled ? 'bg-white border-gray-200 hover:bg-indigo-50 hover:border-indigo-300' : 'opacity-30 cursor-not-allowed bg-white border-gray-200'}`}>
                      <span className="text-base">📸</span>
                      <span className="text-xs font-medium text-gray-700">Capture</span>
                    </button>
                  </div>
                  <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider text-center mt-auto">Camera</span>
                </div>
                <div className="w-px bg-gray-200 my-2" />
                {/* Materials group */}
                <div className="flex flex-col px-3 py-1.5 gap-1 justify-center">
                  <button onClick={() => setSidebarPanel(sidebarPanel === 'mesh-editor' ? null : 'mesh-editor')}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-md border transition cursor-pointer shadow-sm ${sidebarPanel === 'mesh-editor' ? 'bg-indigo-100 border-indigo-300' : 'bg-white border-gray-200 hover:bg-indigo-50 hover:border-indigo-300'}`}>
                    <span className="text-base">🎨</span>
                    <span className="text-xs font-medium text-gray-700">Materials</span>
                  </button>
                  <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider text-center mt-auto">Parts ({meshParts.length})</span>
                </div>
              </>
            )}

          </div>
        </>
      )}

      {/* ===== MAIN AREA: Slide Panel + 3D Viewport ===== */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar — shows slides, tool editors, etc. */}
        <div onMouseDown={(e) => e.stopPropagation()} className={`bg-white border-r border-gray-200 flex flex-col shrink-0 transition-all duration-200 ${
          isPresentationMode
            ? presentationSidebarVisible ? 'w-64' : 'w-0 overflow-hidden'
            : sidebarPanel ? 'w-64' : 'w-0 overflow-hidden'
        }`}>

          {/* ===== PRESENTATION MODE SIDEBAR ===== */}
          {isPresentationMode && presentationSidebarVisible && (
            <>
              <div className="p-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-white shrink-0">
                <div className="font-bold text-xs">Slides</div>
                <div className="text-[10px] text-purple-200">{activeSlideIndex + 1} / {slides.length}</div>
              </div>
              <div className="flex-1 overflow-auto p-2 space-y-1.5">
                {slides.map((slide, index) => (
                  <div key={slide.id} onClick={() => { setActiveSlideIndex(index); setCompareMode(false); }}
                    className={`p-2 rounded-lg cursor-pointer transition-all ${index === activeSlideIndex ? 'bg-purple-100 border-2 border-purple-500' : 'bg-gray-50 border border-gray-200 hover:bg-gray-100'}`}>
                    <div className="flex items-center gap-2">
                      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${index === activeSlideIndex ? 'bg-purple-500 text-white' : 'bg-gray-300 text-gray-600'}`}>{index + 1}</span>
                      <span className={`text-xs font-medium truncate ${index === activeSlideIndex ? 'text-purple-700' : 'text-gray-600'}`}>{slide.name}</span>
                    </div>
                  </div>
                ))}
                {slides.length > 1 && activeSlideIndex < slides.length - 1 && (
                  <button onClick={() => setCompareMode(!compareMode)} className={`w-full p-2 rounded-lg text-sm font-medium transition ${compareMode ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                    {compareMode ? '✓ Compare Mode ON' : 'Compare with Next'}
                  </button>
                )}
              </div>
            </>
          )}

          {/* ===== NORMAL MODE SIDEBAR ===== */}
          {!isPresentationMode && sidebarPanel && (
            <>
              {/* Sidebar header */}
              <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-1.5">
                  {(sidebarPanel === 'hotspot-editor' || sidebarPanel === 'volume-editor') && (
                    <button onClick={() => setSidebarPanel(sidebarPanel === 'hotspot-editor' ? 'hotspots' : 'volumes')} className="p-0.5 rounded hover:bg-gray-100 text-gray-400" title="Back to list">
                      <ChevronLeft size={14} />
                    </button>
                  )}
                  <span className="text-xs font-semibold text-gray-700">
                    {sidebarPanel === 'slides' ? 'Slides & Models' : sidebarPanel === 'hotspots' ? 'Hotspots' : sidebarPanel === 'hotspot-editor' ? 'Edit Hotspot' : sidebarPanel === 'measurements' ? 'Measurements' : sidebarPanel === 'mesh-editor' ? 'Materials' : sidebarPanel === 'volumes' ? 'Demolition Volumes' : sidebarPanel === 'volume-editor' ? 'Volume Editor' : ''}
                  </span>
                </div>
                <button onClick={() => setSidebarPanel(null)} className="p-0.5 rounded hover:bg-gray-100 text-gray-400"><X size={12} /></button>
              </div>

              <div className="flex-1 overflow-auto p-2 space-y-2">
                {/* ---- Slides panel ---- */}
                {sidebarPanel === 'slides' && (
                  <>
                    {/* Slide thumbnails */}
                    <div className="space-y-1.5">
                      {slides.map((slide, index) => {
                        const isActive = index === activeSlideIndex;
                        return (
                          <div key={slide.id} onClick={() => { setActiveSlideIndex(index); setCompareMode(false); }}
                            className={`p-2 rounded-lg cursor-pointer transition-all ${isActive ? 'bg-purple-100 border-2 border-purple-500' : 'bg-gray-50 border border-gray-200 hover:bg-gray-100'}`}>
                            <div className="flex items-center gap-2">
                              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${isActive ? 'bg-purple-500 text-white' : 'bg-gray-300 text-gray-600'}`}>{index + 1}</span>
                              <span className={`text-xs font-medium truncate ${isActive ? 'text-purple-700' : 'text-gray-600'}`}>{slide.name}</span>
                            </div>
                            {isActive && (
                              <div className="mt-1 flex items-center gap-1">
                                <span className="text-[9px] text-gray-400">{models.filter(m => slide.modelIds.includes(m.id)).length} models</span>
                                {slide.sectionCut?.enabled && <span className="text-[9px] text-cyan-600">✂️</span>}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {/* Models checklist for active slide */}
                    <div className="border-t border-gray-100 pt-2">
                      <h4 className="text-[10px] text-gray-400 uppercase font-semibold mb-1">Models on Slide {activeSlideIndex + 1}</h4>
                      {models.length === 0 ? (
                        <p className="text-[10px] text-gray-400 italic">No models uploaded</p>
                      ) : (
                        <div className="space-y-0.5">
                          {models.map(model => {
                            const slide = slides[activeSlideIndex];
                            const isOnSlide = slide?.modelIds.includes(model.id) ?? false;
                            return (
                              <label key={model.id} className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition text-xs ${isOnSlide ? 'bg-purple-50 border border-purple-200' : 'bg-gray-50 border border-transparent hover:bg-gray-100'}`}>
                                <input type="checkbox" checked={isOnSlide} onChange={() => { setSlides(slides.map((s, i) => i === activeSlideIndex ? { ...s, modelIds: isOnSlide ? s.modelIds.filter(id => id !== model.id) : [...s.modelIds, model.id] } : s)); }} className="w-3 h-3 accent-purple-500" />
                                <span className={`w-2 h-2 rounded-full shrink-0 ${model.type === 'building' ? 'bg-blue-500' : model.type === 'splat' ? 'bg-green-500' : model.type === 'paired' ? 'bg-purple-500' : 'bg-gray-500'}`} />
                                <span className="truncate font-medium text-gray-700">{model.name}</span>
                                <span className="ml-auto text-[9px] text-gray-400">{model.type === 'building' ? '🏠' : model.type === 'splat' ? '✨' : model.type === 'paired' ? '🔗' : '🌍'}</span>
                              </label>
                            );
                          })}
                          <div className="flex gap-1 mt-1">
                            <button onClick={() => setSlides(slides.map((s, i) => i === activeSlideIndex ? { ...s, modelIds: models.map(m => m.id) } : s))} className="px-2 py-0.5 text-[9px] font-medium text-purple-600 bg-purple-50 hover:bg-purple-100 rounded">Select All</button>
                            <button onClick={() => setSlides(slides.map((s, i) => i === activeSlideIndex ? { ...s, modelIds: [] } : s))} className="px-2 py-0.5 text-[9px] font-medium text-gray-500 bg-gray-50 hover:bg-gray-100 rounded">Clear All</button>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* ---- Hotspots List panel ---- */}
                {sidebarPanel === 'hotspots' && (
                  <div className="space-y-1">
                    {hotspots.length === 0 ? (
                      <div className="text-center py-6">
                        <span className="text-3xl mb-2 block">📍</span>
                        <p className="text-xs text-gray-400">No hotspots yet</p>
                        <p className="text-[10px] text-gray-300 mt-1">Use the Add button in the ribbon</p>
                      </div>
                    ) : (
                      hotspots.map(h => (
                        <div key={h.id}
                          onClick={() => { setEditingHotspotId(h.id); setSidebarPanel('hotspot-editor'); }}
                          className="flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition hover:bg-orange-50 bg-gray-50 border border-gray-100">
                          <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: h.color || '#ff6b00' }} />
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-medium text-gray-700 truncate block">{h.name}</span>
                            {h.description && <span className="text-[9px] text-gray-400 truncate block">{h.description}</span>}
                            <div className="flex items-center gap-1 mt-0.5">
                              {h.savedView && <span className="text-[8px] bg-green-100 text-green-600 px-1 rounded">📷 View</span>}
                              {h.linkedDemolitionId && <span className="text-[8px] bg-red-100 text-red-600 px-1 rounded">🏗️</span>}
                              {h.linkedMeasurementId && <span className="text-[8px] bg-blue-100 text-blue-600 px-1 rounded">📏</span>}
                              {h.linkedImage && <span className="text-[8px] bg-purple-100 text-purple-600 px-1 rounded">🖼️</span>}
                              {h.linked360Image && <span className="text-[8px] bg-cyan-100 text-cyan-600 px-1 rounded">360°</span>}
                            </div>
                          </div>
                          <ChevronRight size={12} className="text-gray-400 shrink-0" />
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* ---- Measurements List panel ---- */}
                {sidebarPanel === 'measurements' && (
                  <div className="space-y-1">
                    {measurements.length === 0 ? (
                      <div className="text-center py-6">
                        <span className="text-3xl mb-2 block">📏</span>
                        <p className="text-xs text-gray-400">No measurements yet</p>
                        <p className="text-[10px] text-gray-300 mt-1">Use Distance or Area tools in the ribbon</p>
                      </div>
                    ) : (
                      measurements.map(m => (
                        <div key={m.id}
                          className="flex items-center gap-2 px-2 py-2 rounded-lg bg-gray-50 border border-gray-100 group">
                          <span className="text-base">{m.type === 'line' ? '📏' : '📐'}</span>
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-medium text-gray-700 block">
                              {m.type === 'line' ? `Distance: ${m.distance?.toFixed(2)}m` : `Area: ${m.area?.toFixed(2)}m²`}
                            </span>
                            <span className="text-[9px] text-gray-400">{m.type === 'line' ? '2 points' : `${(m as any).points?.length || 0} points`}</span>
                          </div>
                          <button onClick={(e) => { e.stopPropagation(); setMeasurements(prev => prev.filter(x => x.id !== m.id)); }}
                            className="p-1 rounded hover:bg-red-100 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition">
                            <X size={12} />
                          </button>
                        </div>
                      ))
                    )}
                    {measurements.length > 0 && (
                      <button onClick={() => setMeasurements([])}
                        className="w-full mt-2 px-2 py-1.5 rounded text-[10px] font-medium text-red-500 bg-red-50 hover:bg-red-100 border border-red-200">
                        Clear All Measurements
                      </button>
                    )}
                  </div>
                )}

                {/* ---- Volumes List panel ---- */}
                {sidebarPanel === 'volumes' && (
                  <div className="space-y-1">
                    {demolitionVolumes.length === 0 ? (
                      <div className="text-center py-6">
                        <span className="text-3xl mb-2 block">🏗️</span>
                        <p className="text-xs text-gray-400">No demolition volumes yet</p>
                        <p className="text-[10px] text-gray-300 mt-1">Use the New button in the ribbon</p>
                      </div>
                    ) : (
                      demolitionVolumes.map(v => (
                        <div key={v.id}
                          onClick={() => { setSelectedDemolitionId(v.id); setSidebarPanel('volume-editor'); }}
                          className={`flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition hover:bg-red-50 border ${selectedDemolitionId === v.id ? 'bg-red-50 border-red-300' : 'bg-gray-50 border-gray-100'}`}>
                          <span className="text-base">🏗️</span>
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-medium text-gray-700 truncate block">{v.name}</span>
                            <span className="text-[9px] text-gray-400">Top: {(v.topY ?? 0).toFixed(1)}m · Base: {(v.bottomY ?? 0).toFixed(1)}m</span>
                          </div>
                          <ChevronRight size={12} className="text-gray-400 shrink-0" />
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* ---- Hotspot Editor panel ---- */}
                {sidebarPanel === 'hotspot-editor' && !editingHotspot && (
                  <p className="text-xs text-gray-400">Select a hotspot to edit</p>
                )}
                {sidebarPanel === 'hotspot-editor' && editingHotspot && (
                  <div className="space-y-3">
                    <div>
                      <label className="text-[10px] text-gray-500 uppercase font-semibold">Name</label>
                      <input type="text" value={editingHotspot!.name} onChange={(e) => updateHotspot(editingHotspotId!, { name: e.target.value })} className="w-full px-2 py-1.5 text-xs border rounded mt-0.5" />
                    </div>
                    <div>
                      <label className="text-[10px] text-gray-500 uppercase font-semibold">Description</label>
                      <textarea value={editingHotspot!.description || ''} onChange={(e) => updateHotspot(editingHotspotId!, { description: e.target.value })} placeholder="Add a description..." className="w-full px-2 py-1.5 text-xs border rounded mt-0.5 resize-none" rows={3} />
                    </div>
                    <div>
                      <label className="text-[10px] text-gray-500 uppercase font-semibold">Color</label>
                      <div className="flex gap-1 mt-1">
                        {['#ff6b00', '#ff0000', '#00ff00', '#0066ff', '#9900ff', '#ff00ff'].map(color => (
                          <button key={color} onClick={() => updateHotspot(editingHotspotId!, { color })} className={`w-6 h-6 rounded-full border-2 transition ${editingHotspot!.color === color ? 'border-gray-800 scale-110' : 'border-gray-300'}`} style={{ backgroundColor: color }} />
                        ))}
                      </div>
                    </div>
                    <button onClick={() => { if (camera && controls) { updateHotspot(editingHotspotId!, { savedView: { position: { x: camera.position.x, y: camera.position.y, z: camera.position.z }, target: { x: (controls as any).target.x, y: (controls as any).target.y, z: (controls as any).target.z } } }); } }} className="w-full px-2 py-1.5 rounded text-xs font-medium bg-gray-100 hover:bg-gray-200 text-gray-700">📷 Save Current View</button>
                    {editingHotspot!.savedView && <span className="text-[10px] text-green-600">✓ View saved</span>}
                    {demolitionVolumes.length > 0 && (
                      <div>
                        <label className="text-[10px] text-gray-500 uppercase font-semibold">Link Demolition</label>
                        <select className="w-full px-2 py-1.5 text-xs border rounded mt-0.5" value={editingHotspot!.linkedDemolitionId || ''} onChange={(e) => updateHotspot(editingHotspotId!, { linkedDemolitionId: e.target.value || undefined })}>
                          <option value="">None</option>
                          {demolitionVolumes.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                        </select>
                      </div>
                    )}
                    {measurements.length > 0 && (
                      <div>
                        <label className="text-[10px] text-gray-500 uppercase font-semibold">Link Measurement</label>
                        <select className="w-full px-2 py-1.5 text-xs border rounded mt-0.5" value={editingHotspot!.linkedMeasurementId || ''} onChange={(e) => updateHotspot(editingHotspotId!, { linkedMeasurementId: e.target.value || undefined })}>
                          <option value="">None</option>
                          {measurements.map(m => <option key={m.id} value={m.id}>{m.type === 'line' ? `📏 ${m.distance?.toFixed(2)}m` : `📐 ${m.area?.toFixed(2)}m²`}</option>)}
                        </select>
                      </div>
                    )}
                    <div>
                      <label className="flex items-center gap-2 text-xs">
                        <input type="checkbox" checked={!!editingHotspot!.sectionCutAction?.enabled} onChange={(e) => updateHotspot(editingHotspotId!, { sectionCutAction: { enabled: e.target.checked, height: editingHotspot!.sectionCutAction?.height ?? 1.5 } })} className="w-3 h-3" />
                        Section Cut Action
                      </label>
                      {editingHotspot!.sectionCutAction?.enabled && (
                        <input type="range" min="-5" max="20" step="0.1" value={editingHotspot!.sectionCutAction!.height} onChange={(e) => updateHotspot(editingHotspotId!, { sectionCutAction: { ...editingHotspot!.sectionCutAction!, height: parseFloat(e.target.value) } })} className="w-full h-1 mt-1 accent-cyan-500" />
                      )}
                    </div>
                    <div>
                      <label className="text-[10px] text-gray-500 uppercase font-semibold">Linked Image</label>
                      {editingHotspot!.linkedImage ? (
                        <div className="relative mt-1">
                          <img src={editingHotspot!.linkedImage} alt="" className="w-full h-20 object-cover rounded" />
                          <button onClick={() => updateHotspot(editingHotspotId!, { linkedImage: undefined })} className="absolute top-0 right-0 bg-red-500 text-white rounded-full p-0.5"><X size={10} /></button>
                        </div>
                      ) : (
                        <label className="block mt-1 p-3 border-2 border-dashed border-gray-300 rounded text-center cursor-pointer hover:bg-gray-50 text-[10px] text-gray-400">
                          + Upload Image
                          <input type="file" accept="image/*" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) { const reader = new FileReader(); reader.onload = (ev) => updateHotspot(editingHotspotId!, { linkedImage: ev.target?.result as string }); reader.readAsDataURL(file); } e.target.value = ''; }} />
                        </label>
                      )}
                    </div>
                    <div>
                      <label className="text-[10px] text-gray-500 uppercase font-semibold">360° Panorama</label>
                      {editingHotspot!.linked360Image ? (
                        <div className="relative mt-1">
                          <img src={editingHotspot!.linked360Image} alt="" className="w-full h-20 object-cover rounded" />
                          <span className="absolute top-1 left-1 text-[8px] bg-cyan-600 text-white px-1 rounded font-bold">360°</span>
                          <button onClick={() => updateHotspot(editingHotspotId!, { linked360Image: undefined })} className="absolute top-0 right-0 bg-red-500 text-white rounded-full p-0.5"><X size={10} /></button>
                        </div>
                      ) : (
                        <label className="block mt-1 p-3 border-2 border-dashed border-gray-300 rounded text-center cursor-pointer hover:bg-gray-50 text-[10px] text-gray-400">
                          + Upload 360°
                          <input type="file" accept="image/*" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) { const reader = new FileReader(); reader.onload = (ev) => updateHotspot(editingHotspotId!, { linked360Image: ev.target?.result as string }); reader.readAsDataURL(file); } e.target.value = ''; }} />
                        </label>
                      )}
                    </div>
                    <button onClick={() => deleteHotspot(editingHotspotId!)} className="w-full px-2 py-1.5 rounded text-xs font-medium bg-red-50 text-red-600 hover:bg-red-100 border border-red-200">Delete Hotspot</button>
                  </div>
                )}

                {/* ---- Mesh Part Editor panel ---- */}
                {sidebarPanel === 'mesh-editor' && (
                  <div className="space-y-3">
                    <div>
                      <h4 className="text-[10px] text-gray-400 uppercase font-semibold mb-1">Parts ({meshParts.length})</h4>
                      {meshParts.length === 0 ? (
                        <p className="text-[10px] text-gray-400">No mesh parts. Load a model.</p>
                      ) : (
                        <div className="space-y-0.5">
                          {meshParts.map(part => (
                            <button key={part.id}
                              onClick={(e) => { if (e.shiftKey) { setSelectedMeshPartIds(prev => prev.includes(part.id) ? prev.filter(id => id !== part.id) : [...prev, part.id]); } else { setSelectedMeshPartIds(prev => prev.includes(part.id) && prev.length === 1 ? [] : [part.id]); } }}
                              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition text-left ${selectedMeshPartIds.includes(part.id) ? 'bg-indigo-100 border border-indigo-400' : 'bg-gray-50 hover:bg-gray-100 border border-transparent'}`}>
                              <div className="w-3 h-3 rounded-sm border" style={{ backgroundColor: part.currentColor || '#ccc' }} />
                              <span className="truncate">{part.name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {selectedMeshPartIds.length > 0 && (
                      <>
                        <div className="border-t border-gray-100 pt-2">
                          <h4 className="text-[10px] text-gray-400 uppercase font-semibold mb-1">
                            Editing: {selectedMeshPartIds.length === 1 ? meshParts.find(p => p.id === selectedMeshPartIds[0])?.name : `${selectedMeshPartIds.length} parts`}
                          </h4>
                        </div>
                        <div>
                          <label className="text-[10px] text-gray-500 uppercase font-semibold">Type</label>
                          <div className="flex gap-1 mt-1">
                            {['wall', 'floor', 'door', 'window', 'other'].map(type => (
                              <button key={type} onClick={() => selectedMeshPartIds.forEach(id => setMeshPartType(id, type as any))}
                                className={`px-2 py-1 rounded text-[10px] transition ${meshParts.find(p => p.id === selectedMeshPartIds[0])?.elementType === type ? 'bg-indigo-500 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
                                {type === 'wall' ? '🧱' : type === 'floor' ? '🪵' : type === 'door' ? '🚪' : type === 'window' ? '🪟' : '📦'}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <label className="text-[10px] text-gray-500 uppercase font-semibold">RAL Colors</label>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {ralColors.map(ral => (
                              <button key={ral.code} onClick={() => selectedMeshPartIds.forEach(id => applyColorToMeshPart(id, ral.code, ral.hex))}
                                className="w-5 h-5 rounded-sm border border-gray-300 hover:ring-2 hover:ring-indigo-400 transition" style={{ backgroundColor: ral.hex }} title={ral.code} />
                            ))}
                          </div>
                        </div>
                        <div>
                          <label className="text-[10px] text-gray-500 uppercase font-semibold">Custom Color</label>
                          <input type="color" value={meshParts.find(p => p.id === selectedMeshPartIds[0])?.currentColor || '#cccccc'} onChange={(e) => selectedMeshPartIds.forEach(id => applyColorToMeshPart(id, null, e.target.value))} className="w-full h-8 mt-1 cursor-pointer rounded" />
                        </div>
                        <div>
                          <label className="text-[10px] text-gray-500 uppercase font-semibold">Opacity: {Math.round((meshParts.find(p => p.id === selectedMeshPartIds[0])?.currentOpacity ?? 1) * 100)}%</label>
                          <input type="range" min="0" max="1" step="0.05" value={meshParts.find(p => p.id === selectedMeshPartIds[0])?.currentOpacity ?? 1} onChange={(e) => selectedMeshPartIds.forEach(id => applyColorToMeshPart(id, null, null, parseFloat(e.target.value)))} className="w-full h-1 accent-indigo-500" />
                        </div>
                        <button onClick={() => selectedMeshPartIds.forEach(id => resetMeshPart(id))} className="w-full px-2 py-1.5 rounded text-xs bg-gray-100 hover:bg-gray-200 text-gray-600">Reset to Original</button>
                      </>
                    )}
                  </div>
                )}

                {/* ---- Volume Editor panel ---- */}
                {sidebarPanel === 'volume-editor' && !editingVolume && (
                  <p className="text-xs text-gray-400">Select a volume to edit</p>
                )}
                {sidebarPanel === 'volume-editor' && editingVolume && (
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold text-gray-700">{editingVolume!.name}</h4>
                    <div>
                      <div className="flex items-center justify-between mb-0.5"><span className="text-[10px] text-gray-500">Top Y</span><span className="text-[10px] text-gray-500">{(editingVolume!.topY ?? 2).toFixed(1)}m</span></div>
                      <input type="range" min="0.1" max="20" step="0.1" value={editingVolume!.topY ?? 2} onChange={(e) => setDemolitionVolumes(prev => prev.map(v => v.id === selectedDemolitionId ? { ...v, topY: parseFloat(e.target.value) } : v))} className="w-full h-1 accent-red-500" />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-0.5"><span className="text-[10px] text-gray-500">Base Y</span><span className="text-[10px] text-gray-500">{(editingVolume!.bottomY ?? 0).toFixed(1)}m</span></div>
                      <input type="range" min="-5" max="10" step="0.1" value={editingVolume!.bottomY ?? 0} onChange={(e) => setDemolitionVolumes(prev => prev.map(v => v.id === selectedDemolitionId ? { ...v, bottomY: parseFloat(e.target.value) } : v))} className="w-full h-1 accent-red-500" />
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => setDemolitionVolumes(prev => prev.map(v => v.id === selectedDemolitionId ? { ...v, showVolume: !v.showVolume } : v))}
                        className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition flex items-center justify-center gap-1 ${editingVolume!.showVolume ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>
                        {editingVolume!.showVolume ? <Eye size={12} /> : <EyeOff size={12} />}
                        {editingVolume!.showVolume ? 'Box Visible' : 'Box Hidden'}
                      </button>
                      <button onClick={() => setDemolitionGizmoEnabled(!demolitionGizmoEnabled)}
                        className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition ${demolitionGizmoEnabled ? 'bg-yellow-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                        🎯 Gizmo {demolitionGizmoEnabled ? 'ON' : 'OFF'}
                      </button>
                    </div>
                    <button onClick={() => { setDemolitionVolumes(prev => prev.filter(v => v.id !== selectedDemolitionId)); setSelectedDemolitionId(null); setSidebarPanel(null); }}
                      className="w-full px-2 py-1.5 rounded text-xs font-medium bg-red-50 text-red-600 hover:bg-red-100 border border-red-200">Delete Volume</button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* ===== 3D VIEWPORT ===== */}
        {/* Sidebar collapse toggle (when collapsed) */}
        {!isPresentationMode && !sidebarPanel && (
          <button
            onClick={() => setSidebarPanel('slides')}
            className="w-6 bg-gray-100 hover:bg-gray-200 border-r border-gray-200 flex items-center justify-center shrink-0 transition"
            title="Show sidebar"
          >
            <ChevronRight size={14} className="text-gray-500" />
          </button>
        )}

        {/* Main 3D Viewer */}
        <div className="flex-1 relative overflow-hidden">
        <ViewerCanvas edgesVisible={false} onToggleEdges={() => {}} />

        <div className="absolute top-4 left-4 z-50 flex gap-2 items-center">
          <button
            onClick={handleFocusAll}
            className="p-2 bg-white rounded-lg shadow-md hover:bg-gray-100"
            title="Focus on all models"
          >
            <Focus size={20} />
          </button>
          {/* Presentation mode keyboard shortcuts */}
          {isPresentationMode && (
            <div className="flex items-center gap-2 bg-black/70 text-white px-3 py-2 rounded-lg">
              <span className="text-xs text-gray-300">← → Navigate</span>
              <span className="text-gray-500">|</span>
              <span className="text-xs text-gray-300">Space: Compare</span>
              <span className="text-gray-500">|</span>
              <span className="text-xs text-gray-300">Tab: Sidebar</span>
              <span className="text-gray-500">|</span>
              <span className="text-xs text-gray-300">Esc: Exit</span>
            </div>
          )}
        </div>

        {/* Selected Model Info Popup */}
        {selectedModelId && (() => {
          const selectedModel = models.find(m => m.id === selectedModelId);
          if (!selectedModel) return null;
          return (
            <div className="absolute top-16 left-4 z-50 bg-white rounded-lg shadow-lg border border-gray-200 p-4 w-64">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-lg">
                    {selectedModel.type === 'building' ? '🏠' : selectedModel.type === 'splat' ? '✨' : selectedModel.type === 'paired' ? '🔗' : '🌍'}
                  </span>
                  <span className="font-medium text-sm truncate max-w-[140px]">{selectedModel.name}</span>
                </div>
                <button
                  onClick={() => {
                    setSelectedModelId(null);
                    setGizmoEnabled(false);
                  }}
                  className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Gizmo Mode Toggle */}
              <div className="flex gap-1 mb-3">
                <button
                  onClick={() => setGizmoMode('translate')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded transition ${
                    gizmoMode === 'translate' ? 'bg-blue-500 text-white' : 'bg-gray-100 hover:bg-gray-200'
                  }`}
                >
                  Move
                </button>
                <button
                  onClick={() => setGizmoMode('rotate')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded transition ${
                    gizmoMode === 'rotate' ? 'bg-green-500 text-white' : 'bg-gray-100 hover:bg-gray-200'
                  }`}
                >
                  Rotate
                </button>
                <button
                  onClick={() => setGizmoMode('scale')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded transition ${
                    gizmoMode === 'scale' ? 'bg-yellow-500 text-white' : 'bg-gray-100 hover:bg-gray-200'
                  }`}
                >
                  Scale
                </button>
              </div>

              {/* Position */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-gray-500 uppercase">Position (m)</h4>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="text-[10px] text-gray-400">X</label>
                    <input
                      type="number"
                      step="0.01"
                      className="w-full border rounded px-2 py-1 text-xs"
                      value={selectedModel.position.x.toFixed(3)}
                      onChange={(e) => handleUpdateModel(selectedModel.id, {
                        position: new THREE.Vector3(parseFloat(e.target.value) || 0, selectedModel.position.y, selectedModel.position.z)
                      })}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-400">Y</label>
                    <input
                      type="number"
                      step="0.01"
                      className="w-full border rounded px-2 py-1 text-xs"
                      value={selectedModel.position.y.toFixed(3)}
                      onChange={(e) => handleUpdateModel(selectedModel.id, {
                        position: new THREE.Vector3(selectedModel.position.x, parseFloat(e.target.value) || 0, selectedModel.position.z)
                      })}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-400">Z</label>
                    <input
                      type="number"
                      step="0.01"
                      className="w-full border rounded px-2 py-1 text-xs"
                      value={selectedModel.position.z.toFixed(3)}
                      onChange={(e) => handleUpdateModel(selectedModel.id, {
                        position: new THREE.Vector3(selectedModel.position.x, selectedModel.position.y, parseFloat(e.target.value) || 0)
                      })}
                    />
                  </div>
                </div>
              </div>

              {/* Rotation */}
              <div className="space-y-2 mt-3">
                <h4 className="text-xs font-bold text-gray-500 uppercase">Rotation (°)</h4>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="text-[10px] text-gray-400">X</label>
                    <input
                      type="number"
                      step="1"
                      className="w-full border rounded px-2 py-1 text-xs"
                      value={(selectedModel.rotation.x * 180 / Math.PI).toFixed(1)}
                      onChange={(e) => handleUpdateModel(selectedModel.id, {
                        rotation: new THREE.Euler((parseFloat(e.target.value) || 0) * Math.PI / 180, selectedModel.rotation.y, selectedModel.rotation.z)
                      })}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-400">Y</label>
                    <input
                      type="number"
                      step="1"
                      className="w-full border rounded px-2 py-1 text-xs"
                      value={(selectedModel.rotation.y * 180 / Math.PI).toFixed(1)}
                      onChange={(e) => handleUpdateModel(selectedModel.id, {
                        rotation: new THREE.Euler(selectedModel.rotation.x, (parseFloat(e.target.value) || 0) * Math.PI / 180, selectedModel.rotation.z)
                      })}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-400">Z</label>
                    <input
                      type="number"
                      step="1"
                      className="w-full border rounded px-2 py-1 text-xs"
                      value={(selectedModel.rotation.z * 180 / Math.PI).toFixed(1)}
                      onChange={(e) => handleUpdateModel(selectedModel.id, {
                        rotation: new THREE.Euler(selectedModel.rotation.x, selectedModel.rotation.y, (parseFloat(e.target.value) || 0) * Math.PI / 180)
                      })}
                    />
                  </div>
                </div>
              </div>

              {/* Scale */}
              <div className="space-y-2 mt-3">
                <h4 className="text-xs font-bold text-gray-500 uppercase">Scale</h4>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min="0.01"
                    max="10"
                    step="0.01"
                    className="flex-1"
                    value={selectedModel.scale.x}
                    onChange={(e) => handleUpdateModel(selectedModel.id, {
                      scale: new THREE.Vector3(parseFloat(e.target.value), parseFloat(e.target.value), parseFloat(e.target.value))
                    })}
                  />
                  <span className="text-xs text-gray-600 w-12 text-right">{selectedModel.scale.x.toFixed(2)}x</span>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Active Hotspot Info Panel */}
        {activeHotspotId && (() => {
          const activeHotspot = hotspots.find(h => h.id === activeHotspotId);
          if (!activeHotspot) return null;

          // Get linked information (check new fields first, fall back to legacy actions)
          const demId = activeHotspot.linkedDemolitionId || activeHotspot.actions.showDemolitionVolume;
          const linkedDemolitionVolume = demId ? demolitionVolumes.find(v => v.id === demId) : null;
          const measId = activeHotspot.linkedMeasurementId || activeHotspot.actions.showMeasurement;
          const linkedMeasurement = measId ? measurements.find(m => m.id === measId) : null;
          const hasSectionCut = activeHotspot.sectionCutAction?.enabled || activeHotspot.actions.activateSectionCut;
          const sectionCutHeight = activeHotspot.sectionCutAction?.height ?? activeHotspot.actions.sectionCutHeight;

          // Check if there are any linked actions
          const hasLinkedInfo = linkedDemolitionVolume || linkedMeasurement || hasSectionCut;
          const hasImage = !!activeHotspot.linkedImage;

          return (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 bg-white rounded-xl shadow-xl border border-orange-200 overflow-hidden flex" style={{ minWidth: hasImage ? `${280 + hotspotImageSize}px` : '280px', maxWidth: '900px' }}>
              {/* Left Side - Info */}
              <div className="flex-1 min-w-[280px]">
                {/* Header */}
                <div className="bg-gradient-to-r from-orange-50 to-orange-100 px-4 py-3 border-b border-orange-200">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-5 h-5 rounded-full shadow-sm border border-white/50"
                        style={{ backgroundColor: activeHotspot.color }}
                      />
                      <h3 className="font-semibold text-gray-800">{activeHotspot.name}</h3>
                    </div>
                    <button
                      onClick={closeHotspotPopup}
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

                {/* Linked Information */}
                {hasLinkedInfo && (
                  <div className="px-4 py-3 space-y-2 border-b border-gray-100">
                    {/* Section Cut */}
                    {hasSectionCut && (
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
                          {sectionCutHeight !== undefined ? `${sectionCutHeight.toFixed(1)}m` : 'Active'}
                        </span>
                      </div>
                    )}

                    {/* Demolition Volume */}
                    {linkedDemolitionVolume && (
                      <div className="flex items-center gap-2 text-sm">
                        <div className="w-6 h-6 rounded bg-red-100 flex items-center justify-center">
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
                            <rect x="3" y="3" width="18" height="18" rx="2"/>
                            <path d="M9 9l6 6"/>
                            <path d="M15 9l-6 6"/>
                          </svg>
                        </div>
                        <span className="text-gray-600">Demolition</span>
                        <span className="ml-auto font-medium text-red-600 truncate max-w-[120px]" title={linkedDemolitionVolume.name}>
                          {linkedDemolitionVolume.name}
                        </span>
                      </div>
                    )}

                    {/* Measurement */}
                    {linkedMeasurement && (
                      <div className="flex items-center gap-2 text-sm">
                        <div className="w-6 h-6 rounded bg-green-100 flex items-center justify-center">
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2">
                            <path d="M21.3 8.7 8.7 21.3c-1 1-2.5 1-3.4 0l-2.6-2.6c-1-1-1-2.5 0-3.4L15.3 2.7c1-1 2.5-1 3.4 0l2.6 2.6c1 1 1 2.5 0 3.4Z"/>
                            <path d="m7.5 10.5 2 2"/>
                            <path d="m10.5 7.5 2 2"/>
                            <path d="m13.5 4.5 2 2"/>
                            <path d="m4.5 13.5 2 2"/>
                          </svg>
                        </div>
                        <span className="text-gray-600">
                          {linkedMeasurement.type === 'line' ? 'Distance' : 'Area'}
                        </span>
                        <span className="ml-auto font-medium text-green-600">
                          {linkedMeasurement.type === 'line'
                            ? `${(linkedMeasurement.distance * 1000).toFixed(0)}mm`
                            : `${linkedMeasurement.area.toFixed(2)}m²`
                          }
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Actions */}
                <div className="px-4 py-3 bg-gray-50 flex items-center justify-end gap-2">
                  {activeHotspot.linked360Image && (
                    <button
                      onClick={() => setPanoramaImage(activeHotspot.linked360Image!)}
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
                  <button
                    onClick={resetToInitialView}
                    className="px-4 py-2 bg-white hover:bg-gray-100 text-gray-700 text-sm font-medium rounded-lg transition flex items-center gap-2 border border-gray-200 shadow-sm"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                      <path d="M3 3v5h5"/>
                    </svg>
                    Reset View
                  </button>
                </div>
              </div>

              {/* Right Side - Image (Resizable) */}
              {hasImage && (
                <div
                  className="border-l border-gray-200 bg-gray-50 flex items-center justify-center p-3 relative"
                  style={{ width: `${hotspotImageSize}px`, minWidth: '150px', maxWidth: '600px' }}
                >
                  <img
                    src={activeHotspot.linkedImage}
                    alt={activeHotspot.name}
                    className="max-w-full object-contain rounded-lg shadow-sm cursor-pointer hover:opacity-90 transition-opacity"
                    style={{ maxHeight: `${hotspotImageSize * 0.75}px` }}
                    draggable={false}
                    onClick={() => setFullViewImage(activeHotspot.linkedImage || null)}
                    title="Click to view full size"
                  />
                  {/* Resize handle - top right corner */}
                  <div
                    className="absolute top-0 right-0 w-6 h-6 cursor-ne-resize flex items-center justify-center hover:bg-orange-100 rounded-bl transition-colors"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setIsResizingImage(true);
                      const startX = e.clientX;
                      const startSize = hotspotImageSize;

                      const handleMouseMove = (moveEvent: MouseEvent) => {
                        const deltaX = moveEvent.clientX - startX;
                        const newSize = Math.min(600, Math.max(150, startSize + deltaX));
                        setHotspotImageSize(newSize);
                      };

                      const handleMouseUp = () => {
                        setIsResizingImage(false);
                        document.removeEventListener('mousemove', handleMouseMove);
                        document.removeEventListener('mouseup', handleMouseUp);
                      };

                      document.addEventListener('mousemove', handleMouseMove);
                      document.addEventListener('mouseup', handleMouseUp);
                    }}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400">
                      <path d="M15 3h6v6"/>
                      <path d="M10 14 21 3"/>
                    </svg>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* Full View Image Modal */}
        {fullViewImage && (
          <div
            className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center cursor-zoom-out"
            onClick={() => setFullViewImage(null)}
          >
            <img
              src={fullViewImage}
              alt="Full view"
              className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              onClick={() => setFullViewImage(null)}
              className="absolute top-6 right-6 p-2 bg-white/10 hover:bg-white/20 text-white rounded-full transition-colors"
              title="Close"
            >
              <X size={24} />
            </button>
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-white/60 text-sm">
              Click anywhere to close
            </div>
          </div>
        )}

        {/* 360 Panorama Zoom-In Transition */}
        {panoramaTransition?.active && (
          <div
            className="fixed inset-0 z-[109] pointer-events-none"
            style={{ overflow: 'hidden' }}
          >
            {/* Circular expanding mask from click point */}
            <div
              style={{
                position: 'absolute',
                left: panoramaTransition.clickX,
                top: panoramaTransition.clickY,
                width: 0,
                height: 0,
                transform: 'translate(-50%, -50%)',
                borderRadius: '50%',
                background: 'black',
                animation: 'pano-zoom-in 900ms cubic-bezier(0.4, 0, 0.2, 1) forwards',
              }}
            />
            {/* Radial blur lines for speed effect */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: `radial-gradient(circle at ${panoramaTransition.clickX}px ${panoramaTransition.clickY}px, transparent 0%, transparent 20%, rgba(0,0,0,0.1) 40%, rgba(0,0,0,0.4) 100%)`,
                animation: 'pano-vignette 900ms cubic-bezier(0.4, 0, 0.2, 1) forwards',
              }}
            />
            <style>{`
              @keyframes pano-zoom-in {
                0% { width: 0px; height: 0px; opacity: 0; }
                15% { width: 60px; height: 60px; opacity: 0.6; }
                100% { width: 300vmax; height: 300vmax; opacity: 1; }
              }
              @keyframes pano-vignette {
                0% { opacity: 0; }
                50% { opacity: 1; }
                100% { opacity: 0; }
              }
            `}</style>
          </div>
        )}

        {/* 360 Panorama Viewer */}
        {panoramaImage && (
          <div className="fixed inset-0 z-[110] bg-black">
            <div
              ref={(containerEl) => {
                if (!containerEl || containerEl.dataset.initialized) return;
                containerEl.dataset.initialized = 'true';

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

                // Store cleanup on the element
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
                const container = document.querySelector('[data-initialized="true"]') as any;
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

        {/* Camera Frame Overlay */}
        {cameraFrameEnabled && (
          <div
            className="absolute inset-0 pointer-events-none z-40 flex items-center justify-center"
            style={{ padding: '20px' }}
          >
            {/* Semi-transparent overlay outside frame */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div
                className="relative border-2 border-dashed border-white shadow-lg cursor-pointer pointer-events-auto"
                style={{
                  aspectRatio: '16 / 9',
                  maxWidth: 'calc(100% - 40px)',
                  maxHeight: 'calc(100% - 40px)',
                  width: '100%',
                  boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.3)'
                }}
                onClick={handleCaptureImage}
                title="Click to capture"
              >
                {/* Corner markers */}
                <div className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-white" />
                <div className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-white" />
                <div className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-white" />
                <div className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-white" />

                {/* 16:9 label */}
                <div className="absolute top-2 left-2 bg-black/50 text-white text-[10px] px-1.5 py-0.5 rounded font-mono">
                  16:9
                </div>

                {/* Capture hint */}
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/50 text-white text-xs px-2 py-1 rounded flex items-center gap-1">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>
                    <circle cx="12" cy="13" r="3"/>
                  </svg>
                  Click to capture
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Compare Mode Divider Overlay - Snapshot-based split screen */}
        {compareMode && slides.length >= 2 && (
          <div
            className="absolute inset-0 z-30"
            style={{ pointerEvents: isDraggingDivider ? 'auto' : 'none' }}
            onMouseMove={isDraggingDivider ? (e) => {
              const container = e.currentTarget;
              const rect = container.getBoundingClientRect();
              const x = e.clientX - rect.left;
              const newPosition = Math.max(0.05, Math.min(0.95, x / rect.width));
              setComparePosition(newPosition);
            } : undefined}
            onMouseUp={() => setIsDraggingDivider(false)}
            onMouseLeave={() => setIsDraggingDivider(false)}
          >
            {/* Left snapshot - clipped to left side of divider */}
            {compareSnapshotsReady && compareLeftSnapshot && (
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  clipPath: `inset(0 ${(1 - comparePosition) * 100}% 0 0)`,
                }}
              >
                <img
                  src={compareLeftSnapshot}
                  alt="Slide Left"
                  className="w-full h-full object-cover"
                  draggable={false}
                />
              </div>
            )}

            {/* Right snapshot - clipped to right side of divider */}
            {compareSnapshotsReady && compareRightSnapshot && (
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  clipPath: `inset(0 0 0 ${comparePosition * 100}%)`,
                }}
              >
                <img
                  src={compareRightSnapshot}
                  alt="Slide Right"
                  className="w-full h-full object-cover"
                  draggable={false}
                />
              </div>
            )}

            {/* Loading indicator while capturing snapshots */}
            {!compareSnapshotsReady && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none">
                <div className="bg-white/90 px-4 py-2 rounded-lg shadow-lg flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm">Capturing slides...</span>
                </div>
              </div>
            )}

            {/* Draggable Divider Line */}
            <div
              className="absolute top-0 bottom-0 pointer-events-auto cursor-col-resize"
              style={{
                left: `calc(${comparePosition * 100}% - 16px)`,
                width: '32px',
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDraggingDivider(true);
              }}
            >
              {/* Visual Divider Line */}
              <div
                className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-1 bg-white shadow-lg"
                style={{
                  boxShadow: '0 0 10px rgba(0,0,0,0.5), 0 0 3px rgba(0,0,0,0.3)'
                }}
              />
              {/* Drag Handle */}
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-12 bg-white rounded-lg shadow-lg flex items-center justify-center border border-gray-200">
                <div className="flex gap-0.5">
                  <div className="w-0.5 h-6 bg-gray-400 rounded" />
                  <div className="w-0.5 h-6 bg-gray-400 rounded" />
                </div>
              </div>
            </div>

            {/* Slide Labels */}
            <div
              className="absolute top-4 bg-blue-600 text-white text-xs px-2 py-1 rounded pointer-events-none"
              style={{ left: `calc(${comparePosition * 50}%)`, transform: 'translateX(-50%)' }}
            >
              Slide {activeSlideIndex + 1}
            </div>
            <div
              className="absolute top-4 bg-blue-600 text-white text-xs px-2 py-1 rounded pointer-events-none"
              style={{ left: `calc(${comparePosition * 100}% + ${(1 - comparePosition) * 50}%)`, transform: 'translateX(-50%)' }}
            >
              Slide {Math.min(activeSlideIndex + 2, slides.length)}
            </div>

            {/* Refresh button to recapture snapshots */}
            <button
              className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-white/90 hover:bg-white text-gray-700 text-xs px-3 py-1.5 rounded-lg shadow-lg flex items-center gap-1.5 pointer-events-auto transition-colors"
              onClick={() => {
                setCompareSnapshotsReady(false);
                // Force re-capture by toggling compareMode briefly
                setCompareMode(false);
                setTimeout(() => setCompareMode(true), 50);
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                <path d="M16 21h5v-5"/>
              </svg>
              Refresh
            </button>
          </div>
        )}

        {models.length === 0 && !isPresentationMode && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center text-gray-400 bg-white/80 p-6 rounded-lg">
              <PlayCircle size={48} className="mx-auto mb-2 opacity-30" />
              <p>No models loaded</p>
            </div>
          </div>
        )}
        </div>
      </div>

      {/* Project Files Panel */}
      {projectFilesPanelOpen && (
        <ProjectFilesPanel
          projectFiles={projectFiles || []}
          onRemoveFile={onRemoveProjectFile}
          onClose={() => onCloseProjectFilesPanel?.()}
        />
      )}

      {/* Hidden PDF file input for share dialog */}
      <input ref={sharePdfInputRef} type="file" accept=".pdf" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f?.type === 'application/pdf') setSharePdf(f); e.target.value = ''; }} />

      {/* Share Presentation Dialog */}
      {showShareDialog && (
        <div className="fixed inset-0 bg-black/40 z-[200] flex items-center justify-center"
          onClick={() => setShowShareDialog(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
            onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                <Share2 size={20} className="text-blue-600" />
                Share Presentation
              </h2>
              <button onClick={() => setShowShareDialog(false)}
                className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
                <X size={20} />
              </button>
            </div>

            {/* Body */}
            {shareResultUrl ? (
              /* Success state */
              <div className="px-6 py-8 text-center space-y-4">
                <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto">
                  <CheckCircle size={24} className="text-green-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">Presentation Shared!</h3>
                  <p className="text-sm text-gray-500">Anyone with this link can view your presentation</p>
                </div>
                <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg p-3">
                  <input type="text" readOnly value={shareResultUrl}
                    className="flex-1 text-sm text-gray-700 bg-transparent outline-none select-all" />
                  <button onClick={() => { navigator.clipboard.writeText(shareResultUrl); }}
                    className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 flex items-center gap-1.5 shrink-0">
                    <Copy size={12} />
                    Copy
                  </button>
                </div>
              </div>
            ) : (
              /* Form state */
              <div className="px-6 py-5 space-y-5">
                {/* Name */}
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1.5">Name</label>
                  <input type="text" value={shareName} onChange={(e) => setShareName(e.target.value)}
                    placeholder="e.g. Client Presentation, Design Review..."
                    className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-gray-400" />
                </div>

                {/* Description */}
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                    Description <span className="font-normal text-gray-400">(optional)</span>
                  </label>
                  <textarea value={shareDescription} onChange={(e) => setShareDescription(e.target.value)}
                    rows={3} placeholder="Brief description of this presentation..."
                    className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-gray-400 resize-none" />
                </div>

                {/* PDF Upload */}
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                    PDF Attachment <span className="font-normal text-gray-400">(optional)</span>
                  </label>
                  {sharePdf ? (
                    <div className="flex items-center gap-2 px-3 py-2.5 bg-blue-50 border border-blue-200 rounded-lg text-sm">
                      <FileText size={14} className="text-blue-600 shrink-0" />
                      <span className="flex-1 truncate text-blue-800">{sharePdf.name}</span>
                      <span className="text-xs text-blue-500">{(sharePdf.size / 1024).toFixed(0)} KB</span>
                      <button onClick={() => setSharePdf(null)}
                        className="p-0.5 rounded hover:bg-blue-100 text-blue-400 hover:text-blue-600">
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className={`border-2 border-dashed rounded-xl p-5 text-center transition-colors cursor-pointer ${
                      sharePdfDragOver ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:border-gray-300 bg-gray-50'
                    }`}
                      onDragOver={(e) => { e.preventDefault(); setSharePdfDragOver(true); }}
                      onDragLeave={() => setSharePdfDragOver(false)}
                      onDrop={(e) => { e.preventDefault(); setSharePdfDragOver(false);
                        const file = e.dataTransfer.files[0];
                        if (file?.type === 'application/pdf') setSharePdf(file); }}
                      onClick={() => sharePdfInputRef.current?.click()}>
                      <Upload size={22} className={`mx-auto mb-2 ${sharePdfDragOver ? 'text-blue-500' : 'text-gray-400'}`} />
                      <p className="text-sm text-gray-600">
                        Drop PDF here or <span className="text-blue-600 font-medium">browse</span>
                      </p>
                      <p className="text-xs text-gray-400 mt-1">PDF files only</p>
                    </div>
                  )}
                </div>

                {/* Info box */}
                <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-3">
                  <p className="font-medium text-gray-700 mb-1">What will be shared:</p>
                  <ul className="space-y-0.5 list-disc list-inside">
                    <li>{slides.length} slide(s) with {models.filter(m => m.type === 'building' || m.type === 'environment').length} 3D model(s)</li>
                    <li>{slides.reduce((acc, s) => acc + s.hotspots.length, 0)} hotspot(s)</li>
                    {models.some(m => m.type === 'splat' || m.type === 'paired') && (
                      <li className="text-amber-600">Gaussian Splat models will not be included</li>
                    )}
                  </ul>
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex justify-end gap-3">
              {shareResultUrl ? (
                <button onClick={() => setShowShareDialog(false)}
                  className="px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm">
                  Done
                </button>
              ) : (
                <>
                  <button onClick={() => setShowShareDialog(false)}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors">
                    Cancel
                  </button>
                  <button onClick={handleSharePresentation}
                    disabled={!shareName.trim() || isSharing}
                    className={`px-5 py-2 text-sm font-medium text-white rounded-lg flex items-center gap-2 transition-colors ${
                      shareName.trim() && !isSharing ? 'bg-blue-600 hover:bg-blue-700 shadow-sm' : 'bg-gray-300 cursor-not-allowed'
                    }`}>
                    {isSharing ? <Loader2 size={16} className="animate-spin" /> : <Share2 size={16} />}
                    {isSharing ? 'Sharing...' : 'Share'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ===========================================
// TAB 1: DRAWING EDITOR
// ===========================================
function DrawingEditor({ onConversionComplete, onGenerateRef, onProcessingChange, projectFiles, onAddProjectFile, onRemoveProjectFile, projectFilesPanelOpen, onCloseProjectFilesPanel, onZoomControlRef, onSubTabChange }: {
  onConversionComplete: (data: any) => void;
  onGenerateRef?: (fn: () => void) => void;
  onProcessingChange?: (isProcessing: boolean) => void;
  projectFiles?: ProjectFile[];
  onAddProjectFile?: (file: Omit<ProjectFile, 'id' | 'createdAt'>) => ProjectFile;
  onRemoveProjectFile?: (id: string) => void;
  projectFilesPanelOpen?: boolean;
  onCloseProjectFilesPanel?: () => void;
  onZoomControlRef?: (controls: { zoom: number; zoomIn: () => void; zoomOut: () => void }) => void;
  onSubTabChange?: (subTab: 'grundriss' | 'elemente') => void;
}) {
  // Sub-tab state: 'grundriss' (floor plan) or 'elemente' (elements)
  const [drawingSubTab, setDrawingSubTab] = useState<'grundriss' | 'elemente'>('grundriss');

  // =============================================
  // ELEMENTE (3D Builder) STATE
  // =============================================
  type ElementeView = 'front' | 'right' | 'left' | 'back' | 'top';
  type ElementeShapeType = 'on' | 'off' | 'cut';

  interface ElementeShape {
    id: number;
    viewId: ElementeView;
    points: Point[];  // Polygon points
    shapeType: ElementeShapeType;
    colorIndex: number;  // For grouping same shapes across views (GROUP G)
    subIndex: number;    // For 'off'/'cut': cutter ID (K in off-G-K). 0 for 'on'
    closed: boolean;
  }

  const [elementeActiveView, setElementeActiveView] = useState<ElementeView>('front');
  const [elementeShapes, setElementeShapes] = useState<ElementeShape[]>([]);
  const [elementeCurrentShapeType, setElementeCurrentShapeType] = useState<ElementeShapeType>('on');
  const [elementeCurrentColorIndex, setElementeCurrentColorIndex] = useState(1);
  const [elementeCurrentSubIndex, setElementeCurrentSubIndex] = useState(1);  // For 'off'/'cut': cutter ID (K)
  const [elementeShowOverlay, setElementeShowOverlay] = useState(false);
  const [elementeOverlayOpacity, setElementeOverlayOpacity] = useState(0.3);
  const [elementeDrawingPoints, setElementeDrawingPoints] = useState<Point[]>([]);
  const [elementeIsDrawing, setElementeIsDrawing] = useState(false);
  const [elementeNextId, setElementeNextId] = useState(1);
  const [elementeSelectedId, setElementeSelectedId] = useState<number | null>(null);
  const [elementeZoom, setElementeZoom] = useState(0.5);
  const [elementeIsDragging, setElementeIsDragging] = useState(false);
  const [elementeDragStart, setElementeDragStart] = useState<Point | null>(null);
  const [elementeSnapEnabled, setElementeSnapEnabled] = useState(true);
  const elementeSvgRef = useRef<SVGSVGElement>(null);

  // Elemente scale and measurement settings
  // Canvas is 800x800 pixels, representing a configurable real-world size
  const [elementeCanvasSizeMM, setElementeCanvasSizeMM] = useState(4000); // Default: 4000mm (4 meters) per 800px
  const elementePixelsToMM = (px: number) => (px / 800) * elementeCanvasSizeMM;
  const elementeMMToPixels = (mm: number) => (mm / elementeCanvasSizeMM) * 800;

  // Format measurement for display
  const formatMeasurement = (mm: number) => {
    if (mm >= 1000) {
      return `${(mm / 1000).toFixed(2)}m`;
    } else if (mm >= 10) {
      return `${Math.round(mm)}mm`;
    } else {
      return `${mm.toFixed(1)}mm`;
    }
  };

  // Calculate distance between two points in mm
  const calculateDistanceMM = (p1: Point, p2: Point) => {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const distPx = Math.sqrt(dx * dx + dy * dy);
    return elementePixelsToMM(distPx);
  };

  // Calculate angle of a line segment
  const calculateAngle = (p1: Point, p2: Point) => {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const angleRad = Math.atan2(-dy, dx); // Negative dy because SVG Y is inverted
    let angleDeg = (angleRad * 180) / Math.PI;
    if (angleDeg < 0) angleDeg += 360;
    return angleDeg;
  };

  // Point-in-polygon test using ray casting algorithm
  const isPointInPolygon = (point: Point, polygon: Point[]): boolean => {
    let inside = false;
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y;
      const xj = polygon[j].x, yj = polygon[j].y;
      if (((yi > point.y) !== (yj > point.y)) &&
          (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  };

  // Snap point to existing shape edges and corners in the current view
  const ELEMENTE_SNAP_DISTANCE = 15; // pixels
  const getElementeSnappedPoint = (point: Point, excludeShapeId?: number): Point => {
    if (!elementeSnapEnabled) return point;

    const shapesInView = elementeShapes.filter(s => s.viewId === elementeActiveView && s.id !== excludeShapeId);
    let snappedPoint = { ...point };
    let bestDist = ELEMENTE_SNAP_DISTANCE;

    // Check corners first (higher priority)
    for (const shape of shapesInView) {
      for (const corner of shape.points) {
        const dist = Math.sqrt((point.x - corner.x) ** 2 + (point.y - corner.y) ** 2);
        if (dist < bestDist) {
          bestDist = dist;
          snappedPoint = { x: corner.x, y: corner.y };
        }
      }
    }

    // Check edges (project point onto edge and snap if close)
    for (const shape of shapesInView) {
      const pts = shape.points;
      for (let i = 0; i < pts.length; i++) {
        const p1 = pts[i];
        const p2 = pts[(i + 1) % pts.length];

        // Project point onto the line segment
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) continue;

        let t = ((point.x - p1.x) * dx + (point.y - p1.y) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t)); // Clamp to segment

        const projX = p1.x + t * dx;
        const projY = p1.y + t * dy;
        const dist = Math.sqrt((point.x - projX) ** 2 + (point.y - projY) ** 2);

        if (dist < bestDist) {
          bestDist = dist;
          snappedPoint = { x: projX, y: projY };
        }
      }
    }

    return snappedPoint;
  };

  // Marker colors for each view's borders
  // Side views have left/right markers, TOP view also has top/bottom markers for depth alignment
  const viewMarkers: Record<ElementeView, {
    left: string; right: string; leftLabel: string; rightLabel: string;
    top?: string; bottom?: string; topLabel?: string; bottomLabel?: string;
  }> = {
    front: { left: '#3B82F6', right: '#EF4444', leftLabel: 'Blue', rightLabel: 'Red' },      // Blue left, Red right
    right: { left: '#EF4444', right: '#22C55E', leftLabel: 'Red', rightLabel: 'Green' },     // Red left, Green right
    left: { left: '#EAB308', right: '#3B82F6', leftLabel: 'Yellow', rightLabel: 'Blue' },    // Yellow left, Blue right
    back: { left: '#22C55E', right: '#EAB308', leftLabel: 'Green', rightLabel: 'Yellow' },   // Green left, Yellow right
    top: {
      left: '#06B6D4', right: '#EC4899', leftLabel: 'Cyan', rightLabel: 'Pink',  // Cyan left, Pink right
      top: '#800080', bottom: '#FFA500', topLabel: 'Purple', bottomLabel: 'Orange'  // Purple top (front edge), Orange bottom (back edge)
    },
  };

  // Colors for shape types
  // 'on' shapes use dark greys per colorIndex (group)
  // 'off' shapes use unique red tones per (colorIndex, subIndex) pair
  // 'cut' shapes use unique purple tones per (colorIndex, subIndex) pair
  const getShapeColor = (shapeType: ElementeShapeType, colorIndex: number, subIndex: number = 0): string => {
    const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');

    if (shapeType === 'on') {
      // Dark greys for ON groups
      const base = 30;
      const step = 15;
      const value = Math.min(80, base + (colorIndex - 1) * step);
      return `#${toHex(value)}${toHex(value)}${toHex(value)}`;
    } else if (shapeType === 'off') {
      // Generate unique red tones for OFF (group, cutter)
      const baseR = 180;
      const baseGB = 60;
      const step = 15;
      const rValue = Math.max(100, Math.min(200, baseR - (colorIndex - 1) * step));
      const gbValue = Math.max(20, Math.min(80, baseGB - (subIndex - 1) * (step / 2)));
      return `#${toHex(rValue)}${toHex(gbValue)}${toHex(gbValue)}`;
    } else if (shapeType === 'cut') {
      // Generate unique purple tones for CUT (group, cutter)
      const baseB = 160;
      const baseR = 140;
      const baseG = 40;
      const step = 15;
      const rValue = Math.max(100, Math.min(180, baseR - (colorIndex - 1) * step));
      const bValue = Math.max(120, Math.min(200, baseB - (subIndex - 1) * step));
      return `#${toHex(rValue)}${toHex(baseG)}${toHex(bValue)}`;
    }
    return '#000000';  // Default
  };

  // Legacy shapeTypeColors for backwards compatibility (uses colorIndex 1)
  const shapeTypeColors: Record<ElementeShapeType, string> = {
    on: '#000000',   // Black for base/add
    off: getShapeColor('off', 1, 1),  // Red tone for subtract
    cut: getShapeColor('cut', 1, 1),  // Purple tone for cut
  };

  // Get shapes for a specific view
  const getShapesForView = (view: ElementeView) => elementeShapes.filter(s => s.viewId === view);

  // Check which views have content for a specific color index
  const getViewsWithColorIndex = (colorIndex: number) => {
    const views = new Set<ElementeView>();
    elementeShapes.forEach(s => {
      if (s.colorIndex === colorIndex) views.add(s.viewId);
    });
    return views;
  };

  // Get all used color indices
  const getUsedColorIndices = () => {
    const indices = new Set<number>();
    elementeShapes.forEach(s => indices.add(s.colorIndex));
    return Array.from(indices).sort((a, b) => a - b);
  };

  // Check if a color index appears on less than 2 views (warning condition)
  const getWarningColorIndices = () => {
    const colorCounts = new Map<number, Set<ElementeView>>();
    elementeShapes.forEach(s => {
      if (!colorCounts.has(s.colorIndex)) colorCounts.set(s.colorIndex, new Set());
      colorCounts.get(s.colorIndex)!.add(s.viewId);
    });
    const warnings: number[] = [];
    colorCounts.forEach((views, colorIndex) => {
      if (views.size < 2) warnings.push(colorIndex);
    });
    return warnings;
  };

  // Check if we can build (at least 2 views have shapes - top counts as a regular view for intersection)
  const canBuildElemente = () => {
    const viewsWithShapes = new Set<ElementeView>();
    elementeShapes.forEach(s => viewsWithShapes.add(s.viewId));
    return viewsWithShapes.size >= 2;
  };

  // State for Elemente build process
  const [elementeBuildStatus, setElementeBuildStatus] = useState<'idle' | 'building' | 'success' | 'error'>('idle');
  const [elementeBuildError, setElementeBuildError] = useState<string | null>(null);
  const [elementeBuildLogs, setElementeBuildLogs] = useState<string | null>(null);
  const [showElementeLogs, setShowElementeLogs] = useState(false);

  // Handle Elemente 3D build
  const handleElementeBuild = async () => {
    if (!canBuildElemente()) {
      setElementeBuildError('Need shapes on at least 2 views for 3D intersection');
      return;
    }

    setElementeBuildStatus('building');
    setElementeBuildError(null);
    setElementeBuildLogs(null);

    try {
      // Debug: log shapes being sent
      console.log('[Elemente Build] Sending shapes:', elementeShapes.map(s => ({
        id: s.id,
        viewId: s.viewId,
        shapeType: s.shapeType,
        pointCount: s.points.length
      })));

      const response = await fetch('http://localhost:8000/api/elemente-build', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          shapes: elementeShapes,
          canvasSizeMM: elementeCanvasSizeMM,
        }),
      });

      const result = await response.json();

      // Always store logs if available
      if (result.logs) {
        setElementeBuildLogs(result.logs);
      }

      if (result.success && result.glb) {
        // Convert base64 GLB to blob and create download/view
        const glbData = atob(result.glb);
        const glbArray = new Uint8Array(glbData.length);
        for (let i = 0; i < glbData.length; i++) {
          glbArray[i] = glbData.charCodeAt(i);
        }
        const blob = new Blob([glbArray], { type: 'model/gltf-binary' });
        const url = URL.createObjectURL(blob);

        // Add GLB to project files
        if (onAddProjectFile) {
          onAddProjectFile({
            name: 'Elemente_Model.glb',
            type: 'glb',
            url: url,
            blob: blob,
            source: 'elemente',
          });
        }

        // Add IFC to project files if available
        if (result.ifc && onAddProjectFile) {
          const ifcData = atob(result.ifc);
          const ifcArray = new Uint8Array(ifcData.length);
          for (let i = 0; i < ifcData.length; i++) {
            ifcArray[i] = ifcData.charCodeAt(i);
          }
          const ifcBlob = new Blob([ifcArray], { type: 'application/x-step' });
          const ifcUrl = URL.createObjectURL(ifcBlob);

          onAddProjectFile({
            name: 'Elemente_Model.ifc',
            type: 'ifc',
            url: ifcUrl,
            blob: ifcBlob,
            source: 'elemente',
          });
        }

        setElementeBuildStatus('success');
        setTimeout(() => setElementeBuildStatus('idle'), 3000);
      } else {
        setElementeBuildStatus('error');
        setElementeBuildError(result.error || 'Build failed');
        setShowElementeLogs(true); // Auto-show logs on error
      }
    } catch (err: any) {
      setElementeBuildStatus('error');
      setElementeBuildError(err.message || 'Connection failed. Is the Python server running?');
    }
  };

  // =============================================
  // GRUNDRISS STATE (existing)
  // =============================================
  const [elements, setElements] = useState<ArchitecturalElement[]>([]);
  const [history, setHistory] = useState<ArchitecturalElement[][]>([[]]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [currentTool, setCurrentTool] = useState<ToolType>(ToolType.WALL);
  const [paperSize, setPaperSize] = useState<"A4" | "A3">("A4");
  const [pixelsPerMeter, setPixelsPerMeter] = useState(100); 
  const [fontSize, setFontSize] = useState(12);
  const [showDimensions, setShowDimensions] = useState(true); 
  const [measureMode, setMeasureMode] = useState<MeasureMode>(MeasureMode.CENTER); 
  const [config, setConfig] = useState({ wallHeight: 250, wallThickness: 20, wallJustification: WallJustification.CENTER, windowType: WindowType.SINGLE, sillHeight: 90, windowHeight: 120, doorType: DoorType.SINGLE_SWING, doorHeight: 210 });
  const [isDragging, setIsDragging] = useState(false);
  const [resizeMode, setResizeMode] = useState<'START' | 'END' | null>(null);
  const [hoveredWall, setHoveredWall] = useState<Wall | null>(null); 
  const [bgImage, setBgImage] = useState<string | null>(null);
  const [bgOpacity, setBgOpacity] = useState(0.5);
  const [bgDims, setBgDims] = useState<{w:number, h:number} | null>(null);
  const [bgOffset, setBgOffset] = useState<Point>({x: 0, y: 0});
  const [bgScale, setBgScale] = useState(1); // Scale factor for trace image (1 = original size)
  const [isTraceMoving, setIsTraceMoving] = useState(false);
  const [traceSnapEnabled, setTraceSnapEnabled] = useState(false);
  const [traceCorners, setTraceCorners] = useState<Point[]>([]); // User-marked corners on trace
  const [isMarkingCorners, setIsMarkingCorners] = useState(false); // Mode for marking corners

  // DXF conversion state
  const [isDxfConverting, setIsDxfConverting] = useState(false);

  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [currentMousePos, setCurrentMousePos] = useState<Point | null>(null);
  const [penStartPoint, setPenStartPoint] = useState<Point | null>(null); 
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [nextId, setNextId] = useState(1);
  const [snapActive, setSnapActive] = useState(true);
  const [isShiftHeld, setIsShiftHeld] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [zoom, setZoom] = useState(0.4);
  const svgRef = useRef<SVGSVGElement>(null);

  // Report zoom controls and sub-tab to parent
  useEffect(() => {
    if (onZoomControlRef) {
      onZoomControlRef({
        zoom: drawingSubTab === 'elemente' ? elementeZoom : zoom,
        zoomIn: () => drawingSubTab === 'elemente'
          ? setElementeZoom(z => Math.min(2, z + 0.1))
          : setZoom(z => Math.min(1.5, z + 0.1)),
        zoomOut: () => drawingSubTab === 'elemente'
          ? setElementeZoom(z => Math.max(0.3, z - 0.1))
          : setZoom(z => Math.max(0.2, z - 0.1))
      });
    }
  }, [elementeZoom, zoom, drawingSubTab, onZoomControlRef]);

  useEffect(() => {
    if (onSubTabChange) {
      onSubTabChange(drawingSubTab);
    }
  }, [drawingSubTab, onSubTabChange]);

  // Move selected element by arrow keys (10mm normal, 100mm with shift)
  const moveSelectedElement = (dx: number, dy: number) => {
    if (selectedId === null || drawingSubTab !== 'grundriss') return;
    const el = elements.find(e => e.id === selectedId);
    if (!el) return;

    const newElements = elements.map(e => {
      if (e.id === selectedId) {
        const newEl = Object.assign(Object.create(Object.getPrototypeOf(e)), e);
        newEl.start = { x: e.start.x + dx, y: e.start.y + dy };
        newEl.end = { x: e.end.x + dx, y: e.end.y + dy };
        return newEl;
      }
      return e;
    });
    addToHistory(newElements);
  };

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      setIsShiftHeld(e.shiftKey);
      if (e.key === 'Escape') {
        if (currentTool === ToolType.PEN) { setPenStartPoint(null); setStartPoint(null); }
        setSelectedId(null); setResizeMode(null); setStartPoint(null); setIsTraceMoving(false);
      }
      if (e.key === 'Delete' || e.key === 'Backspace') handleDelete();
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z') { e.shiftKey ? handleRedo() : handleUndo(); e.preventDefault(); }
        else if (e.key === 'y') { handleRedo(); e.preventDefault(); }
      }
      // Arrow key movement for selected elements (10mm = 1px normal, 100mm = 10px with shift)
      if (selectedId !== null && drawingSubTab === 'grundriss') {
        const step = e.shiftKey ? 10 : 1; // 10px = 100mm, 1px = 10mm
        if (e.key === 'ArrowUp') { moveSelectedElement(0, -step); e.preventDefault(); }
        else if (e.key === 'ArrowDown') { moveSelectedElement(0, step); e.preventDefault(); }
        else if (e.key === 'ArrowLeft') { moveSelectedElement(-step, 0); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { moveSelectedElement(step, 0); e.preventDefault(); }
      }
    };
    window.addEventListener('keydown', handleKey); window.addEventListener('keyup', handleKey);
    return () => { window.removeEventListener('keydown', handleKey); window.removeEventListener('keyup', handleKey); };
  }, [currentTool, selectedId, history, historyIndex, elements, drawingSubTab]); 

  // --- HELPER FUNCTION ADDED HERE TO FIX CRASH ---
  const getWallForElement = (el: ArchitecturalElement): Wall | null => {
    let closestWall = null;
    let minDist = 100; 
    elements.forEach(w => {
      if (w instanceof Wall) {
        const dist = getDistance(projectPointOnLine(el.start, w.start, w.end), el.start);
        if (dist < minDist) {
          minDist = dist;
          closestWall = w;
        }
      }
    });
    return closestWall;
  };
  // ------------------------------------------------

  const addToHistory = (newElements: ArchitecturalElement[]) => {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newElements);
    setHistory(newHistory); setHistoryIndex(newHistory.length - 1); setElements(newElements);
  };
  const handleUndo = () => { if (historyIndex > 0) { const prevIndex = historyIndex - 1; setHistoryIndex(prevIndex); setElements(history[prevIndex]); setSelectedId(null); setPenStartPoint(null); } };
  const handleRedo = () => { if (historyIndex < history.length - 1) { const nextIndex = historyIndex + 1; setHistoryIndex(nextIndex); setElements(history[nextIndex]); setSelectedId(null); } };
  const handleDelete = () => { if (selectedId !== null) { const newEls = elements.filter(el => el.id !== selectedId); addToHistory(newEls); setSelectedId(null); } };
  const handleUpdateElement = () => {
    if (selectedId === null) return;
    const newEls = elements.map(el => { if (el.id === selectedId) { return ElementFactory.create(el.type, { id: el.id, start: el.start, end: el.end }, config); } return el; });
    addToHistory(newEls); setSaveSuccess(true); setTimeout(() => setSaveSuccess(false), 2000);
  };
  const handleGenerate3D = async () => {
    if (!svgRef.current) return;
    setIsProcessing(true);
    onProcessingChange?.(true);
    try {
        const clone = svgRef.current.cloneNode(true) as SVGSVGElement;
        clone.querySelectorAll('[data-export-ignore="true"]').forEach(el => el.remove());
        const contentGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
        contentGroup.setAttribute("transform", "scale(0.1)");
        while (clone.firstChild) { contentGroup.appendChild(clone.firstChild); }
        clone.appendChild(contentGroup);
        const w = SIZES[paperSize].w * 0.1; const h = SIZES[paperSize].h * 0.1;
        clone.setAttribute("width", `${w}mm`); clone.setAttribute("height", `${h}mm`); clone.setAttribute("viewBox", `0 0 ${w} ${h}`);
        const serializer = new XMLSerializer();
        const svgString = serializer.serializeToString(clone);
        const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
        const formData = new FormData();
        formData.append("file", blob, "plan.svg"); formData.append("name", "my_design");
        const response = await fetch('/api/convert', { method: 'POST', body: formData });
        const result = await response.json();
        if (result.success) { onConversionComplete(result); } else { alert("Error generating 3D model: " + (result.error || "Unknown error")); }
    } catch (e) { alert("Network or Server Error"); console.error(e); } finally { setIsProcessing(false); onProcessingChange?.(false); }
  };

  // Register generate function for header button
  useEffect(() => {
    if (onGenerateRef) {
      onGenerateRef(handleGenerate3D);
    }
  }, [onGenerateRef]);

  const handleTraceUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return; const url = URL.createObjectURL(f); const img = new Image();
    img.onload = () => { setBgDims({ w: img.naturalWidth, h: img.naturalHeight }); setBgOffset({ x: 0, y: 0 }); setBgScale(1); setBgImage(url); }; img.src = url;
  };
  const removeTrace = () => { setBgImage(null); setBgDims(null); setBgOffset({ x: 0, y: 0 }); setBgScale(1); setTraceCorners([]); setTraceSnapEnabled(false); setIsMarkingCorners(false); };

  // DXF Upload and Parsing
  // DXF Upload - first fetches layouts, then converts selected layout to SVG
  // Simple DXF upload - converts to SVG with snap corners
  const handleDxfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsDxfConverting(true);
    try {
      const formData = new FormData();
      formData.append('file', file);

      let response: Response;
      try {
        response = await fetch('http://localhost:8000/api/convert-dxf', {
          method: 'POST',
          body: formData,
        });
      } catch (fetchError) {
        // Network error - server likely not running
        throw new Error('DXF conversion server not available. Please start the Python backend server:\n\ncd python/stacker && python main.py');
      }

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to convert DXF');
      }

      const result = await response.json();
      console.log(`DXF converted: ${result.lineCount} lines, ${result.cornerCount} corners, size: ${result.width}x${result.height}m`);

      // Scale DXF dimensions from meters to pixels (DXF coordinates are in real-world units)
      const scaledWidth = result.width * pixelsPerMeter;
      const scaledHeight = result.height * pixelsPerMeter;

      // Scale corners from DXF units (meters) to pixels
      const scaledCorners = result.corners.map((c: {x: number, y: number}) => ({
        x: c.x * pixelsPerMeter,
        y: c.y * pixelsPerMeter
      }));

      // Set the SVG as trace background with scaled dimensions
      setBgImage(result.svg);
      setBgDims({ w: scaledWidth, h: scaledHeight });
      setBgOffset({ x: 100, y: 100 });
      setBgOpacity(0.7);

      // Set corners as trace corners (auto-extracted from DXF, scaled to pixels)
      setTraceCorners(scaledCorners);
      setTraceSnapEnabled(true);

    } catch (err) {
      console.error('Error converting DXF:', err);
      alert(err instanceof Error ? err.message : 'Error converting DXF file');
    } finally {
      setIsDxfConverting(false);
    }
  };

  const handleLengthChange = (newLengthMeters: number) => {
    if (selectedId === null) return;
    const newEls = elements.map(el => { if (el.id === selectedId) { const newEnd = resizeElement(el.start, el.end, newLengthMeters, pixelsPerMeter); return ElementFactory.create(el.type, { id: el.id, start: el.start, end: newEnd }, config); } return el; });
    setElements(newEls);
  };
  const handleSelect = (el: ArchitecturalElement) => {
    setSelectedId(el.id);
    if (el instanceof Wall) { setConfig(prev => ({ ...prev, wallHeight: el.height, wallThickness: el.thickness, wallJustification: el.justification })); } 
    else if (el instanceof WindowElement) { setConfig(prev => ({ ...prev, windowType: el.windowType, sillHeight: el.sillHeight, windowHeight: el.windowHeight })); } 
    else if (el instanceof Door) { setConfig(prev => ({ ...prev, doorType: el.doorType, doorHeight: el.height })); }
  };
  const getSmartCoordinates = (rawX: number, rawY: number): Point => {
    let finalPoint = { x: rawX, y: rawY };
    const anchor = (currentTool === ToolType.PEN && penStartPoint) ? penStartPoint : startPoint;
    if (isShiftHeld && anchor && (isDragging || currentTool === ToolType.PEN || resizeMode)) { const dx = Math.abs(rawX - anchor.x); const dy = Math.abs(rawY - anchor.y); dx > dy ? (finalPoint.y = anchor.y) : (finalPoint.x = anchor.x); }
    if (currentTool === ToolType.LASER && !isDragging) { let bestDist = 20; elements.forEach(el => { el.corners.forEach((_,i) => { const p1 = el.corners[i]; const p2 = el.corners[(i + 1) % 4]; const proj = projectPointOnLine(finalPoint, p1, p2); const d = getDistance(finalPoint, proj); if (d < bestDist) { bestDist = d; finalPoint = proj; } }); }); return finalPoint; }
    if ((currentTool === ToolType.WINDOW || currentTool === ToolType.DOOR) && !isDragging && !resizeMode) { let minDist = 30; let foundWall = null; elements.forEach(el => { if (el instanceof Wall) { const projected = projectPointOnLine(finalPoint, el.start, el.end); const d = getDistance(finalPoint, projected); if (d < minDist) { minDist = d; finalPoint = projected; foundWall = el; } } }); if (foundWall !== hoveredWall) setHoveredWall(foundWall); return finalPoint; }

    // Snap to trace corners if enabled (includes DXF-extracted corners)
    if (traceSnapEnabled && traceCorners.length > 0 && currentTool !== ToolType.LASER) {
      let bestTraceDist = 10; // Snap threshold for trace corners (10px as requested)
      traceCorners.forEach(corner => {
        // Adjust corner position by scale and bgOffset since corners are stored relative to trace
        const adjustedCorner = { x: corner.x * bgScale + bgOffset.x, y: corner.y * bgScale + bgOffset.y };
        const dist = getDistance(finalPoint, adjustedCorner);
        if (dist < bestTraceDist) {
          bestTraceDist = dist;
          finalPoint = adjustedCorner;
        }
      });
      // Also snap to edges between consecutive corners
      if (traceCorners.length >= 2) {
        for (let i = 0; i < traceCorners.length; i++) {
          const p1 = { x: traceCorners[i].x * bgScale + bgOffset.x, y: traceCorners[i].y * bgScale + bgOffset.y };
          const p2 = { x: traceCorners[(i + 1) % traceCorners.length].x * bgScale + bgOffset.x, y: traceCorners[(i + 1) % traceCorners.length].y * bgScale + bgOffset.y };
          const projected = projectPointOnLine(finalPoint, p1, p2);
          // Check if projected point is within the line segment
          const segLen = getDistance(p1, p2);
          const d1 = getDistance(p1, projected);
          const d2 = getDistance(p2, projected);
          if (d1 <= segLen && d2 <= segLen) {
            const dist = getDistance(finalPoint, projected);
            if (dist < bestTraceDist) {
              bestTraceDist = dist;
              finalPoint = projected;
            }
          }
        }
      }
    }

    if (snapActive && currentTool !== ToolType.LASER) { let bestDist = 20; elements.forEach(el => { if (el.id === selectedId && resizeMode) return; [el.start, el.end].forEach(pt => { const dist = getDistance(finalPoint, pt); if (dist < bestDist) { bestDist = dist; finalPoint = pt; } }); el.corners.forEach(corner => { const dist = getDistance(finalPoint, corner); if (dist < bestDist) { bestDist = dist; finalPoint = corner; } }); }); }
    return finalPoint;
  };
  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // Scale mouse position from screen coords to SVG viewBox coords
    const scaleX = SIZES[paperSize].w / rect.width;
    const scaleY = SIZES[paperSize].h / rect.height;
    const rawX = (e.clientX - rect.left) * scaleX;
    const rawY = (e.clientY - rect.top) * scaleY;
    const smartPoint = getSmartCoordinates(rawX, rawY);
    if (isTraceMoving && bgImage) { setIsDragging(true); setStartPoint({x: rawX, y: rawY}); return; }
    // Handle corner marking mode for trace snapping
    if (isMarkingCorners && bgImage) {
      // Store corner position relative to trace image (subtract bgOffset and divide by scale)
      // This stores corners in original image coordinates
      const cornerRelative = { x: (rawX - bgOffset.x) / bgScale, y: (rawY - bgOffset.y) / bgScale };
      setTraceCorners(prev => [...prev, cornerRelative]);
      return;
    }
    if (currentTool === ToolType.SELECT) { if (selectedId !== null) { const el = elements.find(e => e.id === selectedId); if (el) { if (getDistance({x: rawX, y: rawY}, el.start) < 15) { setResizeMode('START'); setIsDragging(true); setStartPoint(el.end); return; } if (getDistance({x: rawX, y: rawY}, el.end) < 15) { setResizeMode('END'); setIsDragging(true); setStartPoint(el.start); return; } } } const hits = elements.filter(el => getDistance(smartPoint, projectPointOnLine(smartPoint, el.start, el.end)) < el.thickness + 5); hits.sort((a, b) => (a instanceof Wall ? 1 : 0) - (b instanceof Wall ? 1 : 0)); if (hits.length > 0) { handleSelect(hits[0]); setIsDragging(true); setStartPoint(smartPoint); setCurrentMousePos(smartPoint); } else { setSelectedId(null); } } 
    else if (currentTool === ToolType.PEN) { if (!penStartPoint) { setPenStartPoint(smartPoint); setStartPoint(smartPoint); } else { if (getDistance(penStartPoint, smartPoint) > 5) { const newElement = ElementFactory.create(ToolType.WALL, { id: nextId, start: penStartPoint, end: smartPoint }, config); addToHistory([...elements, newElement]); setNextId(prev => prev + 1); setPenStartPoint(smartPoint); setStartPoint(smartPoint); } } } else { setIsDragging(true); setStartPoint(smartPoint); setCurrentMousePos(smartPoint); setSelectedId(null); }
  };
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // Scale mouse position from screen coords to SVG viewBox coords
    const scaleX = SIZES[paperSize].w / rect.width;
    const scaleY = SIZES[paperSize].h / rect.height;
    const rawX = (e.clientX - rect.left) * scaleX;
    const rawY = (e.clientY - rect.top) * scaleY;
    const smartPoint = getSmartCoordinates(rawX, rawY); setCurrentMousePos(smartPoint);
    if (isDragging) {
      if (isTraceMoving && bgImage && startPoint) { const dx = rawX - startPoint.x; const dy = rawY - startPoint.y; setBgOffset(prev => ({ x: prev.x + dx, y: prev.y + dy })); setStartPoint({x: rawX, y: rawY}); return; }
      if (resizeMode && selectedId !== null) { setElements(prev => prev.map(el => { if (el.id === selectedId) { const newEl = Object.assign(Object.create(Object.getPrototypeOf(el)), el); if (resizeMode === 'START') newEl.start = smartPoint; else newEl.end = smartPoint; return newEl; } return el; })); }
      else if (currentTool === ToolType.SELECT && selectedId && startPoint) { const dx = smartPoint.x - startPoint.x; const dy = smartPoint.y - startPoint.y; setElements(prev => prev.map(el => { if (el.id === selectedId) { const newEl = Object.assign(Object.create(Object.getPrototypeOf(el)), el); newEl.start = { x: el.start.x + dx, y: el.start.y + dy }; newEl.end = { x: el.end.x + dx, y: el.end.y + dy }; return newEl; } return el; })); setStartPoint(smartPoint); }
    }
  };
  const handleMouseUp = () => {
    if (currentTool === ToolType.PEN) return;
    if (isDragging) { if (resizeMode || (currentTool === ToolType.SELECT && selectedId !== null)) addToHistory(elements); else if (currentTool !== ToolType.LASER && !isTraceMoving && startPoint && currentMousePos && getDistance(startPoint, currentMousePos) > 5) { const newElement = ElementFactory.create(currentTool, { id: nextId, start: startPoint, end: currentMousePos }, config); addToHistory([...elements, newElement]); setNextId(prev => prev + 1); setSelectedId(nextId); } }
    setIsDragging(false); setStartPoint(null); setCurrentMousePos(null); setResizeMode(null);
  };
  const renderElement = (el: ArchitecturalElement, isGhost = false) => {
    const polyPoints = generateRectPolygon(el.start, el.end, el.thickness, el instanceof Wall ? el.justification : undefined);
    const isSelected = el.id === selectedId; let fill = isSelected ? '#334155' : '#000000'; if (el instanceof WindowElement) fill = '#ef4444'; if (el instanceof Door) fill = '#808080'; if (isGhost) fill = 'rgba(0,0,0,0.3)';
    const midX = (el.start.x + el.end.x) / 2; const midY = (el.start.y + el.end.y) / 2;
    let displayLength = "0.00"; if (el instanceof Wall) { displayLength = getVisualWallLength(el, elements, measureMode); } else { displayLength = (el.length / PIXELS_PER_METER).toFixed(2); }
    const uniqueId = el.generateUniqueID();
    // Show measurement for: non-ghost elements, dragging previews, OR pen tool preview
    const showMeasurement = !isGhost || isDragging || (currentTool === ToolType.PEN && penStartPoint);
    return ( <g key={isGhost ? 'ghost' : el.id} style={{ cursor: 'pointer' }}> <title>{uniqueId}</title> <polygon id={isGhost ? undefined : uniqueId} points={polyPoints} fill={fill} stroke={isSelected ? '#3b82f6' : 'none'} strokeWidth={isSelected ? 2 : 0} /> {showMeasurement && ( <text x={midX} y={midY - 10} fontSize={fontSize} fill="black" stroke="white" strokeWidth="3" paintOrder="stroke" textAnchor="middle" pointerEvents="none" fontWeight="bold" data-export-ignore="true"> {displayLength}m </text> )} {!isGhost && isSelected && currentTool === ToolType.SELECT && ( <g data-export-ignore="true"> <rect x={el.start.x - 6} y={el.start.y - 6} width="12" height="12" fill="#3b82f6" stroke="white" strokeWidth="2" className="cursor-crosshair"/> <rect x={el.end.x - 6} y={el.end.y - 6} width="12" height="12" fill="#3b82f6" stroke="white" strokeWidth="2" className="cursor-crosshair"/> </g> )} </g> );
  };
  const getSelectedLength = () => { const el = elements.find(e => e.id === selectedId); if (!el) return "0.00"; if (el instanceof Wall) return getVisualWallLength(el, elements, measureMode); return (el.length / PIXELS_PER_METER).toFixed(2); };
  const getLaserInfo = () => { if (currentTool === ToolType.LASER && isDragging && startPoint && currentMousePos) { const d = getDistance(startPoint, currentMousePos); return (d / pixelsPerMeter).toFixed(2); } return null; };

  return (
    <div className="flex h-full w-full bg-gray-50 text-gray-900 font-sans">
      <aside className="w-80 bg-white border-r border-gray-200 p-6 flex flex-col gap-6 overflow-y-auto z-10 shadow-xl shrink-0">
        {/* Sub-tab toggle in sidebar header (replacing Editor) */}
        <nav className="flex items-center gap-1 bg-gray-100 p-1 rounded-lg w-full">
          <button
            onClick={() => setDrawingSubTab('grundriss')}
            className={`flex-1 py-2 rounded-md text-sm font-medium transition-all flex items-center justify-center gap-1.5 ${
              drawingSubTab === 'grundriss'
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
            }`}
          >
            <PenLine size={14}/>
            Grundriss
          </button>
          <button
            onClick={() => setDrawingSubTab('elemente')}
            className={`flex-1 py-2 rounded-md text-sm font-medium transition-all flex items-center justify-center gap-1.5 ${
              drawingSubTab === 'elemente'
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
            }`}
          >
            <Box size={14}/>
            Elemente
          </button>
        </nav>

        {/* Elemente tab - 3D Builder sidebar */}
        {drawingSubTab === 'elemente' && (
          <>
            {/* View Selector */}
            <div className="bg-slate-100 p-3 rounded mb-4">
              <label className="text-[10px] font-bold text-gray-500 uppercase mb-2 block">Active View</label>
              {/* Side views - 2x2 grid */}
              <div className="grid grid-cols-2 gap-2 mb-2">
                {(['front', 'back', 'left', 'right'] as ElementeView[]).map(view => {
                  const hasShapes = getShapesForView(view).length > 0;
                  const markers = viewMarkers[view];
                  return (
                    <button
                      key={view}
                      onClick={() => setElementeActiveView(view)}
                      className={`relative p-3 rounded-lg border-2 transition-all text-sm font-medium capitalize ${
                        elementeActiveView === view
                          ? 'bg-white border-blue-500 text-blue-700 shadow-sm'
                          : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      {/* Marker color indicators */}
                      <div className="absolute left-1 top-1 bottom-1 w-1 rounded-full" style={{ backgroundColor: markers.left }} />
                      <div className="absolute right-1 top-1 bottom-1 w-1 rounded-full" style={{ backgroundColor: markers.right }} />
                      {view}
                      {hasShapes && (
                        <span className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-white" />
                      )}
                    </button>
                  );
                })}
              </div>
              {/* Top view - full width button */}
              <button
                onClick={() => setElementeActiveView('top')}
                className={`relative w-full p-3 rounded-lg border-2 transition-all text-sm font-medium capitalize ${
                  elementeActiveView === 'top'
                    ? 'bg-gradient-to-r from-cyan-50 to-pink-50 border-cyan-500 text-cyan-700 shadow-sm'
                    : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
              >
                {/* Marker color indicators */}
                <div className="absolute left-1 top-1 bottom-1 w-1 rounded-full" style={{ backgroundColor: viewMarkers.top.left }} />
                <div className="absolute right-1 top-1 bottom-1 w-1 rounded-full" style={{ backgroundColor: viewMarkers.top.right }} />
                🏠 Top
                {getShapesForView('top').length > 0 && (
                  <span className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-white" />
                )}
              </button>
              <div className="mt-2 text-[9px] text-gray-400 text-center">
                Markers: <span style={{ color: viewMarkers[elementeActiveView].left }}>{viewMarkers[elementeActiveView].leftLabel}</span> (left) • <span style={{ color: viewMarkers[elementeActiveView].right }}>{viewMarkers[elementeActiveView].rightLabel}</span> (right)
                {elementeActiveView === 'top' && viewMarkers.top.top && viewMarkers.top.bottom && (
                  <><br/><span style={{ color: viewMarkers.top.top }}>{viewMarkers.top.topLabel}</span> (front) • <span style={{ color: viewMarkers.top.bottom }}>{viewMarkers.top.bottomLabel}</span> (back)</>
                )}
              </div>
            </div>

            {/* Overlay Controls */}
            <div className="bg-amber-50 border border-amber-200 p-3 rounded mb-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-amber-700 flex items-center gap-1">
                  <Eye size={12}/> View Overlay
                </span>
                <button
                  onClick={() => setElementeShowOverlay(!elementeShowOverlay)}
                  className={`text-xs px-2 py-1 rounded ${elementeShowOverlay ? 'bg-amber-500 text-white' : 'bg-white border'}`}
                >
                  {elementeShowOverlay ? 'ON' : 'OFF'}
                </button>
              </div>
              {elementeShowOverlay && (
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-amber-600">Opacity</span>
                  <input
                    type="range"
                    min="0.1"
                    max="0.7"
                    step="0.1"
                    value={elementeOverlayOpacity}
                    onChange={e => setElementeOverlayOpacity(parseFloat(e.target.value))}
                    className="flex-1 h-1"
                  />
                  <span className="text-[10px] text-amber-600 w-8">{Math.round(elementeOverlayOpacity * 100)}%</span>
                </div>
              )}
              <p className="text-[9px] text-amber-600 mt-1">Show other views to align shapes</p>
            </div>

            {/* Shape Type Selector */}
            <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 mb-4">
              <label className="text-[10px] font-bold text-gray-500 uppercase mb-2 block">Shape Type</label>
              <div className="flex gap-1 mb-3">
                {(['on', 'off', 'cut'] as ElementeShapeType[]).map(type => (
                  <button
                    key={type}
                    onClick={() => setElementeCurrentShapeType(type)}
                    className={`flex-1 py-2 rounded text-xs font-medium transition-all uppercase ${
                      elementeCurrentShapeType === type
                        ? type === 'on' ? 'bg-gray-900 text-white' :
                          type === 'off' ? 'bg-red-600 text-white' :
                          'bg-purple-600 text-white'
                        : 'bg-white border text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    {type === 'on' ? 'Add' : type === 'off' ? 'Off' : 'Cut'}
                  </button>
                ))}
              </div>

              {/* Group (colorIndex) - which ON group this belongs to */}
              <label className="text-[10px] font-bold text-gray-500 uppercase mb-1 block">
                {elementeCurrentShapeType === 'on' ? 'Group ID' : 'Target ON Group'}
              </label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setElementeCurrentColorIndex(Math.max(1, elementeCurrentColorIndex - 1))}
                  className="p-1 bg-white border rounded hover:bg-gray-50"
                >
                  -
                </button>
                <div className="flex-1 text-center py-1 bg-white border rounded font-mono text-sm">
                  {elementeCurrentShapeType === 'on'
                    ? `ON-${elementeCurrentColorIndex}`
                    : `${elementeCurrentShapeType.toUpperCase()}-${elementeCurrentColorIndex}-${elementeCurrentSubIndex}`}
                </div>
                <button
                  onClick={() => setElementeCurrentColorIndex(elementeCurrentColorIndex + 1)}
                  className="p-1 bg-white border rounded hover:bg-gray-50"
                >
                  +
                </button>
              </div>

              {/* Cutter ID - show for 'off' and 'cut' types (v6.5.0 naming) */}
              {(elementeCurrentShapeType === 'off' || elementeCurrentShapeType === 'cut') && (
                <div className="mt-2">
                  <label className="text-[10px] font-bold text-gray-500 uppercase mb-1 block">Cutter ID</label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setElementeCurrentSubIndex(Math.max(1, elementeCurrentSubIndex - 1))}
                      className="p-1 bg-white border rounded hover:bg-gray-50"
                    >
                      -
                    </button>
                    <div className="flex-1 text-center py-1 bg-white border rounded font-mono text-sm">
                      Cutter {elementeCurrentSubIndex}
                    </div>
                    <button
                      onClick={() => setElementeCurrentSubIndex(elementeCurrentSubIndex + 1)}
                      className="p-1 bg-white border rounded hover:bg-gray-50"
                    >
                      +
                    </button>
                  </div>
                  <p className="text-[9px] text-red-600 mt-1">
                    {elementeCurrentShapeType.toUpperCase()}-{elementeCurrentColorIndex}-{elementeCurrentSubIndex} will subtract from ON-{elementeCurrentColorIndex}
                  </p>
                </div>
              )}

              <p className="text-[9px] text-gray-400 mt-1">Same ID shapes will intersect in 3D</p>
            </div>

            {/* Drawing Tools */}
            <div className="space-y-2 mb-4">
              <label className="text-[10px] font-bold text-gray-500 uppercase block">Tools</label>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setElementeIsDrawing(false);
                    setElementeDrawingPoints([]);
                    setElementeSelectedId(null);
                  }}
                  className={`flex-1 flex flex-col items-center p-3 rounded-lg border transition-colors ${
                    !elementeIsDrawing && elementeSelectedId === null
                      ? 'bg-blue-600 text-white border-blue-700'
                      : 'bg-white hover:bg-gray-50 text-gray-700'
                  }`}
                >
                  <MousePointer2 size={18} />
                  <span className="text-[10px] mt-1 font-medium">Select</span>
                </button>
                <button
                  onClick={() => {
                    setElementeIsDrawing(true);
                    setElementeDrawingPoints([]);
                    setElementeSelectedId(null);
                  }}
                  className={`flex-1 flex flex-col items-center p-3 rounded-lg border transition-colors ${
                    elementeIsDrawing
                      ? 'bg-blue-600 text-white border-blue-700'
                      : 'bg-white hover:bg-gray-50 text-gray-700'
                  }`}
                >
                  <PenTool size={18} />
                  <span className="text-[10px] mt-1 font-medium">Draw</span>
                </button>
              </div>
              {/* Snap Toggle */}
              <div className="flex items-center justify-between mt-2 p-2 bg-white border rounded">
                <div className="flex items-center gap-2">
                  <Crosshair size={14} className={elementeSnapEnabled ? 'text-blue-600' : 'text-gray-400'} />
                  <span className="text-xs font-medium">Snap to edges</span>
                </div>
                <button
                  onClick={() => setElementeSnapEnabled(!elementeSnapEnabled)}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    elementeSnapEnabled
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-200 text-gray-600'
                  }`}
                >
                  {elementeSnapEnabled ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>

            {/* Shapes List for Current View */}
            <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 mb-4">
              <label className="text-[10px] font-bold text-gray-500 uppercase mb-2 block">
                Shapes on {elementeActiveView} ({getShapesForView(elementeActiveView).length})
              </label>
              <div className="max-h-32 overflow-y-auto space-y-1">
                {getShapesForView(elementeActiveView).length === 0 ? (
                  <p className="text-[10px] text-gray-400 text-center py-2">No shapes yet</p>
                ) : (
                  getShapesForView(elementeActiveView).map(shape => (
                    <div
                      key={shape.id}
                      onClick={() => setElementeSelectedId(shape.id)}
                      className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${
                        elementeSelectedId === shape.id ? 'bg-blue-100 border border-blue-300' : 'bg-white hover:bg-gray-100'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded"
                          style={{ backgroundColor: getShapeColor(shape.shapeType, shape.colorIndex, shape.subIndex) }}
                        />
                        <span className="text-xs font-mono">
                          {shape.shapeType === 'on'
                            ? `ON-${shape.colorIndex}`
                            : `${shape.shapeType.toUpperCase()}-${shape.colorIndex}-${shape.subIndex}`}
                        </span>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setElementeShapes(prev => prev.filter(s => s.id !== shape.id));
                          if (elementeSelectedId === shape.id) setElementeSelectedId(null);
                        }}
                        className="p-1 hover:bg-red-100 rounded text-red-500"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Warnings */}
            {getWarningColorIndices().length > 0 && (
              <div className="bg-red-50 border border-red-200 p-3 rounded mb-4">
                <p className="text-xs font-bold text-red-700 mb-1">⚠️ Incomplete Shapes</p>
                <p className="text-[10px] text-red-600">
                  IDs {getWarningColorIndices().join(', ')} appear on only 1 view.
                  Draw on at least 2 views for 3D intersection.
                </p>
              </div>
            )}

            {/* Generate 3D Button */}
            <button
              onClick={handleElementeBuild}
              disabled={!canBuildElemente() || elementeBuildStatus === 'building'}
              className={`w-full p-3 rounded-lg font-bold text-sm flex items-center justify-center gap-2 transition-all ${
                elementeBuildStatus === 'building'
                  ? 'bg-blue-400 text-white cursor-wait'
                  : elementeBuildStatus === 'success'
                  ? 'bg-green-500 text-white'
                  : elementeBuildStatus === 'error'
                  ? 'bg-red-500 text-white'
                  : canBuildElemente()
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
            >
              {elementeBuildStatus === 'building' ? (
                <>
                  <Loader2 className="animate-spin" size={18} />
                  Building 3D...
                </>
              ) : elementeBuildStatus === 'success' ? (
                <>
                  <Check size={18} />
                  Model Created!
                </>
              ) : elementeBuildStatus === 'error' ? (
                <>
                  <Box size={18} />
                  Try Again
                </>
              ) : (
                <>
                  <Box size={18} />
                  Generate 3D Model
                </>
              )}
            </button>

            {/* Error message and logs */}
            {elementeBuildError && (
              <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-600">
                <p className="font-bold mb-1">{elementeBuildError}</p>
                {elementeBuildLogs && (
                  <button
                    onClick={() => setShowElementeLogs(!showElementeLogs)}
                    className="text-red-500 underline text-[10px]"
                  >
                    {showElementeLogs ? 'Hide logs' : 'Show logs'}
                  </button>
                )}
              </div>
            )}

            {/* Build logs (collapsible) */}
            {showElementeLogs && elementeBuildLogs && (
              <div className="mt-2 p-2 bg-gray-900 border border-gray-700 rounded text-[9px] text-green-400 font-mono max-h-48 overflow-auto whitespace-pre-wrap">
                {elementeBuildLogs}
              </div>
            )}

            {/* Zoom Control */}
            <div className="mt-auto pt-4 border-t">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-500">Zoom</span>
                <button onClick={() => setElementeZoom(z => Math.max(0.2, z - 0.1))} className="p-1 bg-white border rounded hover:bg-gray-50 text-xs">-</button>
                <span className="text-xs font-mono flex-1 text-center">{Math.round(elementeZoom * 100)}%</span>
                <button onClick={() => setElementeZoom(z => Math.min(1.5, z + 0.1))} className="p-1 bg-white border rounded hover:bg-gray-50 text-xs">+</button>
              </div>
            </div>
          </>
        )}

        {/* Grundriss tab - existing sidebar content */}
        {drawingSubTab === 'grundriss' && (<>
        {getLaserInfo() && ( <div className="mb-4 bg-red-50 border border-red-200 p-3 rounded flex items-center justify-between"> <span className="text-red-700 font-bold flex items-center gap-2"><Crosshair size={16}/> Distance:</span> <span className="text-2xl font-mono text-red-700">{getLaserInfo()}m</span> </div> )}
        <div className="bg-slate-100 p-3 rounded mb-4">
            <div className="flex gap-2 mb-3"> <button onClick={() => setPaperSize('A4')} className={`flex-1 text-xs py-1 rounded border ${paperSize==='A4' ? 'bg-blue-600 text-white' : 'bg-white'}`}>A4</button> <button onClick={() => setPaperSize('A3')} className={`flex-1 text-xs py-1 rounded border ${paperSize==='A3' ? 'bg-blue-600 text-white' : 'bg-white'}`}>A3</button> </div>
            <div className="flex items-center gap-2 border-t border-slate-200 pt-2 mb-2"> <Type size={14} className="text-gray-500" /> <label className="text-[10px] font-bold text-gray-500 flex-1">Text Size</label> <input type="number" value={fontSize} onChange={(e) => setFontSize(Math.max(6, Math.min(48, Number(e.target.value))))} className="w-12 text-xs p-1 border rounded text-center" /> </div>
            <button onClick={() => setShowDimensions(!showDimensions)} className={`w-full text-xs py-1 rounded flex items-center justify-center gap-1 border transition-colors mb-2 ${showDimensions ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-gray-500 hover:bg-gray-50'}`}> {showDimensions ? <Eye size={12}/> : <EyeOff size={12}/>} {showDimensions ? 'Dims Visible' : 'Dims Hidden'} </button>
            <div className="flex gap-1 border-t border-slate-200 pt-2">
              <button onClick={handleUndo} disabled={historyIndex <= 0} className="flex-1 p-2 bg-white rounded border hover:bg-gray-50 disabled:opacity-30 flex items-center justify-center gap-1 text-xs"><Undo size={14}/> Undo</button>
              <button onClick={handleRedo} disabled={historyIndex >= history.length - 1} className="flex-1 p-2 bg-white rounded border hover:bg-gray-50 disabled:opacity-30 flex items-center justify-center gap-1 text-xs"><Redo size={14}/> Redo</button>
              <button onClick={handleDelete} disabled={selectedId === null} className="flex-1 p-2 bg-red-50 text-red-600 rounded border border-red-200 hover:bg-red-100 disabled:opacity-30 flex items-center justify-center gap-1 text-xs"><Trash2 size={14}/> Delete</button>
            </div>
        </div>
        <div className="space-y-2 mb-6">
          {/* Select & Laser */}
          <div className="flex gap-2">
            <ToolButton active={currentTool === ToolType.SELECT} onClick={() => setCurrentTool(ToolType.SELECT)} icon={<MousePointer2 size={18} />} label="Select" />
            <ToolButton active={currentTool === ToolType.LASER} onClick={() => setCurrentTool(ToolType.LASER)} icon={<Crosshair size={18} />} label="Laser" />
          </div>
          {/* Pen & Wall */}
          <div className="flex gap-2">
            <ToolButton active={currentTool === ToolType.PEN} onClick={() => { setCurrentTool(ToolType.PEN); setPenStartPoint(null); }} icon={<PenTool size={18} />} label="Pen" />
            <ToolButton active={currentTool === ToolType.WALL} onClick={() => setCurrentTool(ToolType.WALL)} icon={<Square size={18} />} label="Wall" />
          </div>
          {/* Window & Door */}
          <div className="flex gap-2">
            <ToolButton active={currentTool === ToolType.WINDOW} onClick={() => setCurrentTool(ToolType.WINDOW)} icon={<Component size={18} />} label="Window" />
            <ToolButton active={currentTool === ToolType.DOOR} onClick={() => setCurrentTool(ToolType.DOOR)} icon={<DoorOpen size={18} />} label="Door" />
          </div>
        </div>
        <div className="bg-slate-50 p-4 rounded-lg border border-slate-200 shadow-sm">
           <h3 className="text-xs font-bold uppercase mb-4 text-slate-500 flex items-center justify-between"> {selectedId ? `ID: ${selectedId}` : `${currentTool}`} {selectedId && <span className="text-green-600">● Active</span>} </h3>
           {selectedId && ( <div className="mb-4 pb-4 border-b border-slate-200"> <div className="flex items-center gap-2 mb-1"> <ArrowRight size={14} className="text-blue-500" /> <label className="text-[11px] font-bold text-gray-700">Length (m)</label> </div> <input type="number" step="0.1" value={getSelectedLength()} onChange={(e) => handleLengthChange(parseFloat(e.target.value))} className="w-full p-2 text-lg font-mono font-bold border border-blue-300 rounded bg-blue-50 focus:outline-none" /> </div> )}
           {((currentTool === ToolType.WALL || currentTool === ToolType.PEN) || (selectedId && elements.find(e => e.id === selectedId) instanceof Wall)) && ( <> <div className="flex gap-1 mb-3"> {['CENTER', 'INNER', 'OUTER'].map(m => ( <button key={m} onClick={() => setMeasureMode(m as MeasureMode)} className={`flex-1 text-[9px] py-1 rounded border ${measureMode === m ? 'bg-slate-700 text-white' : 'bg-white text-gray-500'}`}>{m}</button> ))} </div> <Input num value={config.wallHeight} onChange={v => setConfig({...config, wallHeight: v})} label="Height (cm)" /> <input type="number" value={config.wallThickness} onChange={(e) => setConfig({...config, wallThickness: Number(e.target.value)})} className="w-full p-2 text-sm border rounded mb-3" /> <div className="flex gap-1 mb-3"> <JustifyBtn active={config.wallJustification === WallJustification.LEFT} onClick={() => setConfig({...config, wallJustification: WallJustification.LEFT})} icon={<AlignLeft size={16}/>} label="Left" /> <JustifyBtn active={config.wallJustification === WallJustification.CENTER} onClick={() => setConfig({...config, wallJustification: WallJustification.CENTER})} icon={<AlignCenter size={16}/>} label="Center" /> <JustifyBtn active={config.wallJustification === WallJustification.RIGHT} onClick={() => setConfig({...config, wallJustification: WallJustification.RIGHT})} icon={<AlignRight size={16}/>} label="Right" /> </div> </> )}
           {(currentTool === ToolType.WINDOW || (selectedId && elements.find(e => e.id === selectedId) instanceof WindowElement)) && ( <> <Select label="Type" value={config.windowType} onChange={v => setConfig({...config, windowType: v as WindowType})} options={Object.values(WindowType)} /> <Input num value={config.sillHeight} onChange={v => setConfig({...config, sillHeight: v})} label="Sill" /> <Input num value={config.windowHeight} onChange={v => setConfig({...config, windowHeight: v})} label="Height" /> </> )}
           {(currentTool === ToolType.DOOR || (selectedId && elements.find(e => e.id === selectedId) instanceof Door)) && ( <> <Select label="Type" value={config.doorType} onChange={v => setConfig({...config, doorType: v as DoorType})} options={Object.values(DoorType)} /> <Input num value={config.doorHeight} onChange={v => setConfig({...config, doorHeight: v})} label="Height" /> </> )}
           {selectedId && ( <button onClick={handleUpdateElement} className={`w-full mt-4 p-2 rounded flex items-center justify-center gap-2 transition-all shadow-sm font-bold text-xs uppercase tracking-wide ${saveSuccess ? 'bg-green-500 text-white' : 'bg-blue-600 text-white hover:bg-blue-700'}`}> {saveSuccess ? <Check size={16}/> : <Save size={14}/>} {saveSuccess ? "Saved!" : "Update"} </button> )}
        </div>
        <div className="mt-auto pt-4 border-t space-y-3">
          {/* Import Buttons Row */}
          <div className="flex gap-2">
            {/* Trace Floorplan Button */}
            <input
              type="file"
              id="trace-upload"
              accept=".svg, .png, .jpg, .jpeg, image/*"
              onChange={handleTraceUpload}
              className="hidden"
            />
            <button
              onClick={() => document.getElementById('trace-upload')?.click()}
              className={`flex-1 flex flex-col items-center p-3 rounded-lg border transition-colors ${
                bgImage
                  ? 'bg-green-50 text-green-700 border-green-300'
                  : 'bg-white hover:bg-gray-50 text-gray-700'
              }`}
            >
              <Upload size={18} />
              <span className="text-[10px] mt-1 font-medium">Trace</span>
            </button>

            {/* Import DXF Button */}
            <input
              type="file"
              id="dxf-upload"
              accept=".dxf"
              onChange={handleDxfUpload}
              disabled={isDxfConverting}
              className="hidden"
            />
            <button
              onClick={() => !isDxfConverting && document.getElementById('dxf-upload')?.click()}
              disabled={isDxfConverting}
              className={`flex-1 flex flex-col items-center p-3 rounded-lg border transition-colors ${
                isDxfConverting
                  ? 'bg-blue-50 text-blue-600 border-blue-300'
                  : 'bg-white hover:bg-gray-50 text-gray-700'
              }`}
            >
              {isDxfConverting ? <Loader2 className="animate-spin" size={18} /> : <FileText size={18} />}
              <span className="text-[10px] mt-1 font-medium">{isDxfConverting ? 'Loading...' : 'DXF'}</span>
            </button>
          </div>

          {/* Trace Controls - only show when trace is loaded */}
          {bgImage && (
            <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-600">Trace Controls</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setIsTraceMoving(!isTraceMoving)}
                    className={`p-1.5 rounded border ${isTraceMoving ? 'bg-blue-500 text-white border-blue-600' : 'bg-white hover:bg-gray-100'}`}
                    title="Move Trace"
                  >
                    <Move size={14} />
                  </button>
                  <button
                    onClick={removeTrace}
                    className="p-1.5 rounded bg-white hover:bg-red-50 text-red-500 border"
                    title="Remove Trace"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-500 w-14">Opacity</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={bgOpacity}
                  onChange={e => setBgOpacity(parseFloat(e.target.value))}
                  className="flex-1 h-1"
                />
              </div>
              {/* Scale slider for precise rescaling */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-500 w-14">Scale</span>
                <input
                  type="range"
                  min="0.1"
                  max="3"
                  step="0.01"
                  value={bgScale}
                  onChange={e => setBgScale(parseFloat(e.target.value))}
                  className="flex-1 h-1"
                />
                <input
                  type="number"
                  min="0.1"
                  max="5"
                  step="0.01"
                  value={bgScale.toFixed(2)}
                  onChange={e => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val) && val >= 0.1 && val <= 5) setBgScale(val);
                  }}
                  className="w-14 text-[10px] px-1 py-0.5 border rounded text-center"
                />
              </div>
              {bgDims && (
                <div className="text-[9px] text-gray-400 text-center">
                  {Math.round(bgDims.w * bgScale)} × {Math.round(bgDims.h * bgScale)} px
                </div>
              )}
              {/* Trace Snapping Controls */}
              <div className="bg-amber-50 border border-amber-200 rounded p-2 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-amber-700">Snap to Corners</span>
                  <button
                    onClick={() => setTraceSnapEnabled(!traceSnapEnabled)}
                    className={`text-[10px] px-2 py-0.5 rounded ${traceSnapEnabled ? 'bg-amber-500 text-white' : 'bg-white border'}`}
                  >
                    {traceSnapEnabled ? 'ON' : 'OFF'}
                  </button>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => { setIsMarkingCorners(!isMarkingCorners); setIsTraceMoving(false); }}
                    className={`flex-1 text-[10px] py-1 rounded border ${isMarkingCorners ? 'bg-green-500 text-white' : 'bg-white hover:bg-gray-50'}`}
                  >
                    {isMarkingCorners ? '✓ Marking...' : '+ Mark'}
                  </button>
                  {traceCorners.length > 0 && (
                    <button
                      onClick={() => setTraceCorners([])}
                      className="text-[10px] px-2 py-1 rounded border bg-white hover:bg-red-50 text-red-500"
                      title="Clear all corners"
                    >
                      Clear ({traceCorners.length})
                    </button>
                  )}
                </div>
                {isMarkingCorners && (
                  <p className="text-[9px] text-green-600">Click on trace corners to mark them</p>
                )}
              </div>
            </div>
          )}
        </div>
        </>)}
      </aside>

      {/* Main canvas - only show for Grundriss tab */}
      {drawingSubTab === 'grundriss' && (
      <main className="flex-1 bg-neutral-200 overflow-auto relative">
        <div className="min-w-full min-h-full p-8 flex items-center justify-center" style={{ width: 'fit-content', height: 'fit-content' }}>
          <div className="bg-white shadow-2xl relative" style={{ width: SIZES[paperSize].w * zoom, height: SIZES[paperSize].h * zoom, flexShrink: 0 }}>
            <svg ref={svgRef} viewBox={`0 0 ${SIZES[paperSize].w} ${SIZES[paperSize].h}`} style={{ width: '100%', height: '100%', display: 'block' }} className={`${currentTool === ToolType.SELECT ? 'cursor-default' : 'cursor-crosshair'}`} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onContextMenu={(e) => { e.preventDefault(); if (currentTool === ToolType.PEN && penStartPoint) { setPenStartPoint(null); setStartPoint(null); setCurrentMousePos(null); } }}>
            {bgImage && bgDims && ( <image href={bgImage} x={bgOffset.x} y={bgOffset.y} width={bgDims.w * bgScale} height={bgDims.h * bgScale} opacity={bgOpacity} data-export-ignore="true" /> )}
            <defs> <pattern id="grid" width="100" height="100" patternUnits="userSpaceOnUse"> <path d="M 100 0 L 0 0 0 100" fill="none" stroke="#e2e8f0" strokeWidth="2"/> <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#f1f5f9" strokeWidth="0.5"/> </pattern> </defs> <rect width="100%" height="100%" fill="url(#grid)" pointerEvents="none" data-export-ignore="true" />
            {elements.filter(e => e.type === ToolType.WALL).map(el => renderElement(el))} <CornerFixer elements={elements} selectedId={selectedId} /> {elements.filter(e => e.type !== ToolType.WALL).map(el => renderElement(el))}
            {currentTool === ToolType.PEN && penStartPoint && currentMousePos && ( renderElement(ElementFactory.create(ToolType.WALL, { id: 999, start: penStartPoint, end: currentMousePos }, config), true) )}
            {isDragging && currentTool !== ToolType.PEN && !resizeMode && currentTool !== ToolType.SELECT && currentTool !== ToolType.LASER && startPoint && currentMousePos && ( renderElement(ElementFactory.create(currentTool, { id: 999, start: startPoint, end: currentMousePos }, config), true) )}
            {currentTool === ToolType.LASER && isDragging && startPoint && currentMousePos && ( <g> <line x1={startPoint.x} y1={startPoint.y} x2={currentMousePos.x} y2={currentMousePos.y} stroke="red" strokeWidth="2" strokeDasharray="5,5"/> <circle cx={startPoint.x} cy={startPoint.y} r="3" fill="red"/> <circle cx={currentMousePos.x} cy={currentMousePos.y} r="3" fill="red"/> <rect x={(startPoint.x + currentMousePos.x)/2 - 30} y={(startPoint.y + currentMousePos.y)/2 - 10} width="60" height="20" fill="white" stroke="red" rx="4" /> <text x={(startPoint.x + currentMousePos.x)/2} y={(startPoint.y + currentMousePos.y)/2 + 4} fontSize={fontSize} fill="red" fontWeight="bold" textAnchor="middle">{getLaserInfo()}m</text> </g> )}
            {(currentTool === ToolType.WINDOW || currentTool === ToolType.DOOR) && isDragging && startPoint && currentMousePos && hoveredWall && ( <DimensionOverlay start={startPoint} end={currentMousePos} wall={hoveredWall} fontSize={fontSize} /> )}
            {selectedId !== null && showDimensions && ( (() => { const el = elements.find(e => e.id === selectedId); if (el && (el instanceof WindowElement || el instanceof Door)) { const wall = getWallForElement(el); if (wall) return <DimensionOverlay start={el.start} end={el.end} wall={wall} fontSize={fontSize} />; } return null; })() )}
            {/* Trace corner markers - small dots only (includes DXF-extracted corners) */}
            {bgImage && traceCorners.length > 0 && (traceSnapEnabled || isMarkingCorners) && (
              <g data-export-ignore="true">
                {traceCorners.map((corner, i) => (
                  <circle
                    key={`corner-${i}`}
                    cx={corner.x * bgScale + bgOffset.x}
                    cy={corner.y * bgScale + bgOffset.y}
                    r="3"
                    fill="#ef4444"
                    opacity="0.8"
                  />
                ))}
              </g>
            )}
            {/* Cursor indicator */}
            {snapActive && currentMousePos && ( <circle cx={currentMousePos.x} cy={currentMousePos.y} r="4" fill="#ef4444" stroke="white" strokeWidth="1" pointerEvents="none" data-export-ignore="true"/> )}
            </svg>
          </div>
        </div>

      </main>
      )}

      {/* Main canvas - Elemente tab */}
      {drawingSubTab === 'elemente' && (
      <main className="flex-1 bg-neutral-200 overflow-auto relative">
        {/* View indicator */}
        <div className="absolute top-4 left-4 bg-white shadow rounded px-3 py-2 z-20 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: viewMarkers[elementeActiveView].left }} />
          <span className="text-sm font-bold capitalize">{elementeActiveView} View</span>
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: viewMarkers[elementeActiveView].right }} />
        </div>

        {/* Scale control */}
        <div className="absolute top-4 right-4 bg-white shadow rounded flex items-center gap-2 p-2 z-20">
          <span className="text-[10px] text-gray-500 font-medium">Scale:</span>
          <select
            value={elementeCanvasSizeMM}
            onChange={(e) => setElementeCanvasSizeMM(Number(e.target.value))}
            className="text-xs border rounded px-1 py-0.5 bg-white"
          >
            <option value={2000}>2m</option>
            <option value={4000}>4m</option>
            <option value={6000}>6m</option>
            <option value={8000}>8m</option>
            <option value={10000}>10m</option>
            <option value={15000}>15m</option>
            <option value={20000}>20m</option>
          </select>
        </div>

        {/* Cursor position display */}
        {currentMousePos && elementeIsDrawing && (
          <div className="absolute bottom-4 left-4 bg-slate-800 text-white shadow rounded px-3 py-2 z-20 font-mono text-xs">
            <div className="flex gap-4">
              <span>X: <strong>{formatMeasurement(elementePixelsToMM(currentMousePos.x - 30))}</strong></span>
              <span>Y: <strong>{formatMeasurement(elementePixelsToMM(800 - currentMousePos.y - 30))}</strong></span>
            </div>
            {elementeDrawingPoints.length > 0 && (
              <div className="mt-1 pt-1 border-t border-slate-600 flex gap-4">
                <span>Len: <strong className="text-blue-300">{formatMeasurement(calculateDistanceMM(elementeDrawingPoints[elementeDrawingPoints.length - 1], currentMousePos))}</strong></span>
                <span>Ang: <strong className="text-green-300">{calculateAngle(elementeDrawingPoints[elementeDrawingPoints.length - 1], currentMousePos).toFixed(1)}°</strong></span>
              </div>
            )}
          </div>
        )}

        {/* Canvas area */}
        <div className="min-w-full min-h-full p-8 flex items-center justify-center" style={{ width: 'fit-content', height: 'fit-content' }}>
          <div className="bg-white shadow-2xl relative" style={{ width: 800 * elementeZoom, height: 800 * elementeZoom, flexShrink: 0 }}>
            <svg
              ref={elementeSvgRef}
              viewBox="0 0 800 800"
              style={{ width: '100%', height: '100%', display: 'block' }}
              className={elementeIsDrawing ? 'cursor-crosshair' : elementeIsDragging ? 'cursor-grabbing' : 'cursor-default'}
              onMouseDown={(e) => {
                const svg = elementeSvgRef.current;
                if (!svg) return;
                const rect = svg.getBoundingClientRect();
                let x = ((e.clientX - rect.left) / rect.width) * 800;
                let y = ((e.clientY - rect.top) / rect.height) * 800;

                if (elementeIsDrawing) {
                  // Apply snapping first
                  const snapped = getElementeSnappedPoint({ x, y });
                  x = snapped.x;
                  y = snapped.y;

                  // Apply axis constraint when shift is held and we have existing points
                  if (isShiftHeld && elementeDrawingPoints.length > 0) {
                    const lastPt = elementeDrawingPoints[elementeDrawingPoints.length - 1];
                    const dx = Math.abs(x - lastPt.x);
                    const dy = Math.abs(y - lastPt.y);
                    if (dx > dy) {
                      y = lastPt.y; // Constrain to horizontal
                    } else {
                      x = lastPt.x; // Constrain to vertical
                    }
                  }
                  // Drawing mode: add points
                  setElementeDrawingPoints(prev => [...prev, { x, y }]);
                } else if (elementeSelectedId !== null) {
                  // Check if clicking on the selected shape to start dragging
                  const selectedShape = elementeShapes.find(s => s.id === elementeSelectedId && s.viewId === elementeActiveView);
                  if (selectedShape) {
                    // Simple point-in-polygon check
                    const isInside = isPointInPolygon({ x, y }, selectedShape.points);
                    if (isInside) {
                      setElementeIsDragging(true);
                      setElementeDragStart({ x, y });
                      return;
                    }
                  }
                  // Clicked outside selected shape, deselect
                  setElementeSelectedId(null);
                }
              }}
              onMouseMove={(e) => {
                const svg = elementeSvgRef.current;
                if (!svg) return;
                const rect = svg.getBoundingClientRect();
                let x = ((e.clientX - rect.left) / rect.width) * 800;
                let y = ((e.clientY - rect.top) / rect.height) * 800;

                // Apply snapping during drawing preview
                if (elementeIsDrawing) {
                  const snapped = getElementeSnappedPoint({ x, y });
                  x = snapped.x;
                  y = snapped.y;
                }

                // Apply axis constraint when shift is held during drawing
                if (isShiftHeld && elementeIsDrawing && elementeDrawingPoints.length > 0) {
                  const lastPt = elementeDrawingPoints[elementeDrawingPoints.length - 1];
                  const dx = Math.abs(x - lastPt.x);
                  const dy = Math.abs(y - lastPt.y);
                  if (dx > dy) {
                    y = lastPt.y; // Constrain to horizontal
                  } else {
                    x = lastPt.x; // Constrain to vertical
                  }
                }

                setCurrentMousePos({ x, y });

                // Handle dragging selected shape
                if (elementeIsDragging && elementeDragStart && elementeSelectedId !== null) {
                  let dx = x - elementeDragStart.x;
                  let dy = y - elementeDragStart.y;

                  // Apply axis constraint when shift is held during dragging
                  if (isShiftHeld) {
                    if (Math.abs(dx) > Math.abs(dy)) {
                      dy = 0; // Constrain to horizontal movement
                    } else {
                      dx = 0; // Constrain to vertical movement
                    }
                  }

                  setElementeShapes(prev => prev.map(shape => {
                    if (shape.id === elementeSelectedId) {
                      return {
                        ...shape,
                        points: shape.points.map(p => ({ x: p.x + dx, y: p.y + dy }))
                      };
                    }
                    return shape;
                  }));
                  // Update drag start based on constrained movement
                  setElementeDragStart({
                    x: elementeDragStart.x + dx,
                    y: elementeDragStart.y + dy
                  });
                }
              }}
              onDoubleClick={() => {
                if (elementeIsDrawing && elementeDrawingPoints.length >= 3) {
                  // Close the shape
                  const newShape: ElementeShape = {
                    id: elementeNextId,
                    viewId: elementeActiveView,
                    points: [...elementeDrawingPoints],
                    shapeType: elementeCurrentShapeType,
                    colorIndex: elementeCurrentColorIndex,
                    // subIndex: 0 for 'on', currentSubIndex for 'off'/'cut'
                    subIndex: elementeCurrentShapeType === 'on' ? 0 : elementeCurrentSubIndex,
                    closed: true,
                  };
                  setElementeShapes(prev => [...prev, newShape]);
                  setElementeNextId(prev => prev + 1);
                  setElementeDrawingPoints([]);
                }
              }}
              onMouseUp={() => {
                if (elementeIsDragging) {
                  setElementeIsDragging(false);
                  setElementeDragStart(null);
                }
              }}
              onMouseLeave={() => {
                if (elementeIsDragging) {
                  setElementeIsDragging(false);
                  setElementeDragStart(null);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (elementeIsDrawing && elementeDrawingPoints.length > 0) {
                  // Right-click cancels current drawing
                  setElementeDrawingPoints([]);
                }
              }}
            >
              {/* Grid pattern - scaled to real measurements */}
              <defs>
                {/* Major grid every 500mm equivalent */}
                <pattern id="elementeGridMajor" width={elementeMMToPixels(500)} height={elementeMMToPixels(500)} patternUnits="userSpaceOnUse">
                  <path d={`M ${elementeMMToPixels(500)} 0 L 0 0 0 ${elementeMMToPixels(500)}`} fill="none" stroke="#cbd5e1" strokeWidth="1"/>
                </pattern>
                {/* Minor grid every 100mm equivalent */}
                <pattern id="elementeGridMinor" width={elementeMMToPixels(100)} height={elementeMMToPixels(100)} patternUnits="userSpaceOnUse">
                  <path d={`M ${elementeMMToPixels(100)} 0 L 0 0 0 ${elementeMMToPixels(100)}`} fill="none" stroke="#e2e8f0" strokeWidth="0.5"/>
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill="url(#elementeGridMinor)" pointerEvents="none" />
              <rect width="100%" height="100%" fill="url(#elementeGridMajor)" pointerEvents="none" />

              {/* Top ruler */}
              <g>
                <rect x="30" y="0" width="740" height="25" fill="#f8fafc" stroke="#cbd5e1" strokeWidth="1" />
                {Array.from({ length: Math.ceil(elementeCanvasSizeMM / 500) + 1 }, (_, i) => {
                  const mm = i * 500;
                  const px = 30 + elementeMMToPixels(mm) * (740/800);
                  if (px > 770) return null;
                  return (
                    <g key={`ruler-top-${i}`}>
                      <line x1={px} y1="15" x2={px} y2="25" stroke="#64748b" strokeWidth="1" />
                      <text x={px} y="12" textAnchor="middle" fontSize="8" fill="#64748b" fontFamily="monospace">
                        {mm >= 1000 ? `${mm/1000}m` : `${mm}`}
                      </text>
                    </g>
                  );
                })}
              </g>

              {/* Left ruler with view marker color */}
              <g>
                <rect x="0" y="30" width="25" height="740" fill={viewMarkers[elementeActiveView].left} opacity="0.15" stroke="#cbd5e1" strokeWidth="1" />
                <rect x="0" y="30" width="8" height="740" fill={viewMarkers[elementeActiveView].left} opacity="0.9" />
                {Array.from({ length: Math.ceil(elementeCanvasSizeMM / 500) + 1 }, (_, i) => {
                  const mm = i * 500;
                  const py = 30 + elementeMMToPixels(mm) * (740/800);
                  if (py > 770) return null;
                  return (
                    <g key={`ruler-left-${i}`}>
                      <line x1="15" y1={py} x2="25" y2={py} stroke="#64748b" strokeWidth="1" />
                      <text x="12" y={py + 3} textAnchor="middle" fontSize="8" fill="#64748b" fontFamily="monospace" transform={`rotate(-90, 12, ${py})`}>
                        {mm >= 1000 ? `${mm/1000}m` : `${mm}`}
                      </text>
                    </g>
                  );
                })}
              </g>

              {/* Right ruler with view marker color */}
              <g>
                <rect x="775" y="30" width="25" height="740" fill={viewMarkers[elementeActiveView].right} opacity="0.15" stroke="#cbd5e1" strokeWidth="1" />
                <rect x="792" y="30" width="8" height="740" fill={viewMarkers[elementeActiveView].right} opacity="0.9" />
              </g>

              {/* Bottom ruler (ground line) - or ORANGE marker for TOP view */}
              <g>
                <rect x="30" y="775" width="740" height="25" fill={elementeActiveView === 'top' && viewMarkers.top.bottom ? viewMarkers.top.bottom : '#f8fafc'} opacity={elementeActiveView === 'top' ? 0.15 : 1} stroke="#cbd5e1" strokeWidth="1" />
                <rect x="30" y="792" width="740" height="8" fill={elementeActiveView === 'top' && viewMarkers.top.bottom ? viewMarkers.top.bottom : '#94a3b8'} opacity={elementeActiveView === 'top' ? 0.9 : 0.7} />
                <text x="400" y="788" textAnchor="middle" fontSize="9" fill={elementeActiveView === 'top' ? '#FFA500' : '#64748b'} fontWeight="bold">
                  {elementeActiveView === 'top' ? 'BACK EDGE' : 'GROUND'}
                </text>
              </g>

              {/* Top ruler - PURPLE marker for TOP view (front edge alignment) */}
              {elementeActiveView === 'top' && viewMarkers.top.top && (
                <g>
                  <rect x="30" y="0" width="740" height="25" fill={viewMarkers.top.top} opacity="0.15" stroke="#cbd5e1" strokeWidth="1" />
                  <rect x="30" y="0" width="740" height="8" fill={viewMarkers.top.top} opacity="0.9" />
                  <text x="400" y="18" textAnchor="middle" fontSize="9" fill="#800080" fontWeight="bold">FRONT EDGE</text>
                </g>
              )}

              {/* Corner boxes */}
              <rect x="0" y="0" width="30" height="30" fill="#f1f5f9" stroke="#cbd5e1" />
              <rect x="770" y="0" width="30" height="30" fill="#f1f5f9" stroke="#cbd5e1" />
              <rect x="0" y="770" width="30" height="30" fill="#f1f5f9" stroke="#cbd5e1" />
              <rect x="770" y="770" width="30" height="30" fill="#f1f5f9" stroke="#cbd5e1" />

              {/* Overlay: shapes from other views */}
              {elementeShowOverlay && (['front', 'right', 'left', 'back', 'top'] as ElementeView[])
                .filter(v => v !== elementeActiveView)
                .map(view => (
                  <g key={`overlay-${view}`} opacity={elementeOverlayOpacity}>
                    {getShapesForView(view).map(shape => (
                      <polygon
                        key={`overlay-${shape.id}`}
                        points={shape.points.map(p => `${p.x},${p.y}`).join(' ')}
                        fill="none"
                        stroke={viewMarkers[view].left}
                        strokeWidth="2"
                        strokeDasharray="5,5"
                      />
                    ))}
                  </g>
                ))
              }

              {/* Shapes for current view */}
              {getShapesForView(elementeActiveView).map(shape => (
                <g key={shape.id}>
                  <polygon
                    points={shape.points.map(p => `${p.x},${p.y}`).join(' ')}
                    fill={getShapeColor(shape.shapeType, shape.colorIndex, shape.subIndex)}
                    fillOpacity={0.3}
                    stroke={elementeSelectedId === shape.id ? '#3B82F6' : getShapeColor(shape.shapeType, shape.colorIndex, shape.subIndex)}
                    strokeWidth={elementeSelectedId === shape.id ? 3 : 2}
                    onClick={() => !elementeIsDrawing && setElementeSelectedId(shape.id)}
                    style={{ cursor: elementeIsDrawing ? 'crosshair' : elementeSelectedId === shape.id ? 'grab' : 'pointer' }}
                  />
                  {/* Show measurements when shape is selected */}
                  {elementeSelectedId === shape.id && shape.points.map((p, i) => {
                    const nextIdx = (i + 1) % shape.points.length;
                    const next = shape.points[nextIdx];
                    const midX = (p.x + next.x) / 2;
                    const midY = (p.y + next.y) / 2;
                    const distMM = calculateDistanceMM(p, next);
                    const angle = calculateAngle(p, next);
                    const perpAngle = (angle + 90) * Math.PI / 180;
                    const offsetDist = 12;
                    const labelX = midX + Math.cos(perpAngle) * offsetDist;
                    const labelY = midY - Math.sin(perpAngle) * offsetDist;
                    return (
                      <g key={`sel-measure-${i}`} pointerEvents="none">
                        <rect
                          x={labelX - 22}
                          y={labelY - 7}
                          width="44"
                          height="14"
                          fill="#3b82f6"
                          fillOpacity="0.9"
                          rx="3"
                        />
                        <text
                          x={labelX}
                          y={labelY + 4}
                          textAnchor="middle"
                          fontSize="9"
                          fontWeight="bold"
                          fill="white"
                          fontFamily="monospace"
                        >
                          {formatMeasurement(distMM)}
                        </text>
                      </g>
                    );
                  })}
                </g>
              ))}

              {/* Currently drawing shape */}
              {elementeIsDrawing && elementeDrawingPoints.length > 0 && (
                <g>
                  {/* Lines connecting points */}
                  <polyline
                    points={elementeDrawingPoints.map(p => `${p.x},${p.y}`).join(' ')}
                    fill="none"
                    stroke={getShapeColor(elementeCurrentShapeType, elementeCurrentColorIndex, elementeCurrentShapeType === 'on' ? 0 : elementeCurrentSubIndex)}
                    strokeWidth="2"
                  />
                  {/* Measurement labels for existing segments */}
                  {elementeDrawingPoints.map((p, i) => {
                    if (i === 0) return null;
                    const prev = elementeDrawingPoints[i - 1];
                    const midX = (prev.x + p.x) / 2;
                    const midY = (prev.y + p.y) / 2;
                    const distMM = calculateDistanceMM(prev, p);
                    const angle = calculateAngle(prev, p);
                    // Offset label perpendicular to line
                    const perpAngle = (angle + 90) * Math.PI / 180;
                    const offsetDist = 15;
                    const labelX = midX + Math.cos(perpAngle) * offsetDist;
                    const labelY = midY - Math.sin(perpAngle) * offsetDist;
                    return (
                      <g key={`measure-${i}`}>
                        <rect
                          x={labelX - 25}
                          y={labelY - 8}
                          width="50"
                          height="16"
                          fill="white"
                          fillOpacity="0.9"
                          rx="3"
                        />
                        <text
                          x={labelX}
                          y={labelY + 4}
                          textAnchor="middle"
                          fontSize="10"
                          fontWeight="bold"
                          fill="#1e40af"
                          fontFamily="monospace"
                        >
                          {formatMeasurement(distMM)}
                        </text>
                      </g>
                    );
                  })}
                  {/* Preview line to cursor */}
                  {currentMousePos && (
                    <>
                      <line
                        x1={elementeDrawingPoints[elementeDrawingPoints.length - 1].x}
                        y1={elementeDrawingPoints[elementeDrawingPoints.length - 1].y}
                        x2={currentMousePos.x}
                        y2={currentMousePos.y}
                        stroke={getShapeColor(elementeCurrentShapeType, elementeCurrentColorIndex, elementeCurrentShapeType === 'on' ? 0 : elementeCurrentSubIndex)}
                        strokeWidth="1"
                        strokeDasharray="4,4"
                      />
                      {/* Preview measurement label */}
                      {(() => {
                        const lastPt = elementeDrawingPoints[elementeDrawingPoints.length - 1];
                        const midX = (lastPt.x + currentMousePos.x) / 2;
                        const midY = (lastPt.y + currentMousePos.y) / 2;
                        const distMM = calculateDistanceMM(lastPt, currentMousePos);
                        const angle = calculateAngle(lastPt, currentMousePos);
                        const perpAngle = (angle + 90) * Math.PI / 180;
                        const offsetDist = 18;
                        const labelX = midX + Math.cos(perpAngle) * offsetDist;
                        const labelY = midY - Math.sin(perpAngle) * offsetDist;
                        return (
                          <g>
                            <rect
                              x={labelX - 30}
                              y={labelY - 9}
                              width="60"
                              height="18"
                              fill="#3b82f6"
                              fillOpacity="0.95"
                              rx="4"
                            />
                            <text
                              x={labelX}
                              y={labelY + 5}
                              textAnchor="middle"
                              fontSize="11"
                              fontWeight="bold"
                              fill="white"
                              fontFamily="monospace"
                            >
                              {formatMeasurement(distMM)}
                            </text>
                          </g>
                        );
                      })()}
                    </>
                  )}
                  {/* Point markers */}
                  {elementeDrawingPoints.map((p, i) => (
                    <circle
                      key={i}
                      cx={p.x}
                      cy={p.y}
                      r="5"
                      fill={i === 0 ? '#22C55E' : getShapeColor(elementeCurrentShapeType, elementeCurrentColorIndex, elementeCurrentShapeType === 'on' ? 0 : elementeCurrentSubIndex)}
                      stroke="white"
                      strokeWidth="2"
                    />
                  ))}
                </g>
              )}

              {/* Instructions overlay when drawing */}
              {elementeIsDrawing && elementeDrawingPoints.length === 0 && (
                <text x="400" y="400" textAnchor="middle" fill="#94a3b8" fontSize="14">
                  Click to add points. Double-click to close shape.
                </text>
              )}
              {elementeIsDrawing && elementeDrawingPoints.length > 0 && elementeDrawingPoints.length < 3 && (
                <text x="400" y="780" textAnchor="middle" fill="#94a3b8" fontSize="12">
                  Add at least 3 points, then double-click to close
                </text>
              )}
              {elementeIsDrawing && elementeDrawingPoints.length >= 3 && (
                <text x="400" y="780" textAnchor="middle" fill="#22C55E" fontSize="12" fontWeight="bold">
                  Double-click to close shape ({elementeDrawingPoints.length} points)
                </text>
              )}

              {/* Cursor indicator */}
              {currentMousePos && elementeIsDrawing && (
                <circle cx={currentMousePos.x} cy={currentMousePos.y} r="4" fill="#3B82F6" stroke="white" strokeWidth="1" pointerEvents="none" />
              )}
            </svg>
          </div>
        </div>
      </main>
      )}

      {/* Project Files Panel */}
      {projectFilesPanelOpen && (
        <ProjectFilesPanel
          projectFiles={projectFiles || []}
          onRemoveFile={onRemoveProjectFile}
          onClose={() => onCloseProjectFilesPanel?.()}
        />
      )}
    </div>
  );
}

const ToolButton = ({ active, onClick, icon, label }: any) => ( <button onClick={onClick} className={`flex-1 flex flex-col items-center p-3 rounded-lg border transition-colors ${active ? 'bg-blue-600 text-white border-blue-700' : 'bg-white hover:bg-gray-50 text-gray-700'}`}> {icon} <span className="text-[10px] mt-1 font-medium">{label}</span> </button> );
const JustifyBtn = ({ active, onClick, icon, label }: any) => ( <button onClick={onClick} className={`flex-1 flex flex-col items-center justify-center p-2 rounded border transition-colors ${active ? 'bg-slate-700 text-white' : 'bg-white text-slate-500 hover:bg-slate-100'}`}> {icon} <span className="text-[9px] mt-0.5">{label}</span> </button> );
const Input = ({ label, value, onChange, num }: { label: string; value: string | number; onChange: (v: any) => void; num?: boolean }) => ( <div className="mb-3"><label className="block text-[11px] font-bold text-gray-500 mb-1">{label}</label> <input type={num ? "number" : "text"} value={value} onChange={e => onChange(num ? Number(e.target.value) : e.target.value)} className="w-full p-2 text-sm border border-gray-300 rounded focus:border-blue-500 focus:outline-none"/></div> );
const Select = ({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) => ( <div className="mb-3"><label className="block text-[11px] font-bold text-gray-500 mb-1">{label}</label> <select value={value} onChange={e => onChange(e.target.value)} className="w-full p-2 text-sm border border-gray-300 rounded focus:border-blue-500 focus:outline-none bg-white"> {options.map((o:string) => <option key={o} value={o}>{o.replace('_', ' ')}</option>)} </select></div> );