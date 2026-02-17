export enum ToolType {
  SELECT = 'SELECT',
  WALL = 'WALL',
  WINDOW = 'WINDOW',
  DOOR = 'DOOR',
  PEN = 'PEN',
  LASER = 'LASER', // Laser Measure Tool
  CALIBRATE = 'CALIBRATE'
}

export enum WallJustification {
  CENTER = 'center',
  LEFT = 'left',
  RIGHT = 'right'
}

export enum WindowType {
  SINGLE = 'single',
  DOUBLE_VERTICAL = 'double_vertical',
  TRIPLE_VERTICAL = 'triple_vertical',
  DOUBLE_HORIZONTAL = 'double_horizontal',
  TRIPLE_HORIZONTAL = 'triple_horizontal'
}

export enum DoorType {
  SINGLE_SWING = 'single_swing',
  DOUBLE_SWING = 'double_swing',
  SINGLE_SLIDE = 'single_slide',
  DOUBLE_SLIDE = 'double_slide'
}

export interface Point {
  x: number;
  y: number;
}

export interface ElementProps {
  id: number;
  start: Point;
  end: Point;
}

// --- GEOMETRY ENGINE ---

export function getDistance(p1: Point, p2: Point): number {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
}

// Find intersection of two infinite lines defined by (p1-p2) and (p3-p4)
export function getLineIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
  const x3 = p3.x, y3 = p3.y, x4 = p4.x, y4 = p4.y;

  const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
  if (denom === 0) return null; // Parallel lines

  const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
  return {
    x: x1 + ua * (x2 - x1),
    y: y1 + ua * (y2 - y1)
  };
}

export function arePointsEqual(p1: Point, p2: Point, tolerance = 1): boolean {
  return Math.abs(p1.x - p2.x) < tolerance && Math.abs(p1.y - p2.y) < tolerance;
}

export function resizeElement(start: Point, end: Point, newLengthMeters: number, pixelsPerMeter: number): Point {
  const currentLenPx = getDistance(start, end);
  const targetLenPx = newLengthMeters * pixelsPerMeter;
  if (currentLenPx === 0) return { x: start.x + targetLenPx, y: start.y };
  
  const ratio = targetLenPx / currentLenPx;
  return {
    x: start.x + (end.x - start.x) * ratio,
    y: start.y + (end.y - start.y) * ratio
  };
}

export function getRectCorners(start: Point, end: Point, thickness: number, justification: WallJustification = WallJustification.CENTER): Point[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [start, start, start, start];
  
  const nx = -dy / len;
  const ny = dx / len;

  let offsetLeft = 0;
  let offsetRight = 0;

  switch (justification) {
    case WallJustification.CENTER:
      offsetLeft = thickness / 2;
      offsetRight = thickness / 2;
      break;
    case WallJustification.LEFT:
      offsetLeft = thickness;
      offsetRight = 0;
      break;
    case WallJustification.RIGHT:
      offsetLeft = 0;
      offsetRight = thickness;
      break;
  }

  // Returns: [TopLeft, TopRight, BottomRight, BottomLeft]
  return [
    { x: start.x + nx * offsetLeft, y: start.y + ny * offsetLeft },   // 0
    { x: end.x + nx * offsetLeft, y: end.y + ny * offsetLeft },       // 1
    { x: end.x - nx * offsetRight, y: end.y - ny * offsetRight },     // 2
    { x: start.x - nx * offsetRight, y: start.y - ny * offsetRight }  // 3
  ];
}

export function projectPointOnLine(p: Point, start: Point, end: Point): Point {
  const A = p.x - start.x;
  const B = p.y - start.y;
  const C = end.x - start.x;
  const D = end.y - start.y;
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = -1;
  if (lenSq !== 0) param = dot / lenSq;
  if (param < 0) return start;
  if (param > 1) return end;
  return { x: start.x + param * C, y: start.y + param * D };
}

export function generateRectPolygon(start: Point, end: Point, thickness: number, justification?: WallJustification): string {
  const corners = getRectCorners(start, end, thickness, justification);
  return corners.map(p => `${p.x},${p.y}`).join(' ');
}

// --- CLASSES ---

const PIX_TO_M = 0.01; // Global constant: 100px = 1m (so 1px = 0.01m)

export abstract class ArchitecturalElement {
  id: number;
  start: Point;
  end: Point;
  readonly type: ToolType;
  thickness: number = 20;

  constructor(type: ToolType, props: ElementProps) {
    this.type = type;
    this.id = props.id;
    this.start = props.start;
    this.end = props.end;
  }

  get corners(): Point[] { return getRectCorners(this.start, this.end, this.thickness, WallJustification.CENTER); }
  get length(): number { return getDistance(this.start, this.end); }

  abstract generateUniqueID(): string;
  abstract getDetails(): string;
}

export class Wall extends ArchitecturalElement {
  height: number;
  justification: WallJustification;

  constructor(props: ElementProps, config: any) {
    super(ToolType.WALL, props);
    this.height = Number(config.wallHeight);
    this.thickness = config.wallThickness ? Number(config.wallThickness) : 20; 
    this.justification = config.wallJustification || WallJustification.CENTER;
  }
  
  get corners(): Point[] { return getRectCorners(this.start, this.end, this.thickness, this.justification); }
  
  // Wall ID: id-height(cm)
  // Walls generally don't need 'w' prefix for the script unless specific template matching is required,
  // but standard pipeline treats "wall" as default.
  generateUniqueID(): string { return `${this.id}-${this.height}`; }
  getDetails(): string { return `Wall (H:${this.height})`; }
}

export class WindowElement extends ArchitecturalElement {
  windowType: WindowType;
  sillHeight: number;
  windowHeight: number;
  constructor(props: ElementProps, config: any) {
    super(ToolType.WINDOW, props);
    this.windowType = config.windowType;
    this.sillHeight = Number(config.sillHeight);
    this.windowHeight = Number(config.windowHeight);
    this.thickness = 15;
  }
  
  // Format: w{id}-{type}-{widthM}-{sillM}-{heightM}
  // All dimensions converted to Meters for Blender script compatibility
  generateUniqueID(): string { 
    const w = (this.length * PIX_TO_M).toFixed(2);
    const s = (this.sillHeight * PIX_TO_M).toFixed(2); // sillHeight input is cm (e.g. 90) -> 0.90
    const h = (this.windowHeight * PIX_TO_M).toFixed(2);
    return `w${this.id}-${this.windowType}-${w}-${s}-${h}`; 
  }
  getDetails(): string { return `Window (${this.windowType})`; }
}

export class Door extends ArchitecturalElement {
  doorType: DoorType;
  height: number;
  constructor(props: ElementProps, config: any) {
    super(ToolType.DOOR, props);
    this.doorType = config.doorType;
    this.height = Number(config.doorHeight);
    this.thickness = 15;
  }

  // Format: d{id}-{type}-{widthM}-{heightM}
  // All dimensions converted to Meters for Blender script compatibility
  generateUniqueID(): string { 
    const w = (this.length * PIX_TO_M).toFixed(2);
    const h = (this.height * PIX_TO_M).toFixed(2);
    return `d${this.id}-${this.doorType}-${w}-${h}`; 
  }
  getDetails(): string { return `Door (${this.doorType})`; }
}

export class ElementFactory {
  static create(tool: ToolType, props: ElementProps, config: any): ArchitecturalElement {
    // Pen tool draws walls
    const effectiveTool = tool === ToolType.PEN ? ToolType.WALL : tool;
    
    switch (effectiveTool) {
      case ToolType.WALL: return new Wall(props, config);
      case ToolType.WINDOW: return new WindowElement(props, config);
      case ToolType.DOOR: return new Door(props, config);
      default: throw new Error("Unknown Tool Type");
    }
  }
}