import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { AnnotationObject, RedactionType } from '../types';

// Initialize PDF.js worker securely
const pdfJs = (pdfjsLib as any).default || pdfjsLib;
if (pdfJs.GlobalWorkerOptions) {
    pdfJs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js`;
}

export const loadPdfDocument = async (file: File) => {
  const buffer = await file.arrayBuffer();
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

// Unified function to render any annotation on Canvas
export const renderAnnotationOnCanvas = (
  ctx: CanvasRenderingContext2D,
  ann: AnnotationObject,
  viewport: any
) => {
  // Convert coords
  let x, y, w, h;
  
  // For standard box-based annotations
  if (ann.type !== 'pen') {
      const [x1, y1] = viewport.convertToViewportPoint(ann.x, ann.y + ann.height);
      const [x2, y2] = viewport.convertToViewportPoint(ann.x + ann.width, ann.y);
      x = Math.min(x1, x2);
      y = Math.min(y1, y2);
      w = Math.abs(x2 - x1);
      h = Math.abs(y2 - y1);
  }

  ctx.save();

  if (ann.type === 'pen' && ann.path) {
    ctx.beginPath();
    let first = true;
    for (const p of ann.path) {
        // Path points are stored in PDF coords, need to convert each
        // PDF (0,0) is bottom-left.
        // We stored them as raw PDF points.
        // convertToViewportPoint handles the Y-flip.
        const [vx, vy] = viewport.convertToViewportPoint(p.x, p.y);
        if (first) {
            ctx.moveTo(vx, vy);
            first = false;
        } else {
            ctx.lineTo(vx, vy);
        }
    }
    ctx.strokeStyle = ann.color || '#ff0000';
    ctx.lineWidth = (ann.strokeWidth || 2) * viewport.scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

  } else if (ann.type === 'rectangle') {
    ctx.strokeStyle = ann.color || '#ff0000';
    ctx.lineWidth = (ann.strokeWidth || 2) * viewport.scale;
    ctx.strokeRect(x!, y!, w!, h!);

  } else if (ann.type === 'text' && ann.text) {
    const fontSize = (ann.fontSize || 12) * viewport.scale;
    ctx.font = `${fontSize}px sans-serif`;
    ctx.fillStyle = ann.color || '#000000';
    ctx.textBaseline = 'top';
    // Text X,Y in PDF is usually bottom-left of the text line, 
    // but for simplicity in our UI we treated (x,y) as top-left of the box usually.
    // However, let's stick to the box calc above: (x,y) is top-left in Canvas.
    ctx.fillText(ann.text, x!, y!);
    
    // Optional: draw a weak box around text when editing or hovering? 
    // For now just the text.

  } else if (ann.type === 'blackout') {
    ctx.fillStyle = '#000000';
    ctx.fillRect(x!, y!, w!, h!);
  } else if (ann.type === 'whiteout') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x!, y!, w!, h!);
  } else if (ann.type === 'blur') {
    // Blur logic
    const blurAmount = 0.1; 
    const sw = Math.max(1, Math.floor(w! * blurAmount));
    const sh = Math.max(1, Math.floor(h! * blurAmount));
    
    const offCanvas = document.createElement('canvas');
    offCanvas.width = sw;
    offCanvas.height = sh;
    const offCtx = offCanvas.getContext('2d');
    
    if (offCtx) {
      offCtx.imageSmoothingEnabled = true;
      offCtx.imageSmoothingQuality = 'low';
      offCtx.drawImage(ctx.canvas, x!, y!, w!, h!, 0, 0, sw, sh);
      
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      ctx.drawImage(offCanvas, 0, 0, sw, sh, x!, y!, w!, h!);
      ctx.drawImage(ctx.canvas, x!, y!, w!, h!, x!, y!, w!, h!);
    }
    // No border for blur
  } else if (ann.type === 'mosaic') {
    // Mosaic logic - Finer grain
    const blockSize = 4 * viewport.scale; // Much smaller blocks
    const sw = Math.max(1, Math.floor(w! / blockSize));
    const sh = Math.max(1, Math.floor(h! / blockSize));

    const offCanvas = document.createElement('canvas');
    offCanvas.width = sw;
    offCanvas.height = sh;
    const offCtx = offCanvas.getContext('2d');

    if (offCtx) {
      offCtx.imageSmoothingEnabled = false;
      offCtx.drawImage(ctx.canvas, x!, y!, w!, h!, 0, 0, sw, sh);

      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(offCanvas, 0, 0, sw, sh, x!, y!, w!, h!);
    }
    // No strokeRect (Invisible border)
  }

  ctx.restore();
};

export const saveRedactedPdf = async (
  originalPdfBuffer: ArrayBuffer,
  annotations: AnnotationObject[]
): Promise<Uint8Array> => {
  if (originalPdfBuffer.byteLength === 0) {
    throw new Error("PDF Buffer is empty.");
  }

  const pdfDoc = await PDFDocument.load(originalPdfBuffer);
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Group by page
  const annMap = new Map<number, AnnotationObject[]>();
  annotations.forEach(r => {
    const list = annMap.get(r.pageIndex) || [];
    list.push(r);
    annMap.set(r.pageIndex, list);
  });

  // Prepare a worker for visual effects (mosaic/blur)
  const hasVisualEffects = annotations.some(r => r.type === 'mosaic' || r.type === 'blur');
  let pdfJsDoc = null;
  if (hasVisualEffects) {
    const bufferCopy = originalPdfBuffer.slice(0);
    pdfJsDoc = await pdfJs.getDocument({ data: bufferCopy }).promise;
  }

  for (const [pageIndex, anns] of annMap.entries()) {
    const pdfPage = pages[pageIndex];
    if (!pdfPage) continue;
    const { height: pageHeight } = pdfPage.getSize();

    // 1. Process Vector Annotations (Blackout, Whiteout, Rect, Pen, Text)
    for (const ann of anns) {
      if (ann.type === 'blackout' || ann.type === 'whiteout') {
        pdfPage.drawRectangle({
          x: ann.x,
          y: ann.y,
          width: ann.width,
          height: ann.height,
          color: ann.type === 'blackout' ? rgb(0, 0, 0) : rgb(1, 1, 1),
        });
      } else if (ann.type === 'rectangle') {
        // Parse hex color
        const c = hexToRgb(ann.color || '#ff0000');
        pdfPage.drawRectangle({
          x: ann.x,
          y: ann.y,
          width: ann.width,
          height: ann.height,
          borderColor: rgb(c.r, c.g, c.b),
          borderWidth: ann.strokeWidth || 2,
          opacity: 0, // Fill opacity
          borderOpacity: 1,
        });
      } else if (ann.type === 'text' && ann.text) {
        const c = hexToRgb(ann.color || '#000000');
        // PDF-lib draws text from bottom-left by default, but our Y is bottom-left of the box.
        // We want the text to appear inside the box top-aligned relative to the box logic we used?
        // Actually, in UI we place text at (x,y) which we converted from PDF Point.
        // Let's assume ann.x/ann.y is the anchor.
        // Since we want visual consistency, we usually treat y as the baseline or top.
        // For simplicity: y is the baseline for drawText roughly minus descent.
        // Let's just draw at ann.x, ann.y + height - fontSize (approx top align visual adjustment)
        // Or simply draw at ann.x, ann.y + ann.height (since Y is bottom up, y+height is top).
        
        pdfPage.drawText(ann.text, {
          x: ann.x,
          // Draw slightly below the top edge
          y: ann.y + ann.height - (ann.fontSize || 12),
          size: ann.fontSize || 12,
          font: font,
          color: rgb(c.r, c.g, c.b),
        });
      } else if (ann.type === 'pen' && ann.path && ann.path.length > 0) {
        const c = hexToRgb(ann.color || '#ff0000');
        // PDF-lib doesn't have a simple "polyline". We draw individual lines or SVG path.
        // Drawing many individual lines is easiest.
        const path = ann.path;
        for (let i = 0; i < path.length - 1; i++) {
            pdfPage.drawLine({
                start: { x: path[i].x, y: path[i].y },
                end: { x: path[i+1].x, y: path[i+1].y },
                thickness: ann.strokeWidth || 2,
                color: rgb(c.r, c.g, c.b),
                opacity: 1,
            });
        }
      }
    }

    // 2. Process Raster Effects (Mosaic, Blur)
    const effectRects = anns.filter(r => r.type === 'mosaic' || r.type === 'blur');
    if (effectRects.length > 0 && pdfJsDoc) {
      const pageProxy = await pdfJsDoc.getPage(pageIndex + 1);
      const scale = 2.0; 
      const viewport = pageProxy.getViewport({ scale });
      
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      
      await pageProxy.render({ canvasContext: ctx, viewport }).promise;

      for (const ann of effectRects) {
        const pdfYTop = ann.y + ann.height;
        const [vx, vy] = viewport.convertToViewportPoint(ann.x, pdfYTop);
        const vw = ann.width * scale;
        const vh = ann.height * scale;

        const patchCanvas = document.createElement('canvas');
        patchCanvas.width = vw;
        patchCanvas.height = vh;
        const patchCtx = patchCanvas.getContext('2d');
        
        if (patchCtx) {
           patchCtx.drawImage(canvas, vx, vy, vw, vh, 0, 0, vw, vh);
           
           // Apply effect to patch (using local coords 0,0)
           // Create a fake generic annotation object for the renderer
           const localAnn = { ...ann, x: 0, y: 0, width: vw, height: vh };
           
           // We need a fake viewport that maps 1:1
           const fakeViewport = { scale: 1, convertToViewportPoint: (x: number, y: number) => [x, y] };
           
           // Manual effect application because renderAnnotationOnCanvas relies on Viewport complex logic
           if (ann.type === 'mosaic') {
             const blockSize = 4 * scale; // match the high res
             const sw = Math.max(1, Math.floor(vw / blockSize));
             const sh = Math.max(1, Math.floor(vh / blockSize));
             const tC = document.createElement('canvas'); tC.width=sw; tC.height=sh;
             tC.getContext('2d')?.drawImage(patchCanvas, 0, 0, sw, sh);
             patchCtx.imageSmoothingEnabled=false;
             patchCtx.drawImage(tC, 0,0,sw,sh,0,0,vw,vh);
           } else if (ann.type === 'blur') {
             // simplified blur for save
             const sw = Math.max(1, Math.floor(vw * 0.1));
             const sh = Math.max(1, Math.floor(vh * 0.1));
             const tC = document.createElement('canvas'); tC.width=sw; tC.height=sh;
             tC.getContext('2d')?.drawImage(patchCanvas, 0, 0, sw, sh);
             patchCtx.imageSmoothingEnabled=true;
             patchCtx.drawImage(tC, 0,0,sw,sh,0,0,vw,vh);
             patchCtx.drawImage(patchCanvas, 0,0,vw,vh,0,0,vw,vh); // smooth
           }

           const pngImage = await pdfDoc.embedPng(patchCanvas.toDataURL('image/png'));
           pdfPage.drawImage(pngImage, {
             x: ann.x,
             y: ann.y,
             width: ann.width,
             height: ann.height,
           });
        }
      }
    }
  }

  return await pdfDoc.save();
};

export const canvasToBase64 = (canvas: HTMLCanvasElement) => {
    return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
}

// Helper
function hexToRgb(hex: string) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255
  } : { r: 0, g: 0, b: 0 };
}