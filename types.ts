export interface RedactionRect {
  id: string;
  pageIndex: number;
  x: number;      // PDF Coordinate (Points, from left)
  y: number;      // PDF Coordinate (Points, from bottom)
  width: number;  // PDF Dimensions (Points)
  height: number; // PDF Dimensions (Points)
}

export interface ProcessingState {
  isProcessing: boolean;
  message: string;
}

export type ToolMode = 'view' | 'mosaic';

export interface Viewport {
  width: number;
  height: number;
  scale: number;
  convertToViewportPoint: (x: number, y: number) => [number, number];
  convertToPdfPoint: (x: number, y: number) => [number, number];
}