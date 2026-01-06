import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, Download, Undo2, Eraser, Move, LayoutGrid, FileText, Shield, Sparkles } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import { RedactionRect, ToolMode, ProcessingState } from './types';
import { loadPdf, renderPageToCanvas, savePdfWithRedactions, pixelateCanvasRect, getBase64FromCanvas, loadPdfDocument } from './utils/pdfUtils';
import { detectSensitiveData } from './services/geminiService';
import { Button } from './components/Button';

// Types specific to local state
interface LoadedPdf {
  file: File;
  data: ArrayBuffer;
  pdfDocument: pdfjsLib.PDFDocumentProxy;
  numPages: number;
}

const App: React.FC = () => {
  // State
  const [pdf, setPdf] = useState<LoadedPdf | null>(null);
  const [currentPage, setCurrentPage] = useState<number>(0);
  const [scale, setScale] = useState<number>(1.2);
  const [redactions, setRedactions] = useState<RedactionRect[]>([]);
  const [toolMode, setToolMode] = useState<ToolMode>(ToolMode.MOSAIC);
  const [processing, setProcessing] = useState<ProcessingState>({ isProcessing: false, message: '' });
  
  // Refs for interaction
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDrawing = useRef(false);
  const startPos = useRef<{ x: number, y: number } | null>(null);
  const activePageViewport = useRef<any>(null);

  // Load PDF
  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setProcessing({ isProcessing: true, message: '正在載入 PDF...' });
    try {
      const data = await loadPdf(file);
      // Use the helper from utils to ensure worker is configured correctly
      const pdfDocument = await loadPdfDocument(data);
      
      setPdf({
        file,
        data,
        pdfDocument,
        numPages: pdfDocument.numPages
      });
      setCurrentPage(0);
      setRedactions([]);
      setToolMode(ToolMode.MOSAIC);
    } catch (error) {
      console.error(error);
      alert('無法載入 PDF，請確認檔案是否損毀或加密。');
    } finally {
      setProcessing({ isProcessing: false, message: '' });
    }
  };

  // Render current page
  const renderPage = useCallback(async () => {
    if (!pdf || !canvasRef.current) return;

    try {
      const page = await pdf.pdfDocument.getPage(currentPage + 1);
      const viewport = await renderPageToCanvas(page, canvasRef.current, scale);
      activePageViewport.current = viewport;
      
      // Draw existing redactions
      const ctx = canvasRef.current.getContext('2d');
      if (ctx) {
        // Filter redactions for current page
        const pageRedactions = redactions.filter(r => r.pageIndex === currentPage);
        
        pageRedactions.forEach(r => {
          // Convert PDF Point coords (Bottom-Left origin) to Canvas Pixel coords (Top-Left origin)
          // r.y + r.height is the Top edge in PDF space
          // r.y is the Bottom edge in PDF space
          
          const [x1, y1] = viewport.convertToViewportPoint(r.x, r.y + r.height);
          const [x2, y2] = viewport.convertToViewportPoint(r.x + r.width, r.y);
          
          const pixelX = Math.min(x1, x2);
          const pixelY = Math.min(y1, y2);
          const pixelW = Math.abs(x2 - x1);
          const pixelH = Math.abs(y2 - y1);
          
          pixelateCanvasRect(ctx, pixelX, pixelY, pixelW, pixelH, 12);
          
          // Optional: Draw a subtle border to show it's redacted
          ctx.strokeStyle = 'rgba(220, 38, 38, 0.4)'; // Red border
          ctx.lineWidth = 1;
          ctx.strokeRect(pixelX, pixelY, pixelW, pixelH);
        });
      }
    } catch (err) {
      console.error("Render error", err);
    }
  }, [pdf, currentPage, scale, redactions]);

  useEffect(() => {
    renderPage();
  }, [renderPage]);

  // Canvas Interaction Handlers
  const getCanvasCoords = (e: React.MouseEvent) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (toolMode !== ToolMode.MOSAIC || !activePageViewport.current) return;
    isDrawing.current = true;
    const { x, y } = getCanvasCoords(e);
    startPos.current = { x, y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    // Logic handled by global overlay for performance
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (!isDrawing.current || !startPos.current || !activePageViewport.current) return;
    isDrawing.current = false;
    
    const { x, y } = getCanvasCoords(e);
    const startX = startPos.current.x;
    const startY = startPos.current.y;
    
    const width = Math.abs(x - startX);
    const height = Math.abs(y - startY);
    
    // Ignore tiny accidental clicks
    if (width < 5 || height < 5) {
        startPos.current = null;
        return;
    }

    const finalX = Math.min(startX, x);
    const finalY = Math.min(startY, y);
    const finalX2 = finalX + width;
    const finalY2 = finalY + height;

    // Convert Canvas Pixels back to PDF Points
    const viewport = activePageViewport.current;
    
    // convertToPdfPoint returns [x, y] in PDF coordinates (usually Bottom-Left origin)
    // Canvas Top-Left (finalX, finalY) -> PDF (px1, py1) -> Corresponds to PDF Top-Left of rect
    // Canvas Bottom-Right (finalX2, finalY2) -> PDF (px2, py2) -> Corresponds to PDF Bottom-Right of rect
    
    const [px1, py1] = viewport.convertToPdfPoint(finalX, finalY);
    const [px2, py2] = viewport.convertToPdfPoint(finalX2, finalY2);
    
    // In standard PDF coords (bottom-up):
    // py1 should be larger (higher on page)
    // py2 should be smaller (lower on page)
    
    const pdfX = Math.min(px1, px2);
    // FIX: Previously incorrectly used Math.min(px1, py2) mixing X and Y axes
    const pdfY = Math.min(py1, py2); 
    const pdfW = Math.abs(px2 - px1);
    const pdfH = Math.abs(py2 - py1);

    const newRedaction: RedactionRect = {
      id: Math.random().toString(36).substr(2, 9),
      pageIndex: currentPage,
      x: pdfX,
      y: pdfY,
      width: pdfW,
      height: pdfH
    };

    setRedactions(prev => [...prev, newRedaction]);
    startPos.current = null;
  };

  const handleUndo = () => {
    setRedactions(prev => {
        const newRedactions = [...prev];
        newRedactions.pop();
        return newRedactions;
    });
  };
  
  const handleClearPage = () => {
    setRedactions(prev => prev.filter(r => r.pageIndex !== currentPage));
  }

  const handleSave = async () => {
    if (!pdf) return;
    setProcessing({ isProcessing: true, message: '正在套用馬賽克並儲存 PDF...' });
    
    // Small delay to allow UI to update
    setTimeout(async () => {
        try {
            const pdfBytes = await savePdfWithRedactions(pdf.data, redactions);
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `redacted_${pdf.file.name}`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (e) {
            console.error(e);
            alert('儲存 PDF 失敗');
        } finally {
            setProcessing({ isProcessing: false, message: '' });
        }
    }, 100);
  };

  const handleMagicRedact = async () => {
    if (!pdf || !canvasRef.current) return;
    
    setProcessing({ isProcessing: true, message: 'AI 正在分析頁面中的敏感資料...' });
    
    try {
        // We need a clean image of the page WITHOUT current red lines
        // Render current page to a temp canvas
        const page = await pdf.pdfDocument.getPage(currentPage + 1);
        const tempCanvas = document.createElement('canvas');
        const viewport = await renderPageToCanvas(page, tempCanvas, 1.0); // 1.0 scale is usually enough for AI detection
        const base64 = getBase64FromCanvas(tempCanvas);
        
        // Use raw PDF Point dimensions for better alignment with service calculations
        // The viewport at scale 1.0 has dimensions equal to PDF points
        
        const detectedRects = await detectSensitiveData(
            base64, 
            currentPage, 
            viewport.width, 
            viewport.height
        );
        
        if (detectedRects.length === 0) {
            alert("在此頁面上未偵測到敏感資料。");
        } else {
            setRedactions(prev => [...prev, ...detectedRects]);
        }
        
    } catch (e) {
        console.error("AI Error", e);
        const msg = e instanceof Error ? e.message : "未知錯誤";
        alert(`AI 偵測失敗: ${msg}`);
    } finally {
        setProcessing({ isProcessing: false, message: '' });
    }
  };

  // Overlay for drawing selection
  const [dragOverlay, setDragOverlay] = useState<{left: number, top: number, width: number, height: number} | null>(null);

  useEffect(() => {
    const handleGlobalMove = (e: MouseEvent) => {
        if (isDrawing.current && startPos.current && canvasRef.current) {
            const rect = canvasRef.current.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            
            const startX = startPos.current.x;
            const startY = startPos.current.y;
            
            setDragOverlay({
                left: Math.min(startX, mouseX),
                top: Math.min(startY, mouseY),
                width: Math.abs(mouseX - startX),
                height: Math.abs(mouseY - startY)
            });
        }
    };
    
    const handleGlobalUp = () => {
        if (isDrawing.current) {
            setDragOverlay(null);
            // Logic handled in React's onMouseUp
        }
    };

    window.addEventListener('mousemove', handleGlobalMove);
    window.addEventListener('mouseup', handleGlobalUp);
    return () => {
        window.removeEventListener('mousemove', handleGlobalMove);
        window.removeEventListener('mouseup', handleGlobalUp);
    };
  }, []);

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 bg-white border-b border-slate-200 shadow-sm z-10">
        <div className="flex items-center gap-2">
          <div className="bg-blue-600 p-1.5 rounded-lg">
             <Shield className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-xl font-bold text-slate-800 tracking-tight">PixelGuard PDF</h1>
        </div>
        
        <div className="flex items-center gap-3">
          {pdf && (
            <>
              <div className="hidden md:flex items-center gap-1 bg-slate-100 rounded-lg p-1 mr-2">
                <button 
                  onClick={() => setToolMode(ToolMode.SELECT)}
                  className={`p-2 rounded-md text-sm font-medium transition-all ${toolMode === ToolMode.SELECT ? 'bg-white shadow text-blue-600' : 'text-slate-500 hover:text-slate-700'}`}
                  title="瀏覽模式 (平移)"
                >
                    <Move className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => setToolMode(ToolMode.MOSAIC)}
                  className={`p-2 rounded-md text-sm font-medium transition-all ${toolMode === ToolMode.MOSAIC ? 'bg-white shadow text-blue-600' : 'text-slate-500 hover:text-slate-700'}`}
                  title="馬賽克工具"
                >
                    <LayoutGrid className="w-4 h-4" />
                </button>
              </div>

              <Button variant="secondary" size="sm" onClick={handleUndo} disabled={redactions.length === 0} title="復原">
                <Undo2 className="w-4 h-4" />
              </Button>
               <Button variant="secondary" size="sm" onClick={handleClearPage} disabled={!redactions.some(r => r.pageIndex === currentPage)} title="清除本頁">
                <Eraser className="w-4 h-4" />
              </Button>
              <div className="h-6 w-px bg-slate-300 mx-1"></div>
              <Button 
                variant="primary" 
                onClick={handleSave}
                disabled={processing.isProcessing}
              >
                <Download className="w-4 h-4 mr-2" />
                儲存 PDF
              </Button>
            </>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden relative">
        {/* Processing Overlay */}
        {processing.isProcessing && (
          <div className="absolute inset-0 z-50 bg-white/80 backdrop-blur-sm flex items-center justify-center">
            <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
                <p className="text-slate-700 font-medium">{processing.message}</p>
            </div>
          </div>
        )}

        {/* Sidebar (Thumbnails) */}
        {pdf && (
           <div className="w-64 bg-white border-r border-slate-200 flex flex-col hidden md:flex">
             <div className="p-4 border-b border-slate-100">
               <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">頁面 ({pdf.numPages})</h3>
             </div>
             <div className="flex-1 overflow-y-auto p-4 space-y-3">
               {Array.from({ length: pdf.numPages }).map((_, idx) => (
                 <button
                   key={idx}
                   onClick={() => setCurrentPage(idx)}
                   className={`w-full flex flex-col gap-2 p-2 rounded-lg border transition-all ${currentPage === idx ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-slate-200 hover:border-blue-300 bg-slate-50'}`}
                 >
                   <div className="aspect-[3/4] w-full bg-white rounded border border-slate-100 flex items-center justify-center relative overflow-hidden">
                      {/* Mini indicator for redacted pages */}
                      {redactions.some(r => r.pageIndex === idx) && (
                        <div className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full"></div>
                      )}
                      <FileText className="text-slate-300 w-8 h-8" />
                      <span className="absolute bottom-1 text-[10px] text-slate-400 font-mono">{idx + 1}</span>
                   </div>
                 </button>
               ))}
             </div>
           </div>
        )}

        {/* Workspace */}
        <div className="flex-1 bg-slate-100 overflow-auto flex items-center justify-center relative p-8">
          {!pdf ? (
            <div className="text-center max-w-md">
              <div className="bg-white p-10 rounded-2xl shadow-sm border border-slate-200">
                <div className="w-16 h-16 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-6">
                  <Upload className="w-8 h-8" />
                </div>
                <h2 className="text-2xl font-bold text-slate-800 mb-2">上傳您的 PDF</h2>
                <p className="text-slate-500 mb-6">在本地安全載入您的文件。在您選擇使用 AI 功能之前，沒有資料會離開您的瀏覽器。</p>
                <label className="block">
                  <span className="sr-only">Choose PDF</span>
                  <input 
                    type="file" 
                    accept="application/pdf"
                    onChange={handleFileChange}
                    className="block w-full text-sm text-slate-500
                      file:mr-4 file:py-2.5 file:px-6
                      file:rounded-full file:border-0
                      file:text-sm file:font-semibold
                      file:bg-blue-600 file:text-white
                      hover:file:bg-blue-700
                      cursor-pointer"
                  />
                </label>
              </div>
            </div>
          ) : (
            <div className="relative shadow-lg" ref={containerRef}>
               {/* Toolbar Floating */}
               <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 flex gap-2 bg-white/90 backdrop-blur border border-slate-200 p-1.5 rounded-full shadow-lg">
                  <button onClick={() => setScale(s => Math.max(0.5, s - 0.2))} className="w-8 h-8 flex items-center justify-center hover:bg-slate-100 rounded-full text-slate-600">-</button>
                  <span className="text-xs font-mono self-center px-2 w-12 text-center">{Math.round(scale * 100)}%</span>
                  <button onClick={() => setScale(s => Math.min(3, s + 0.2))} className="w-8 h-8 flex items-center justify-center hover:bg-slate-100 rounded-full text-slate-600">+</button>
               </div>

               {/* AI Magic Button */}
               <div className="absolute top-4 right-4 z-30">
                  <Button 
                    variant="ghost" 
                    className="bg-white/90 backdrop-blur shadow-sm border border-purple-100 text-purple-700 hover:bg-purple-50"
                    size="sm"
                    onClick={handleMagicRedact}
                    title="自動偵測人臉與敏感資料"
                  >
                    <Sparkles className="w-4 h-4 mr-2" />
                    AI 偵測
                  </Button>
               </div>

               {/* PDF Canvas */}
               <div 
                 className={`relative bg-white transition-cursor ${toolMode === ToolMode.MOSAIC ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
                 onMouseDown={handleMouseDown}
                 onMouseMove={handleMouseMove}
                 onMouseUp={handleMouseUp}
               >
                 <canvas ref={canvasRef} className="block" />
                 
                 {/* Drag Selection Overlay */}
                 {dragOverlay && (
                    <div 
                      className="absolute border-2 border-blue-500 bg-blue-500/10 pointer-events-none"
                      style={{
                        left: dragOverlay.left,
                        top: dragOverlay.top,
                        width: dragOverlay.width,
                        height: dragOverlay.height
                      }}
                    />
                 )}
               </div>
               
               <div className="absolute bottom-[-40px] left-0 w-full text-center text-xs text-slate-400">
                  第 {currentPage + 1} 頁，共 {pdf.numPages} 頁
               </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default App;