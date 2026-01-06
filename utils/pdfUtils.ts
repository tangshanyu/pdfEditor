import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { RedactionRect } from '../types';

// Initialize PDF.js worker
// Using version 4.0.379 to match the stable version in importmap
// Using unpkg for the worker ensures better stability and avoids some ESM shim issues in worker context
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs`;

export const loadPdf = async (file: File): Promise<ArrayBuffer> => {
  return await file.arrayBuffer();
};

export const getPdfPage = async (pdfData: ArrayBuffer, pageIndex: number) => {
  const loadingTask = pdfjsLib.getDocument({ data: pdfData });
  const pdf = await loadingTask.promise;
  return await pdf.getPage(pageIndex + 1); // pdfjs uses 1-based indexing
};

export const renderPageToCanvas = async (
  page: any,
  canvas: HTMLCanvasElement,
  scale: number = 1.5
) => {
  const viewport = page.getViewport({ scale });
  const context = canvas.getContext('2d');
  
  if (!context) throw new Error('Canvas context not found');

  canvas.height = viewport.height;
  canvas.width = viewport.width;

  const renderContext = {
    canvasContext: context,
    viewport: viewport,
  };

  await page.render(renderContext).promise;
  return viewport;
};

// Applies a pixelation effect to a specific region of a canvas
export const pixelateCanvasRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  pixelSize: number = 10
) => {
  if (width <= 0 || height <= 0) return;

  // 1. Draw the image smaller (downscale)
  // We use a temporary offscreen canvas to process the image data
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) return;

  const w = Math.max(1, Math.floor(width / pixelSize));
  const h = Math.max(1, Math.floor(height / pixelSize));

  tempCanvas.width = w;
  tempCanvas.height = h;

  // Draw the source region into the tiny canvas
  tempCtx.imageSmoothingEnabled = false;
  tempCtx.drawImage(ctx.canvas, x, y, width, height, 0, 0, w, h);

  // 2. Draw it back larger (upscale) with smoothing disabled
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tempCanvas, 0, 0, w, h, x, y, width, height);
  ctx.restore();
};

export const savePdfWithRedactions = async (
  originalPdfBytes: ArrayBuffer,
  redactions: RedactionRect[]
): Promise<Uint8Array> => {
  const pdfDoc = await PDFDocument.load(originalPdfBytes);
  const pages = pdfDoc.getPages();

  // Group redactions by page for efficiency
  const redactionsByPage: Record<number, RedactionRect[]> = {};
  redactions.forEach(r => {
    if (!redactionsByPage[r.pageIndex]) redactionsByPage[r.pageIndex] = [];
    redactionsByPage[r.pageIndex].push(r);
  });

  for (const pageIndexStr in redactionsByPage) {
    const pageIndex = parseInt(pageIndexStr);
    const pageRedactions = redactionsByPage[pageIndex];
    const pdfPage = pages[pageIndex];
    
    // Render page to canvas to grab image data for the mosaic patch
    // High scale for better quality text in the mosaic if partially readable
    const scale = 2.0;
    const pdfJsPage = await getPdfPage(originalPdfBytes, pageIndex);
    const canvas = document.createElement('canvas');
    const viewport = await renderPageToCanvas(pdfJsPage, canvas, scale);
    const ctx = canvas.getContext('2d');
    
    if (!ctx) continue;

    for (const rect of pageRedactions) {
      // Use viewport to convert PDF Point coords (Bottom-Left origin) to Canvas Pixel coords (Top-Left origin)
      // Standard PDF Rect: (x, y) is bottom-left corner
      // Top-Left of Rect in PDF space: (x, y + height)
      // Bottom-Right of Rect in PDF space: (x + width, y)
      
      const [x1, y1] = viewport.convertToViewportPoint(rect.x, rect.y + rect.height);
      const [x2, y2] = viewport.convertToViewportPoint(rect.x + rect.width, rect.y);
      
      const canvasX = Math.min(x1, x2);
      const canvasY = Math.min(y1, y2);
      const canvasW = Math.abs(x2 - x1);
      const canvasH = Math.abs(y2 - y1);

      // Create a temporary canvas for just this redaction area
      const patchCanvas = document.createElement('canvas');
      patchCanvas.width = canvasW;
      patchCanvas.height = canvasH;
      const patchCtx = patchCanvas.getContext('2d');
      
      if (patchCtx) {
        // Pixelate on the patch
        patchCtx.imageSmoothingEnabled = false;
        
        // Downscale
        const pixelSize = 15 * scale; // Adjust pixel size by scale
        const wSmall = Math.max(1, Math.ceil(canvasW / pixelSize));
        const hSmall = Math.max(1, Math.ceil(canvasH / pixelSize));
        
        const tempSmall = document.createElement('canvas');
        tempSmall.width = wSmall;
        tempSmall.height = hSmall;
        const tempSmallCtx = tempSmall.getContext('2d');
        
        if (tempSmallCtx) {
           tempSmallCtx.drawImage(canvas, canvasX, canvasY, canvasW, canvasH, 0, 0, wSmall, hSmall);
           // Upscale to patch
           patchCtx.drawImage(tempSmall, 0, 0, wSmall, hSmall, 0, 0, canvasW, canvasH);
           
           // Get PNG data
           const patchDataUrl = patchCanvas.toDataURL('image/png');
           
           // Embed in PDF
           const pngImage = await pdfDoc.embedPng(patchDataUrl);
           
           // Draw on PDF Page using standard PDF coordinates (Bottom-Left origin)
           pdfPage.drawImage(pngImage, {
             x: rect.x,
             y: rect.y,
             width: rect.width,
             height: rect.height,
           });
        }
      }
    }
  }

  return await pdfDoc.save();
};

export const getBase64FromCanvas = (canvas: HTMLCanvasElement): string => {
    return canvas.toDataURL('image/jpeg').split(',')[1];
};