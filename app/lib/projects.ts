// Project data model & localStorage CRUD helpers

export interface ProjectLocation {
  lat: number;
  lng: number;
  address: string;          // human-readable address
}

export interface Project {
  id: string;
  name: string;
  thumbnail: string | null;     // base64 data URL
  location: ProjectLocation | null;
  createdAt: string;            // ISO date string
  updatedAt: string;            // ISO date string
}

const STORAGE_KEY = 'arch-drawer-projects';

function generateId(): string {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export function getProjects(): Project[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Project[];
  } catch {
    return [];
  }
}

function saveProjects(projects: Project[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

export function getProject(id: string): Project | null {
  return getProjects().find(p => p.id === id) ?? null;
}

export function createProject(name: string, location?: ProjectLocation | null): Project {
  const now = new Date().toISOString();
  const project: Project = {
    id: generateId(),
    name,
    thumbnail: null,
    location: location ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const projects = getProjects();
  projects.unshift(project); // newest first
  saveProjects(projects);
  return project;
}

export function updateProject(id: string, updates: Partial<Omit<Project, 'id' | 'createdAt'>>): Project | null {
  const projects = getProjects();
  const index = projects.findIndex(p => p.id === id);
  if (index === -1) return null;

  projects[index] = {
    ...projects[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  saveProjects(projects);
  return projects[index];
}

export function deleteProject(id: string): void {
  const projects = getProjects().filter(p => p.id !== id);
  saveProjects(projects);
  deleteProjectFiles(id);
}

// --- Project Files Storage ---
// Stored separately per project to avoid bloating the project list

export interface StoredProjectFile {
  id: string;
  name: string;
  type: 'dxf' | 'svg' | 'pdf' | 'png' | 'jpg' | 'glb' | 'ifc';
  content?: string; // base64 for images, text for others
  source: 'construction' | 'simulation' | 'drawing' | 'elemente';
  createdAt: string;
}

function projectFilesKey(projectId: string): string {
  return `arch-drawer-files-${projectId}`;
}

export function getProjectFiles(projectId: string): StoredProjectFile[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(projectFilesKey(projectId));
    if (!raw) return [];
    return JSON.parse(raw) as StoredProjectFile[];
  } catch {
    return [];
  }
}

export function saveProjectFiles(projectId: string, files: StoredProjectFile[]): void {
  localStorage.setItem(projectFilesKey(projectId), JSON.stringify(files));
}

export function deleteProjectFiles(projectId: string): void {
  localStorage.removeItem(projectFilesKey(projectId));
}

/** Human-readable relative time (e.g. "2 hours ago", "3 days ago") */
export function timeAgo(isoDate: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
