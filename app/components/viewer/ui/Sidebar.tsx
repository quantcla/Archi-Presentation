import React, { useState, useRef, useEffect } from 'react';
import { FloorModel } from '../floors/FloorManager';
import { Measurement } from '../tools/MeasurementTool';
import { PlacedObject } from '../tools/ObjectManager';

export type MeasureToolMode = 'none' | 'line' | 'polygon';

// Type for section preview lines
export interface SectionLine {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
}

interface Props {
  floors: FloorModel[];
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onUpdateFloor: (id: string, updates: Partial<FloorModel>) => void;
  onExportGLB: () => void;
  onSendToSimulation?: () => void;
  onExportSectionDXF?: () => void;
  onCreateElevationsDXF?: () => void;
  isGeneratingElevations?: boolean;
  sectionEnabled?: boolean;
  sectionPreviewLines?: SectionLine[];
  sectionY?: number;
  sectionMaxY?: number;
  onSectionMaxYChange?: (maxY: number) => void;
  // Measurement props
  measureToolMode?: MeasureToolMode;
  setMeasureToolMode?: (mode: MeasureToolMode) => void;
  measurements?: Measurement[];
  selectedMeasurementId?: string | null;
  onSelectMeasurement?: (id: string | null) => void;
  onDeleteMeasurement?: (id: string) => void;
  onMoveMeasurement?: (id: string, axis: 'x' | 'z', delta: number) => void;
  includeMeasurementsInExport?: boolean;
  setIncludeMeasurementsInExport?: (include: boolean) => void;
  // Object props
  placedObjects?: PlacedObject[];
  selectedObjectId?: string | null;
  onUploadObject?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDropFloor?: () => void;
  onDropObject?: () => void;
  onSelectObject?: (id: string | null) => void;
  onDeleteObject?: (id: string) => void;
  onDuplicateObject?: (id: string) => void;
  onUpdateObject?: (id: string, updates: { position?: { x: number; y: number; z: number }; rotation?: { x: number; y: number; z: number }; scale?: number; visible?: boolean; name?: string }) => void;
}

// Section Preview Component
const SectionPreview: React.FC<{ lines: SectionLine[]; sectionY: number }> = ({ lines, sectionY }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    ctx.fillStyle = '#f8f9fa';
    ctx.fillRect(0, 0, width, height);

    if (lines.length === 0) {
      // Draw "no data" message
      ctx.fillStyle = '#9ca3af';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No section data', width / 2, height / 2);
      return;
    }

    // Calculate bounds
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const line of lines) {
      minX = Math.min(minX, line.x1, line.x2);
      maxX = Math.max(maxX, line.x1, line.x2);
      minZ = Math.min(minZ, line.z1, line.z2);
      maxZ = Math.max(maxZ, line.z1, line.z2);
    }

    // Add padding
    const padding = 10;
    const rangeX = maxX - minX || 1;
    const rangeZ = maxZ - minZ || 1;

    // Calculate scale to fit
    const scaleX = (width - padding * 2) / rangeX;
    const scaleZ = (height - padding * 2) / rangeZ;
    const scale = Math.min(scaleX, scaleZ);

    // Center offset
    const offsetX = padding + (width - padding * 2 - rangeX * scale) / 2;
    const offsetZ = padding + (height - padding * 2 - rangeZ * scale) / 2;

    // Transform function
    const toCanvas = (x: number, z: number): [number, number] => {
      return [
        offsetX + (x - minX) * scale,
        offsetZ + (z - minZ) * scale
      ];
    };

    // Draw grid
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 0.5;
    const gridSize = Math.pow(10, Math.floor(Math.log10(Math.max(rangeX, rangeZ))));

    for (let x = Math.floor(minX / gridSize) * gridSize; x <= maxX; x += gridSize) {
      const [cx] = toCanvas(x, 0);
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, height);
      ctx.stroke();
    }
    for (let z = Math.floor(minZ / gridSize) * gridSize; z <= maxZ; z += gridSize) {
      const [, cz] = toCanvas(0, z);
      ctx.beginPath();
      ctx.moveTo(0, cz);
      ctx.lineTo(width, cz);
      ctx.stroke();
    }

    // Draw section lines
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';

    for (const line of lines) {
      const [x1, z1] = toCanvas(line.x1, line.z1);
      const [x2, z2] = toCanvas(line.x2, line.z2);

      ctx.beginPath();
      ctx.moveTo(x1, z1);
      ctx.lineTo(x2, z2);
      ctx.stroke();
    }

    // Draw label
    ctx.fillStyle = '#6b7280';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Y = ${sectionY.toFixed(2)}m`, 4, 12);
    ctx.textAlign = 'right';
    ctx.fillText(`${lines.length} lines`, width - 4, 12);

  }, [lines, sectionY]);

  return (
    <canvas
      ref={canvasRef}
      width={240}
      height={160}
      className="w-full rounded border border-gray-300 bg-gray-50"
    />
  );
};

export const ViewerSidebar: React.FC<Props> = ({
  floors,
  onUpload,
  onUpdateFloor,
  onExportGLB,
  onSendToSimulation,
  onExportSectionDXF,
  onCreateElevationsDXF,
  isGeneratingElevations = false,
  sectionEnabled = false,
  sectionPreviewLines = [],
  sectionY = 1.5,
  sectionMaxY = 10,
  onSectionMaxYChange,
  measureToolMode = 'none',
  setMeasureToolMode,
  measurements = [],
  selectedMeasurementId,
  onSelectMeasurement,
  onDeleteMeasurement,
  onMoveMeasurement,
  includeMeasurementsInExport = true,
  setIncludeMeasurementsInExport,
  placedObjects = [],
  selectedObjectId,
  onUploadObject,
  onDropFloor,
  onDropObject,
  onSelectObject,
  onDeleteObject,
  onDuplicateObject,
  onUpdateObject
}) => {
  const [activeTab, setActiveTab] = useState<'floors' | 'tools' | 'export'>('floors');
  const [floorsSubTab, setFloorsSubTab] = useState<'floors' | 'objects'>('floors');
  const [floorDragOver, setFloorDragOver] = useState(false);
  const [objectDragOver, setObjectDragOver] = useState(false);

  return (
    <div className="w-80 h-full bg-white shadow-xl flex flex-col font-sans border-r text-gray-900">
      <div className="flex bg-gray-100 border-b">
        {['floors', 'tools', 'export'].map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab as any)}
            className={`flex-1 py-3 text-sm font-bold uppercase ${activeTab === tab ? 'bg-white border-b-2 border-blue-500 text-blue-600' : 'text-gray-500'}`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="p-4 flex-1 overflow-auto">
        {activeTab === 'floors' && (
          <div className="space-y-4">
            {/* Sub-tabs for Floors and Objects */}
            <div className="flex bg-gray-100 rounded-lg p-1">
              <button
                onClick={() => setFloorsSubTab('floors')}
                className={`flex-1 py-2 text-xs font-bold rounded ${floorsSubTab === 'floors' ? 'bg-white shadow text-blue-600' : 'text-gray-500'}`}
              >
                Etagen
              </button>
              <button
                onClick={() => setFloorsSubTab('objects')}
                className={`flex-1 py-2 text-xs font-bold rounded ${floorsSubTab === 'objects' ? 'bg-white shadow text-purple-600' : 'text-gray-500'}`}
              >
                Objekte
              </button>
            </div>

            {/* Floors sub-tab content */}
            {floorsSubTab === 'floors' && (
              <div className="space-y-4">
                <div>
                  <label
                    className={`block w-full p-4 border-2 border-dashed rounded-lg text-center cursor-pointer transition ${
                      floorDragOver
                        ? 'border-blue-500 bg-blue-100 scale-[1.02]'
                        : 'border-gray-300 hover:border-blue-500 hover:bg-blue-50'
                    }`}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes('application/project-file')) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'copy';
                        setFloorDragOver(true);
                      }
                    }}
                    onDragEnter={(e) => {
                      if (e.dataTransfer.types.includes('application/project-file')) {
                        e.preventDefault();
                        setFloorDragOver(true);
                      }
                    }}
                    onDragLeave={() => setFloorDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setFloorDragOver(false);
                      if (onDropFloor) onDropFloor();
                    }}
                  >
                    <span className="text-sm font-medium text-gray-600">
                      {floorDragOver ? 'Drop IFC here' : '+ Upload IFC Floor'}
                    </span>
                    <input type="file" accept=".ifc" className="hidden" onChange={onUpload} />
                  </label>
                </div>

                <div className="space-y-4">
                  {floors.map((floor) => (
                    <div key={floor.id} className="bg-gray-50 p-3 rounded border">
                      <div className="flex justify-between items-center mb-2">
                        <span className="font-bold text-sm">{floor.name}</span>
                        <input type="checkbox" checked={floor.visible} onChange={(e) => onUpdateFloor(floor.id, { visible: e.target.checked })} />
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <label>Elevation (Y) m</label>
                          <input type="number" step="0.001" className="w-full border rounded p-1" value={floor.elevation.toFixed(3)} onChange={(e) => onUpdateFloor(floor.id, { elevation: parseFloat(e.target.value) || 0 })} />
                        </div>
                        <div>
                          <label>Rotation (Y) °</label>
                          <input type="number" step="0.1" className="w-full border rounded p-1" value={(floor.rotation * 180 / Math.PI).toFixed(1)} onChange={(e) => onUpdateFloor(floor.id, { rotation: (parseFloat(e.target.value) || 0) * Math.PI / 180 })} />
                        </div>
                        <div>
                          <label>Offset X m</label>
                          <input type="number" step="0.001" className="w-full border rounded p-1" value={floor.offset.x.toFixed(3)} onChange={(e) => onUpdateFloor(floor.id, { offset: { ...floor.offset, x: parseFloat(e.target.value) || 0 } })} />
                        </div>
                        <div>
                          <label>Offset Z m</label>
                          <input type="number" step="0.001" className="w-full border rounded p-1" value={floor.offset.z.toFixed(3)} onChange={(e) => onUpdateFloor(floor.id, { offset: { ...floor.offset, z: parseFloat(e.target.value) || 0 } })} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Objects sub-tab content */}
            {floorsSubTab === 'objects' && (
              <div className="space-y-4">
                <div>
                  <label
                    className={`block w-full p-4 border-2 border-dashed rounded-lg text-center cursor-pointer transition ${
                      objectDragOver
                        ? 'border-purple-500 bg-purple-100 scale-[1.02]'
                        : 'border-purple-300 hover:border-purple-500 hover:bg-purple-50'
                    }`}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes('application/project-file')) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'copy';
                        setObjectDragOver(true);
                      }
                    }}
                    onDragEnter={(e) => {
                      if (e.dataTransfer.types.includes('application/project-file')) {
                        e.preventDefault();
                        setObjectDragOver(true);
                      }
                    }}
                    onDragLeave={() => setObjectDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setObjectDragOver(false);
                      if (onDropObject) onDropObject();
                    }}
                  >
                    <span className="text-sm font-medium text-gray-600">
                      {objectDragOver ? 'Drop model here' : '+ Upload 3D Object'}
                    </span>
                    <p className="text-xs text-gray-400 mt-1">GLTF, GLB, OBJ, FBX</p>
                    <input type="file" accept=".gltf,.glb,.obj,.fbx" className="hidden" onChange={onUploadObject} />
                  </label>
                </div>

                {/* Objects List */}
                {placedObjects.length > 0 && (
                  <div className="space-y-3">
                    <h4 className="text-xs font-bold text-gray-500 uppercase">Placed Objects ({placedObjects.length})</h4>
                    <div className="space-y-2 max-h-60 overflow-auto">
                      {placedObjects.map((obj) => (
                        <div
                          key={obj.id}
                          onClick={() => onSelectObject?.(obj.id === selectedObjectId ? null : obj.id)}
                          className={`p-3 rounded border cursor-pointer transition ${
                            obj.id === selectedObjectId
                              ? 'bg-purple-50 border-purple-400'
                              : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className="text-lg">📦</span>
                              <span className="text-sm font-medium truncate max-w-[120px]">{obj.name}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={obj.visible}
                                onChange={(e) => {
                                  e.stopPropagation();
                                  onUpdateObject?.(obj.id, { visible: e.target.checked });
                                }}
                                title="Visibility"
                              />
                              {obj.id === selectedObjectId && onDuplicateObject && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onDuplicateObject(obj.id);
                                  }}
                                  className="p-1 text-blue-500 hover:bg-blue-100 rounded"
                                  title="Duplicate"
                                >
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                                  </svg>
                                </button>
                              )}
                              {obj.id === selectedObjectId && onDeleteObject && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onDeleteObject(obj.id);
                                  }}
                                  className="p-1 text-red-500 hover:bg-red-100 rounded"
                                  title="Delete"
                                >
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                                  </svg>
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Position controls when selected */}
                          {obj.id === selectedObjectId && onUpdateObject && (
                            <div className="mt-2 pt-2 border-t border-purple-200">
                              <div className="grid grid-cols-3 gap-2 text-xs">
                                <div>
                                  <label className="text-gray-500">X (m)</label>
                                  <input
                                    type="number"
                                    step="0.001"
                                    className="w-full border rounded p-1 text-xs"
                                    value={obj.position.x.toFixed(3)}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => onUpdateObject(obj.id, {
                                      position: { x: parseFloat(e.target.value) || 0, y: obj.position.y, z: obj.position.z }
                                    })}
                                  />
                                </div>
                                <div>
                                  <label className="text-gray-500">Y (m)</label>
                                  <input
                                    type="number"
                                    step="0.001"
                                    className="w-full border rounded p-1 text-xs"
                                    value={obj.position.y.toFixed(3)}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => onUpdateObject(obj.id, {
                                      position: { x: obj.position.x, y: parseFloat(e.target.value) || 0, z: obj.position.z }
                                    })}
                                  />
                                </div>
                                <div>
                                  <label className="text-gray-500">Z (m)</label>
                                  <input
                                    type="number"
                                    step="0.001"
                                    className="w-full border rounded p-1 text-xs"
                                    value={obj.position.z.toFixed(3)}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => onUpdateObject(obj.id, {
                                      position: { x: obj.position.x, y: obj.position.y, z: parseFloat(e.target.value) || 0 }
                                    })}
                                  />
                                </div>
                              </div>
                              <div className="grid grid-cols-3 gap-2 text-xs mt-2">
                                <div>
                                  <label className="text-gray-500">Rot X</label>
                                  <input
                                    type="number"
                                    step="15"
                                    className="w-full border rounded p-1 text-xs"
                                    value={Math.round(obj.rotation.x * 180 / Math.PI)}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => onUpdateObject(obj.id, {
                                      rotation: { x: (parseFloat(e.target.value) || 0) * Math.PI / 180, y: obj.rotation.y, z: obj.rotation.z }
                                    })}
                                  />
                                </div>
                                <div>
                                  <label className="text-gray-500">Rot Y</label>
                                  <input
                                    type="number"
                                    step="15"
                                    className="w-full border rounded p-1 text-xs"
                                    value={Math.round(obj.rotation.y * 180 / Math.PI)}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => onUpdateObject(obj.id, {
                                      rotation: { x: obj.rotation.x, y: (parseFloat(e.target.value) || 0) * Math.PI / 180, z: obj.rotation.z }
                                    })}
                                  />
                                </div>
                                <div>
                                  <label className="text-gray-500">Rot Z</label>
                                  <input
                                    type="number"
                                    step="15"
                                    className="w-full border rounded p-1 text-xs"
                                    value={Math.round(obj.rotation.z * 180 / Math.PI)}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => onUpdateObject(obj.id, {
                                      rotation: { x: obj.rotation.x, y: obj.rotation.y, z: (parseFloat(e.target.value) || 0) * Math.PI / 180 }
                                    })}
                                  />
                                </div>
                              </div>
                              <div className="mt-2">
                                <label className="text-xs text-gray-500">Scale</label>
                                <input
                                  type="range"
                                  min="0.1"
                                  max="5"
                                  step="0.1"
                                  className="w-full"
                                  value={obj.scale.x}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => onUpdateObject(obj.id, {
                                    scale: parseFloat(e.target.value)
                                  })}
                                />
                                <div className="text-right text-xs text-gray-500">{obj.scale.x.toFixed(1)}x</div>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {placedObjects.length === 0 && (
                  <div className="text-center text-gray-400 text-sm py-8">
                    No objects placed yet.<br/>Upload a 3D model to get started.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'tools' && (
          <div className="space-y-4">
            {/* Measurement Tools */}
            <div className="p-3 bg-green-50 rounded border border-green-200">
              <h3 className="font-bold text-green-700 mb-2">📏 Measurements</h3>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setMeasureToolMode?.(measureToolMode === 'line' ? 'none' : 'line')}
                  className={`p-3 rounded border text-sm font-medium transition flex flex-col items-center gap-1 ${
                    measureToolMode === 'line'
                      ? 'bg-green-500 text-white border-green-600'
                      : 'bg-white hover:bg-green-100 border-green-200'
                  }`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21.3 8.7 8.7 21.3c-1 1-2.5 1-3.4 0l-2.6-2.6c-1-1-1-2.5 0-3.4L15.3 2.7c1-1 2.5-1 3.4 0l2.6 2.6c1 1 1 2.5 0 3.4Z"/>
                    <path d="m7.5 10.5 2 2"/>
                    <path d="m10.5 7.5 2 2"/>
                    <path d="m13.5 4.5 2 2"/>
                    <path d="m4.5 13.5 2 2"/>
                  </svg>
                  Distance
                </button>
                <button
                  onClick={() => setMeasureToolMode?.(measureToolMode === 'polygon' ? 'none' : 'polygon')}
                  className={`p-3 rounded border text-sm font-medium transition flex flex-col items-center gap-1 ${
                    measureToolMode === 'polygon'
                      ? 'bg-blue-500 text-white border-blue-600'
                      : 'bg-white hover:bg-blue-100 border-blue-200'
                  }`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6l9-4 9 4v12l-9 4-9-4V6z"/>
                  </svg>
                  Area
                </button>
              </div>

              {/* Measurements List */}
              {measurements.length > 0 && (
                <div className="mt-3 space-y-1">
                  <h4 className="text-xs font-bold text-gray-500 uppercase">Saved ({measurements.length})</h4>
                  <div className="max-h-32 overflow-auto space-y-1">
                    {measurements.map((m) => (
                      <div
                        key={m.id}
                        onClick={() => onSelectMeasurement?.(m.id === selectedMeasurementId ? null : m.id)}
                        className={`p-2 rounded border cursor-pointer text-xs ${
                          m.id === selectedMeasurementId
                            ? 'bg-orange-50 border-orange-300'
                            : 'bg-white hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span>{m.type === 'line' ? '📏' : '📐'} {m.type === 'line' ? `${m.distance.toFixed(3)} m` : `${m.area.toFixed(3)} m²`}</span>
                          {m.id === selectedMeasurementId && onDeleteMeasurement && (
                            <button
                              onClick={(e) => { e.stopPropagation(); onDeleteMeasurement(m.id); }}
                              className="text-red-500"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                              </svg>
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* DXF Export Options */}
            <div className="p-3 bg-gray-50 rounded border border-gray-200 space-y-3">
              <h3 className="font-bold text-gray-700 text-sm">DXF Exports</h3>

              {/* Section Max Height Control */}
              {onSectionMaxYChange && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-gray-600">Max Section Height</label>
                    <span className="text-xs font-mono text-gray-500">{sectionMaxY}m</span>
                  </div>
                  <input
                    type="range"
                    min="3"
                    max="50"
                    step="1"
                    className="w-full h-1.5"
                    value={sectionMaxY}
                    onChange={(e) => onSectionMaxYChange(parseFloat(e.target.value))}
                  />
                  <div className="flex justify-between text-[9px] text-gray-400">
                    <span>3m</span>
                    <span>50m</span>
                  </div>
                </div>
              )}

              {/* Section Preview */}
              {sectionEnabled && (
                <div className="space-y-2">
                  <h4 className="text-xs font-medium text-gray-600">Section Preview</h4>
                  <SectionPreview lines={sectionPreviewLines} sectionY={sectionY} />
                </div>
              )}

              {/* Export Section as DXF */}
              {onExportSectionDXF && (
                <button
                  onClick={onExportSectionDXF}
                  disabled={!sectionEnabled}
                  className={`w-full py-2 rounded text-sm transition flex items-center justify-center gap-2 ${
                    sectionEnabled
                      ? 'bg-gray-800 text-white hover:bg-gray-900'
                      : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  }`}
                  title={!sectionEnabled ? 'Enable section cut first' : 'Export Section DXF'}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  Export Section DXF
                </button>
              )}

              {/* Create Elevations */}
              {onCreateElevationsDXF && (
                <button
                  onClick={onCreateElevationsDXF}
                  disabled={isGeneratingElevations}
                  className={`w-full py-2 rounded text-sm transition flex items-center justify-center gap-2 ${
                    isGeneratingElevations
                      ? 'bg-gray-400 text-gray-200 cursor-not-allowed'
                      : 'bg-indigo-600 text-white hover:bg-indigo-700'
                  }`}
                >
                  {isGeneratingElevations ? (
                    <>
                      <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                      </svg>
                      Generating...
                    </>
                  ) : (
                    <>
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="18" height="18" rx="2"/>
                        <path d="M3 9h18"/>
                        <path d="M9 21V9"/>
                      </svg>
                      Create Elevations
                    </>
                  )}
                </button>
              )}
            </div>

            {/* Move Selected Measurement */}
            {selectedMeasurementId && onMoveMeasurement && (
              <div className="p-3 bg-orange-50 rounded border border-orange-200">
                <h4 className="text-xs font-bold text-orange-700 mb-2">Move Selected</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-gray-500">X Axis</label>
                    <div className="flex gap-1">
                      <button
                        onClick={() => onMoveMeasurement(selectedMeasurementId, 'x', -0.1)}
                        className="flex-1 py-1 bg-white hover:bg-gray-100 rounded text-xs border"
                      >
                        -0.1
                      </button>
                      <button
                        onClick={() => onMoveMeasurement(selectedMeasurementId, 'x', 0.1)}
                        className="flex-1 py-1 bg-white hover:bg-gray-100 rounded text-xs border"
                      >
                        +0.1
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">Z Axis</label>
                    <div className="flex gap-1">
                      <button
                        onClick={() => onMoveMeasurement(selectedMeasurementId, 'z', -0.1)}
                        className="flex-1 py-1 bg-white hover:bg-gray-100 rounded text-xs border"
                      >
                        -0.1
                      </button>
                      <button
                        onClick={() => onMoveMeasurement(selectedMeasurementId, 'z', 0.1)}
                        className="flex-1 py-1 bg-white hover:bg-gray-100 rounded text-xs border"
                      >
                        +0.1
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'export' && (
          <div className="space-y-4">
            <h3 className="font-bold text-gray-700">Export Options</h3>

            <button
              onClick={onExportGLB}
              className="w-full py-3 bg-blue-600 text-white rounded font-bold shadow hover:bg-blue-700 transition flex items-center justify-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Download Stacked GLB
            </button>
          </div>
        )}
      </div>
    </div>
  );
};