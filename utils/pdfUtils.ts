import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { RedactionRect } from '../types';

// Initialize PDF.js worker securely
const pdfJs = (pdfjsLib as any).default || pdfjsLib;
if (pdfJs.GlobalWorkerOptions) {
    pdfJs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js`;
}

export const loadPdfDocument = async (file: File) => {
  const buffer = await file.arrayBuffer();
  // CRITICAL FIX: PDF.js transfers the buffer to the worker, detaching the original.
  // We must pass a copy to PDF.js so we keep the original 'buffer' valid for saving later.
  const bufferForWorker = buffer.slice(0);
  
  const loadingTask = pdfJs.getDocument({ data: bufferForWorker });
  const pdfProxy = await loadingTask.promise;
  
  return { proxy: pdfProxy, buffer };
};

export const renderPage = async (
  page: any,
  canvas: HTMLCanvasElement,
  scale: number
) => {
  const viewport = page.getViewport({ scale });
  const context = canvas.getContext('2d', { willReadFrequently: true });
  
  if (!context) throw new Error('Canvas context missing');

  // Reset transform to identity before resizing
  context.setTransform(1, 0, 0, 1, 0, 0);
  
  canvas.height = viewport.height;
  canvas.width = viewport.width;

  const renderContext = {
    canvasContext: context,
    viewport: viewport,
  };

  await page.render(renderContext).promise;
  return viewport;
};

// Applies pixelation to a specific rect on the canvas (UI only)
export const applyMosaicEffect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  blockSize: number = 8
) => {
  if (w <= 0 || h <= 0) return;
  
  // Create a tiny offscreen canvas to downscale the region
  const offCanvas = document.createElement('canvas');
  const offCtx = offCanvas.getContext('2d');
  if (!offCtx) return;

  const scaledW = Math.max(1, Math.floor(w / blockSize));
  const scaledH = Math.max(1, Math.floor(h / blockSize));

  offCanvas.width = scaledW;
  offCanvas.height = scaledH;

  // Draw source -> tiny canvas (downsample)
  offCtx.imageSmoothingEnabled = false;
  offCtx.drawImage(ctx.canvas, x, y, w, h, 0, 0, scaledW, scaledH);

  // Draw tiny canvas -> source (upsample with nearest neighbor)
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(offCanvas, 0, 0, scaledW, scaledH, x, y, w, h);
  
  // Add a subtle border to make it clear where the redaction is
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.1)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  
  ctx.restore();
};

export const saveRedactedPdf = async (
  originalPdfBuffer: ArrayBuffer,
  redactions: RedactionRect[]
): Promise<Uint8Array> => {
  // Defensive check for detached buffer
  if (originalPdfBuffer.byteLength === 0) {
    throw new Error("PDF Buffer is empty. Please reload the file.");
  }

  const pdfDoc = await PDFDocument.load(originalPdfBuffer);
  const pages = pdfDoc.getPages();

  // Group redactions by page
  const redMap = new Map<number, RedactionRect[]>();
  redactions.forEach(r => {
    const list = redMap.get(r.pageIndex) || [];
    list.push(r);
    redMap.set(r.pageIndex, list);
  });

  // Since we cannot easily reuse the PDF.js instance due to worker transfer issues in saving context,
  // We reload the doc into PDF.js specifically for the "Burn-in" rendering process.
  // We use a fresh copy of the buffer.
  const bufferCopy = originalPdfBuffer.slice(0);
  const pdfJsDoc = await pdfJs.getDocument({ data: bufferCopy }).promise;

  // Process each page that has redactions
  for (const [pageIndex, rects] of redMap.entries()) {
    const pdfPage = pages[pageIndex];
    if (!pdfPage) continue;

    // Use pdfjs to render the page at high quality
    const pageProxy = await pdfJsDoc.getPage(pageIndex + 1);
    
    const scale = 2.0; // Higher scale for better quality
    const viewport = pageProxy.getViewport({ scale });
    
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    
    await pageProxy.render({ canvasContext: ctx, viewport }).promise;

    for (const rect of rects) {
      // PDF Coordinates (Bottom-Left origin) -> Canvas Coordinates (Top-Left origin)
      const pdfYTop = rect.y + rect.height; // Top edge in PDF coords
      
      const [vx, vy] = viewport.convertToViewportPoint(rect.x, pdfYTop);
      
      const vw = rect.width * scale;
      const vh = rect.height * scale;

      // Create patch
      const patchCanvas = document.createElement('canvas');
      patchCanvas.width = vw;
      patchCanvas.height = vh;
      const patchCtx = patchCanvas.getContext('2d');
      
      if (patchCtx) {
        // Pixelate logic
        const blockSize = 12 * scale;
        const sw = Math.max(1, Math.floor(vw / blockSize));
        const sh = Math.max(1, Math.floor(vh / blockSize));
        
        const tempC = document.createElement('canvas');
        tempC.width = sw;
        tempC.height = sh;
        const tempCtx = tempC.getContext('2d');
        
        if (tempCtx) {
            tempCtx.imageSmoothingEnabled = false;
            // Capture original content from the full page render
            tempCtx.drawImage(canvas, vx, vy, vw, vh, 0, 0, sw, sh);
            
            // Draw back to patch
            patchCtx.imageSmoothingEnabled = false;
            patchCtx.drawImage(tempC, 0, 0, sw, sh, 0, 0, vw, vh);
        }
        
        // Convert to PNG and embed
        const pngImage = await pdfDoc.embedPng(patchCanvas.toDataURL('image/png'));
        
        // Draw the image onto the PDF page
        pdfPage.drawImage(pngImage, {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
      }
    }
  }

  return await pdfDoc.save();
};

export const canvasToBase64 = (canvas: HTMLCanvasElement) => {
    return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
}