// Shared Presentation data model & serialization helpers
// Used for sharing presentations via /share/[id] links

export interface SharedPresentation {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  slides: SharedSlide[];
  models: SharedModel[];
  pdfFilename: string | null;
  pdfUrl?: string; // Direct Vercel Blob URL for the PDF
}

export interface SharedModel {
  id: string;
  name: string;
  type: 'building' | 'environment' | 'splat' | 'paired';
  glbFilename: string;
  glbUrl?: string; // Direct Vercel Blob URL for the GLB file
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}

export interface SharedSlide {
  id: string;
  name: string;
  modelIds: string[];
  hotspots: SharedHotspot[];
  sectionCut?: {
    enabled: boolean;
    height: number;
    showPlane: boolean;
  };
}

export interface SharedHotspot {
  id: string;
  name: string;
  description?: string;
  position: { x: number; y: number; z: number };
  savedView: {
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
  } | null;
  color: string;
  sectionCutAction?: { enabled: boolean; height: number };
  linkedImage?: string;
}

export function generateShareId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
