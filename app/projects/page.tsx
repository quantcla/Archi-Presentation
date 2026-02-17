'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus,
  FolderOpen,
  MoreVertical,
  Pencil,
  Image as ImageIcon,
  Trash2,
  Search,
  ArrowLeft,
  Upload,
  X,
  MapPin,
  Navigation,
} from 'lucide-react';
import {
  getProjects,
  createProject,
  updateProject,
  deleteProject,
  saveProjectFiles,
  timeAgo,
  type Project,
  type ProjectLocation,
  type StoredProjectFile,
} from '../lib/projects';

// Accepted file extensions mapped to types
const FILE_TYPE_MAP: Record<string, StoredProjectFile['type']> = {
  dxf: 'dxf', svg: 'svg', pdf: 'pdf', png: 'png', jpg: 'jpg', jpeg: 'jpg',
  glb: 'glb', ifc: 'ifc',
};

const ACCEPT_STRING = Object.keys(FILE_TYPE_MAP).map(ext => `.${ext}`).join(',');

function getFileType(filename: string): StoredProjectFile['type'] | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return FILE_TYPE_MAP[ext] ?? null;
}

function getFileIcon(type: StoredProjectFile['type']) {
  if (type === 'png' || type === 'jpg') return '🖼️';
  if (type === 'ifc' || type === 'glb') return '📦';
  if (type === 'pdf') return '📄';
  if (type === 'svg') return '🎨';
  if (type === 'dxf') return '📐';
  return '📎';
}

// Default map center (Switzerland)
const DEFAULT_CENTER: [number, number] = [47.37, 8.54];
const DEFAULT_ZOOM = 8;

// ---- Location search with Nominatim ----
async function searchLocation(query: string): Promise<{ lat: number; lng: number; display_name: string }[]> {
  if (!query.trim()) return [];
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1`,
      { headers: { 'Accept-Language': 'de,en' } }
    );
    const data = await res.json();
    return data.map((r: any) => ({
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      display_name: r.display_name,
    }));
  } catch {
    return [];
  }
}

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const thumbnailTargetId = useRef<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const mapRef = useRef<any>(null);

  // --- New Project Dialog State ---
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectFiles, setNewProjectFiles] = useState<{ file: File; type: StoredProjectFile['type'] }[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const createFileInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // --- Location picker state ---
  const [locationSearch, setLocationSearch] = useState('');
  const [locationResults, setLocationResults] = useState<{ lat: number; lng: number; display_name: string }[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState<ProjectLocation | null>(null);
  const locationSearchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Map panel resize state ---
  const [mapPanelWidth, setMapPanelWidth] = useState(420);
  const isResizing = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  // --- Leaflet icon fix ---
  const [leafletReady, setLeafletReady] = useState(false);
  const [L, setL] = useState<any>(null);

  useEffect(() => {
    // Import leaflet and fix default marker icon
    import('leaflet').then((leaflet) => {
      // Fix default icon paths for webpack/next.js
      delete (leaflet.Icon.Default.prototype as any)._getIconUrl;
      leaflet.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
        iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
      });
      setL(leaflet);
      setLeafletReady(true);
    });
  }, []);

  // Load projects on mount
  useEffect(() => {
    setProjects(getProjects());
  }, []);

  // Import leaflet CSS
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
    document.head.appendChild(link);
    return () => { document.head.removeChild(link); };
  }, []);

  // Focus name input when dialog opens
  useEffect(() => {
    if (showCreateDialog && nameInputRef.current) {
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
  }, [showCreateDialog]);

  // Focus rename input when entering rename mode
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  // Close menu on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
      }
    };
    if (menuOpenId) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [menuOpenId]);

  // Debounced location search
  useEffect(() => {
    if (locationSearchTimeout.current) clearTimeout(locationSearchTimeout.current);
    if (!locationSearch.trim()) {
      setLocationResults([]);
      return;
    }
    setIsSearching(true);
    locationSearchTimeout.current = setTimeout(async () => {
      const results = await searchLocation(locationSearch);
      setLocationResults(results);
      setIsSearching(false);
    }, 400);
    return () => {
      if (locationSearchTimeout.current) clearTimeout(locationSearchTimeout.current);
    };
  }, [locationSearch]);

  // Fly map to selected project
  useEffect(() => {
    if (!selectedProjectId || !mapRef.current) return;
    const project = projects.find(p => p.id === selectedProjectId);
    if (project?.location) {
      mapRef.current.flyTo([project.location.lat, project.location.lng], 14, { duration: 1.2 });
    }
  }, [selectedProjectId, projects]);

  // --- Map panel resize handlers ---
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = mapPanelWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [mapPanelWidth]);

  useEffect(() => {
    const handleResizeMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = resizeStartX.current - e.clientX; // dragging left = wider
      const newWidth = Math.max(280, Math.min(800, resizeStartWidth.current + delta));
      setMapPanelWidth(newWidth);
    };

    const handleResizeEnd = () => {
      if (!isResizing.current) return;
      isResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleResizeMove);
    window.addEventListener('mouseup', handleResizeEnd);
    return () => {
      window.removeEventListener('mousemove', handleResizeMove);
      window.removeEventListener('mouseup', handleResizeEnd);
    };
  }, []);

  // Custom pin icon
  const projectIcon = useMemo(() => {
    if (!L) return undefined;
    return L.divIcon({
      className: 'custom-project-marker',
      html: `<div style="
        width: 32px; height: 32px;
        background: #2563eb;
        border: 3px solid white;
        border-radius: 50% 50% 50% 0;
        transform: rotate(-45deg);
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      "><div style="
        width: 100%; height: 100%;
        display: flex; align-items: center; justify-content: center;
        transform: rotate(45deg);
        color: white; font-size: 14px; font-weight: bold;
      ">P</div></div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 32],
      popupAnchor: [0, -32],
    });
  }, [L]);

  const selectedProjectIcon = useMemo(() => {
    if (!L) return undefined;
    return L.divIcon({
      className: 'custom-project-marker-selected',
      html: `<div style="
        width: 38px; height: 38px;
        background: #f59e0b;
        border: 3px solid white;
        border-radius: 50% 50% 50% 0;
        transform: rotate(-45deg);
        box-shadow: 0 3px 12px rgba(245,158,11,0.5);
      "><div style="
        width: 100%; height: 100%;
        display: flex; align-items: center; justify-content: center;
        transform: rotate(45deg);
        color: white; font-size: 16px; font-weight: bold;
      ">P</div></div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 38],
      popupAnchor: [0, -38],
    });
  }, [L]);

  // Filtered projects
  const filteredProjects = searchQuery
    ? projects.filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : projects;

  // Projects that have a location (for map pins)
  const locatedProjects = projects.filter(p => p.location);

  // --- Create Dialog Handlers ---
  const openCreateDialog = useCallback(() => {
    setNewProjectName('');
    setNewProjectFiles([]);
    setSelectedLocation(null);
    setLocationSearch('');
    setLocationResults([]);
    setShowCreateDialog(true);
  }, []);

  const closeCreateDialog = useCallback(() => {
    setShowCreateDialog(false);
    setNewProjectName('');
    setNewProjectFiles([]);
    setSelectedLocation(null);
    setLocationSearch('');
    setLocationResults([]);
  }, []);

  const addFilesToCreate = useCallback((files: FileList | File[]) => {
    const validFiles: { file: File; type: StoredProjectFile['type'] }[] = [];
    Array.from(files).forEach(file => {
      const type = getFileType(file.name);
      if (type) {
        validFiles.push({ file, type });
      }
    });
    setNewProjectFiles(prev => [...prev, ...validFiles]);
  }, []);

  const removeCreateFile = useCallback((index: number) => {
    setNewProjectFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleCreateProject = useCallback(async () => {
    const name = newProjectName.trim() || 'Untitled Project';
    const project = createProject(name, selectedLocation);

    // Convert files to stored format
    if (newProjectFiles.length > 0) {
      const storedFiles: StoredProjectFile[] = [];

      for (const { file, type } of newProjectFiles) {
        const content = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target?.result as string);
          if (type === 'png' || type === 'jpg' || type === 'pdf') {
            reader.readAsDataURL(file);
          } else {
            reader.readAsText(file);
          }
        });

        storedFiles.push({
          id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          name: file.name,
          type,
          content,
          source: 'drawing',
          createdAt: new Date().toISOString(),
        });
      }

      saveProjectFiles(project.id, storedFiles);
    }

    setProjects(getProjects());
    setShowCreateDialog(false);
    router.push(`/?project=${project.id}`);
  }, [newProjectName, newProjectFiles, selectedLocation, router]);

  // Select project (single click) - highlights + map flies
  const handleSelectProject = useCallback((id: string) => {
    setSelectedProjectId(prev => prev === id ? null : id);
  }, []);

  // Open project (double click or confirm)
  const handleOpen = useCallback((id: string) => {
    router.push(`/?project=${id}`);
  }, [router]);

  // Start rename
  const handleStartRename = useCallback((project: Project) => {
    setRenamingId(project.id);
    setRenameValue(project.name);
    setMenuOpenId(null);
  }, []);

  // Commit rename
  const handleCommitRename = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      updateProject(renamingId, { name: renameValue.trim() });
      setProjects(getProjects());
    }
    setRenamingId(null);
  }, [renamingId, renameValue]);

  // Trigger thumbnail upload
  const handleThumbnailClick = useCallback((projectId: string) => {
    thumbnailTargetId.current = projectId;
    setMenuOpenId(null);
    fileInputRef.current?.click();
  }, []);

  // Handle thumbnail file selection
  const handleThumbnailFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !thumbnailTargetId.current) return;
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new window.Image();
      img.onload = () => {
        const maxW = 400;
        const scale = Math.min(1, maxW / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

        if (thumbnailTargetId.current) {
          updateProject(thumbnailTargetId.current, { thumbnail: dataUrl });
          setProjects(getProjects());
        }
        thumbnailTargetId.current = null;
      };
      img.src = ev.target?.result as string;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }, []);

  // Delete project
  const handleDelete = useCallback((id: string) => {
    deleteProject(id);
    setProjects(getProjects());
    setDeleteConfirmId(null);
    setMenuOpenId(null);
    if (selectedProjectId === id) setSelectedProjectId(null);
  }, [selectedProjectId]);

  // Handle clicking on a map pin
  const handlePinClick = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    // Scroll to the card in the grid
    const el = document.getElementById(`project-card-${projectId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  // Select location from search results in create dialog
  const handleSelectLocationResult = useCallback((result: { lat: number; lng: number; display_name: string }) => {
    setSelectedLocation({
      lat: result.lat,
      lng: result.lng,
      address: result.display_name,
    });
    setLocationSearch(result.display_name);
    setLocationResults([]);
  }, []);

  return (
    <div className="flex flex-col h-screen w-full bg-gray-50 text-gray-900 font-sans">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 h-12 flex items-center px-6 shrink-0 z-50">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-sm shadow-sm">
            P
          </div>
          <span className="font-bold text-base tracking-tight">Prototype</span>
        </div>
        <nav className="ml-8 flex items-center gap-6 text-sm">
          <a href="/" className="text-gray-600 hover:text-gray-900 font-medium flex items-center gap-1">
            <ArrowLeft size={14} />
            Editor
          </a>
          <span className="text-blue-600 font-semibold">Projects</span>
        </nav>
      </header>

      {/* Main content: split layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel: project grid */}
        <div className="flex-1 overflow-auto min-w-0">
          <div className="max-w-4xl mx-auto px-6 py-6">
            {/* Title bar */}
            <div className="flex items-center justify-between mb-5">
              <div>
                <h1 className="text-xl font-bold text-gray-900">My Projects</h1>
                <p className="text-xs text-gray-500 mt-0.5">
                  {projects.length} {projects.length === 1 ? 'project' : 'projects'}
                  {locatedProjects.length > 0 && ` · ${locatedProjects.length} on map`}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {projects.length > 0 && (
                  <div className="relative">
                    <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search..."
                      className="pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent w-44"
                    />
                  </div>
                )}
                <button
                  onClick={openCreateDialog}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg flex items-center gap-1.5 shadow-sm transition-colors"
                >
                  <Plus size={15} />
                  New
                </button>
              </div>
            </div>

            {/* Empty state */}
            {projects.length === 0 && (
              <div className="flex flex-col items-center justify-center py-24">
                <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mb-5">
                  <FolderOpen size={32} className="text-gray-400" />
                </div>
                <h2 className="text-lg font-semibold text-gray-700 mb-2">No projects yet</h2>
                <p className="text-sm text-gray-500 mb-5 text-center max-w-sm">
                  Create your first project to start designing architectural plans and 3D models.
                </p>
                <button
                  onClick={openCreateDialog}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg flex items-center gap-2 shadow-sm transition-colors"
                >
                  <Plus size={18} />
                  Create your first project
                </button>
              </div>
            )}

            {/* Projects grid */}
            {filteredProjects.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredProjects.map((project) => (
                  <div
                    key={project.id}
                    id={`project-card-${project.id}`}
                    className={`group bg-white rounded-xl border-2 transition-all cursor-pointer relative ${
                      selectedProjectId === project.id
                        ? 'border-blue-500 shadow-lg shadow-blue-100 ring-2 ring-blue-200'
                        : 'border-gray-200 hover:shadow-lg hover:border-gray-300'
                    }`}
                    onClick={() => {
                      if (renamingId !== project.id && !menuOpenId) {
                        handleSelectProject(project.id);
                      }
                    }}
                    onDoubleClick={() => {
                      if (renamingId !== project.id && !menuOpenId) {
                        handleOpen(project.id);
                      }
                    }}
                  >
                    {/* Thumbnail */}
                    <div className="aspect-[16/10] bg-gray-100 relative overflow-hidden rounded-t-xl">
                      {project.thumbnail ? (
                        <img
                          src={project.thumbnail}
                          alt={project.name}
                          className="w-full h-full object-cover"
                          draggable={false}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <FolderOpen size={36} className="text-gray-300" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors" />

                      {/* Location badge */}
                      {project.location && (
                        <div className="absolute bottom-2 left-2 bg-white/90 backdrop-blur-sm rounded-full px-2 py-0.5 flex items-center gap-1 text-xs text-gray-600 shadow-sm">
                          <MapPin size={10} className="text-blue-600" />
                          <span className="truncate max-w-[120px]">
                            {project.location.address.split(',')[0]}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Info */}
                    <div className="p-3">
                      <div className="flex items-start justify-between gap-2">
                        {renamingId === project.id ? (
                          <input
                            ref={renameInputRef}
                            type="text"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={handleCommitRename}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleCommitRename();
                              if (e.key === 'Escape') setRenamingId(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-1 text-sm font-semibold text-gray-900 bg-blue-50 border border-blue-300 rounded px-1.5 py-0.5 outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        ) : (
                          <span
                            className="flex-1 text-sm font-semibold text-gray-900 truncate"
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              handleStartRename(project);
                            }}
                            title={project.name}
                          >
                            {project.name}
                          </span>
                        )}

                        {/* Three-dot menu */}
                        <div className="relative" ref={menuOpenId === project.id ? menuRef : undefined}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuOpenId(menuOpenId === project.id ? null : project.id);
                            }}
                            className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <MoreVertical size={16} />
                          </button>

                          {menuOpenId === project.id && (
                            <div className="absolute right-0 top-8 w-44 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50">
                              <button
                                onClick={(e) => { e.stopPropagation(); handleOpen(project.id); }}
                                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                              >
                                <Navigation size={14} /> Open
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleStartRename(project); }}
                                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                              >
                                <Pencil size={14} /> Rename
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleThumbnailClick(project.id); }}
                                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                              >
                                <ImageIcon size={14} /> Set Thumbnail
                              </button>
                              <div className="border-t border-gray-100 my-1" />
                              <button
                                onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(project.id); setMenuOpenId(null); }}
                                className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                              >
                                <Trash2 size={14} /> Delete
                              </button>
                            </div>
                          )}
                        </div>
                      </div>

                      <p className="text-xs text-gray-400 mt-1">
                        Updated {timeAgo(project.updatedAt)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* No search results */}
            {searchQuery && filteredProjects.length === 0 && projects.length > 0 && (
              <div className="text-center py-16">
                <p className="text-gray-500 text-sm">No projects matching &quot;{searchQuery}&quot;</p>
              </div>
            )}
          </div>
        </div>

        {/* Right panel: Map */}
        <div
          className="shrink-0 flex flex-col p-3 pl-0 relative"
          style={{ width: mapPanelWidth }}
        >
          {/* Resize handle */}
          <div
            className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-10 group flex items-center justify-center"
            onMouseDown={handleResizeStart}
          >
            <div className="w-1 h-12 bg-gray-300 group-hover:bg-blue-400 group-active:bg-blue-500 rounded-full transition-colors" />
          </div>

          {/* Map box */}
          <div className="flex-1 flex flex-col bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden ml-2">
            {/* Map header */}
            <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                <MapPin size={15} className="text-blue-600" />
                Project Map
              </div>
              <span className="text-xs text-gray-400">
                {locatedProjects.length} {locatedProjects.length === 1 ? 'pin' : 'pins'}
              </span>
            </div>

            {/* Map content */}
            <div className="flex-1 relative rounded-b-xl overflow-hidden">
              {leafletReady && (
                <MapContainerWrapper
                  projects={locatedProjects}
                  selectedProjectId={selectedProjectId}
                  projectIcon={projectIcon}
                  selectedProjectIcon={selectedProjectIcon}
                  onPinClick={handlePinClick}
                  onPinDoubleClick={handleOpen}
                  mapRef={mapRef}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Hidden file input for thumbnail upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={handleThumbnailFile}
      />

      {/* Hidden file input for create dialog */}
      <input
        ref={createFileInputRef}
        type="file"
        accept={ACCEPT_STRING}
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) addFilesToCreate(e.target.files);
          e.target.value = '';
        }}
      />

      {/* ===== NEW PROJECT DIALOG ===== */}
      {showCreateDialog && (
        <div
          className="fixed inset-0 bg-black/40 z-[200] flex items-center justify-center"
          onClick={closeCreateDialog}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Dialog header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-lg font-bold text-gray-900">New Project</h2>
              <button
                onClick={closeCreateDialog}
                className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Dialog body */}
            <div className="px-6 py-5 space-y-5">
              {/* Project name */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                  Project Name
                </label>
                <input
                  ref={nameInputRef}
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newProjectName.trim()) {
                      handleCreateProject();
                    }
                  }}
                  placeholder="e.g. Wohnhaus Müller, Bürogebäude Zürich..."
                  className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-gray-400"
                />
              </div>

              {/* Location picker */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                  Location <span className="font-normal text-gray-400">(optional)</span>
                </label>
                <div className="relative">
                  <MapPin size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    value={locationSearch}
                    onChange={(e) => {
                      setLocationSearch(e.target.value);
                      if (selectedLocation) setSelectedLocation(null);
                    }}
                    placeholder="Search address or place..."
                    className="w-full pl-9 pr-3 py-2.5 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-gray-400"
                  />
                  {isSearching && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                </div>

                {/* Search results dropdown */}
                {locationResults.length > 0 && !selectedLocation && (
                  <div className="mt-1 border border-gray-200 rounded-lg bg-white shadow-lg max-h-48 overflow-auto">
                    {locationResults.map((result, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleSelectLocationResult(result)}
                        className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 flex items-start gap-2 border-b border-gray-50 last:border-0"
                      >
                        <MapPin size={14} className="text-gray-400 mt-0.5 shrink-0" />
                        <span className="line-clamp-2">{result.display_name}</span>
                      </button>
                    ))}
                  </div>
                )}

                {/* Selected location indicator */}
                {selectedLocation && (
                  <div className="mt-2 flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm">
                    <MapPin size={14} className="text-blue-600 shrink-0" />
                    <span className="flex-1 truncate text-blue-800">
                      {selectedLocation.address.split(',').slice(0, 3).join(',')}
                    </span>
                    <span className="text-xs text-blue-500">
                      {selectedLocation.lat.toFixed(4)}, {selectedLocation.lng.toFixed(4)}
                    </span>
                    <button
                      onClick={() => {
                        setSelectedLocation(null);
                        setLocationSearch('');
                      }}
                      className="p-0.5 rounded hover:bg-blue-100 text-blue-400 hover:text-blue-600"
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
              </div>

              {/* File upload area */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                  Project Files <span className="font-normal text-gray-400">(optional)</span>
                </label>

                {/* Drop zone */}
                <div
                  className={`border-2 border-dashed rounded-xl p-5 text-center transition-colors ${
                    isDragOver
                      ? 'border-blue-400 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300 bg-gray-50'
                  }`}
                  onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                  onDragLeave={() => setIsDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDragOver(false);
                    if (e.dataTransfer.files.length > 0) {
                      addFilesToCreate(e.dataTransfer.files);
                    }
                  }}
                  onClick={() => createFileInputRef.current?.click()}
                >
                  <Upload size={22} className={`mx-auto mb-2 ${isDragOver ? 'text-blue-500' : 'text-gray-400'}`} />
                  <p className="text-sm text-gray-600">
                    Drop files here or <span className="text-blue-600 font-medium cursor-pointer">browse</span>
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    DXF, SVG, PDF, PNG, JPG, GLB, IFC
                  </p>
                </div>

                {/* File list */}
                {newProjectFiles.length > 0 && (
                  <div className="mt-3 space-y-1.5 max-h-32 overflow-auto">
                    {newProjectFiles.map((item, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-2 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-sm"
                      >
                        <span className="text-base">{getFileIcon(item.type)}</span>
                        <span className="flex-1 truncate text-gray-700">{item.file.name}</span>
                        <span className="text-xs text-gray-400 uppercase">{item.type}</span>
                        <span className="text-xs text-gray-400">
                          {(item.file.size / 1024).toFixed(0)} KB
                        </span>
                        <button
                          onClick={() => removeCreateFile(index)}
                          className="p-0.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Dialog footer */}
            <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex justify-end gap-3">
              <button
                onClick={closeCreateDialog}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateProject}
                disabled={!newProjectName.trim()}
                className={`px-5 py-2 text-sm font-medium text-white rounded-lg flex items-center gap-2 transition-colors ${
                  newProjectName.trim()
                    ? 'bg-blue-600 hover:bg-blue-700 shadow-sm'
                    : 'bg-gray-300 cursor-not-allowed'
                }`}
              >
                <Plus size={16} />
                Create Project
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirmId && (() => {
        const project = projects.find(p => p.id === deleteConfirmId);
        if (!project) return null;
        return (
          <div
            className="fixed inset-0 bg-black/40 z-[200] flex items-center justify-center"
            onClick={() => setDeleteConfirmId(null)}
          >
            <div
              className="bg-white rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Delete project?</h3>
              <p className="text-sm text-gray-500 mb-6">
                &quot;{project.name}&quot; will be permanently deleted. This action cannot be undone.
              </p>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setDeleteConfirmId(null)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDelete(project.id)}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ---- Map wrapper component (handles react-leaflet properly) ----
function MapContainerWrapper({
  projects,
  selectedProjectId,
  projectIcon,
  selectedProjectIcon,
  onPinClick,
  onPinDoubleClick,
  mapRef,
}: {
  projects: Project[];
  selectedProjectId: string | null;
  projectIcon: any;
  selectedProjectIcon: any;
  onPinClick: (id: string) => void;
  onPinDoubleClick: (id: string) => void;
  mapRef: React.MutableRefObject<any>;
}) {
  const [components, setComponents] = useState<any>(null);

  useEffect(() => {
    // Dynamically import all react-leaflet components
    Promise.all([
      import('react-leaflet'),
      import('leaflet'),
    ]).then(([rl, L]) => {
      setComponents({ rl, L: L.default || L });
    });
  }, []);

  if (!components) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
          <p className="text-sm text-gray-500">Loading map...</p>
        </div>
      </div>
    );
  }

  const { MapContainer, TileLayer, Marker, Popup } = components.rl;

  return (
    <MapContainer
      center={DEFAULT_CENTER}
      zoom={DEFAULT_ZOOM}
      style={{ height: '100%', width: '100%' }}
      ref={(map: any) => {
        if (map) mapRef.current = map;
      }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {/* Project markers */}
      {projects.map((project) => {
        if (!project.location) return null;
        const isSelected = project.id === selectedProjectId;
        return (
          <Marker
            key={project.id}
            position={[project.location.lat, project.location.lng]}
            icon={isSelected ? selectedProjectIcon : projectIcon}
            eventHandlers={{
              click: () => onPinClick(project.id),
              dblclick: () => onPinDoubleClick(project.id),
            }}
          >
            <Popup>
              <div className="text-center min-w-[140px]">
                <p className="font-semibold text-sm">{project.name}</p>
                <p className="text-xs text-gray-500 mt-1">
                  {project.location.address.split(',').slice(0, 2).join(',')}
                </p>
                <button
                  onClick={() => onPinDoubleClick(project.id)}
                  className="mt-2 px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded transition-colors"
                >
                  Open Project
                </button>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}

