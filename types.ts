export type RedactionType = 'mosaic' | 'blur' | 'blackout' | 'whiteout' | 'pen' | 'rectangle' | 'text';

export interface Point {
  x: number;
  y: number;
}

export interface AnnotationObject {
  id: string;
  pageIndex: number;
  x: number;      // PDF Coordinate (Points) - For Rect/Text/Image
  y: number;      // PDF Coordinate (Points)
  width: number;  // PDF Dimensions
  height: number; // PDF Dimensions
  type: RedactionType;
  
  // Extra properties for specific tools
  path?: Point[];     // For Pen
  text?: string;      // For Text
  color?: string;     // For Pen/Rect/Text
  fontSize?: number;  // For Text
  strokeWidth?: number; // For Pen/Rect
}

export interface DocumentSession {
  id: string;
  name: string;
  file: File;
  pdfProxy: any;
  pdfBuffer: ArrayBuffer;
  numPages: number;
  currIndex: number;
  scale: number;
  annotations: AnnotationObject[]; // Renamed from redactions
  redoStack: AnnotationObject[];   // Stack for redo operations
}

export interface ProcessingState {
  isProcessing: boolean;
  message: string;
}

export type ToolMode = 'view' | 'edit';

export interface Viewport {
  width: number;
  height: number;
  scale: number;
  convertToViewportPoint: (x: number, y: number) => [number, number];
  convertToPdfPoint: (x: number, y: number) => [number, number];
}