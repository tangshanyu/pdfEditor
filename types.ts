export interface RedactionRect {
  id: string;
  pageIndex: number;
  x: number; // PDF Coordinate system (Points)
  y: number; // PDF Coordinate system (Points)
  width: number; // PDF Coordinate system (Points)
  height: number; // PDF Coordinate system (Points)
}

export interface PDFDimensions {
  width: number;
  height: number;
}

export enum ToolMode {
  SELECT = 'SELECT',
  MOSAIC = 'MOSAIC',
}

export interface ProcessingState {
  isProcessing: boolean;
  message: string;
}