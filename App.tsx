import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, Download, Undo2, Eraser, MousePointer2, Grid2X2, Sparkles, Loader2, FileText, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { RedactionRect, ToolMode, ProcessingState } from './types';
import { loadPdfDocument, renderPage, saveRedactedPdf, applyMosaicEffect, canvasToBase64 } from './utils/pdfUtils';
import { detectSensitiveData } from './services/geminiService';
import { Button } from './components/Toolbar';

export default function App() {
  // --- State ---
  const [file, setFile] = useState<File | null>(null);
  const [pdfProxy, setPdfProxy] = useState<any>(null);
  const [pdfBuffer, setPdfBuffer] = useState<ArrayBuffer | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currIndex, setCurrIndex] = useState(0);
  const [scale, setScale] = useState(1.0);
  
  const [redactions, setRedactions] = useState<RedactionRect[]>([]);
  const [mode, setMode] = useState<ToolMode>('mosaic');
  const [processing, setProcessing] = useState<ProcessingState>({ isProcessing: false, message: '' });

  // --- Refs ---
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const startPos = useRef<{x: number, y: number} | null>(null);
  const currentViewport = useRef<any>(null);

  // --- Handlers ---

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    
    setProcessing({ isProcessing: true, message: '讀取文件中...' });
    try {
      const { proxy, buffer } = await loadPdfDocument(f);
      setFile(f);
      setPdfProxy(proxy);
      setPdfBuffer(buffer);
      setNumPages(proxy.numPages);
      setCurrIndex(0);
      setRedactions([]);
      setMode('mosaic');
    } catch (err) {
      console.error(err);
      alert('無法載入 PDF，請確認檔案格式。');
    } finally {
      setProcessing({ isProcessing: false, message: '' });
    }
  };

  const draw = useCallback(async () => {
    if (!pdfProxy || !canvasRef.current) return;
    
    try {
      const page = await pdfProxy.getPage(currIndex + 1);
      // Determine efficient scale for rendering (cap max scale for performance)
      // Usually user scale * device pixel ratio, but 1.5-2.0 is often plenty crisp
      const renderScale = scale * window.devicePixelRatio; 
      
      const viewport = await renderPage(page, canvasRef.current, scale);
      currentViewport.current = viewport;

      const ctx = canvasRef.current.getContext('2d');
      if (!ctx) return;

      // Draw redactions for this page
      const pageRedactions = redactions.filter(r => r.pageIndex === currIndex);
      
      pageRedactions.forEach(rect => {
        // Convert PDF Point (bottom-left origin) to Canvas Pixel (top-left origin)
        // PDF Rect top Y = rect.y + rect.height
        const [x1, y1] = viewport.convertToViewportPoint(rect.x, rect.y + rect.height);
        const [x2, y2] = viewport.convertToViewportPoint(rect.x + rect.width, rect.y);
        
        const px = Math.min(x1, x2);
        const py = Math.min(y1, y2);
        const pw = Math.abs(x2 - x1);
        const ph = Math.abs(y2 - y1);
        
        applyMosaicEffect(ctx, px, py, pw, ph, 10);
      });

    } catch (error) {
      console.error("Render error:", error);
    }
  }, [pdfProxy, currIndex, scale, redactions]);

  useEffect(() => {
    draw();
  }, [draw]);

  // --- Interaction Logic ---

  const getPos = (e: React.MouseEvent) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const r = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (mode !== 'mosaic') return;
    isDragging.current = true;
    startPos.current = getPos(e);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    // We could render a selection box here for better UX
    // For now, relies on standard drag feeling
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (!isDragging.current || !startPos.current || !currentViewport.current) return;
    isDragging.current = false;

    const endPos = getPos(e);
    const start = startPos.current;

    // Calculate dimensions in Canvas Pixels
    const x = Math.min(start.x, endPos.x);
    const y = Math.min(start.y, endPos.y);
    const w = Math.abs(endPos.x - start.x);
    const h = Math.abs(endPos.y - start.y);

    if (w < 5 || h < 5) return; // Ignore tiny clicks

    // Convert to PDF Points
    const viewport = currentViewport.current;
    
    // Canvas (x, y) is Top-Left of selection
    // Canvas (x+w, y+h) is Bottom-Right of selection
    
    // Convert to PDF points [px, py]
    // convertToPdfPoint handles the coordinate flip logic internally for the viewport
    const [pX1, pY1] = viewport.convertToPdfPoint(x, y);
    const [pX2, pY2] = viewport.convertToPdfPoint(x + w, y + h);

    // Normalize PDF Rect (x,y needs to be bottom-left)
    const pdfX = Math.min(pX1, pX2);
    const pdfY = Math.min(pY1, pY2);
    const pdfW = Math.abs(pX2 - pX1);
    const pdfH = Math.abs(pY2 - pY1);

    const newRect: RedactionRect = {
      id: Math.random().toString(36).slice(2),
      pageIndex: currIndex,
      x: pdfX,
      y: pdfY,
      width: pdfW,
      height: pdfH
    };

    setRedactions(prev => [...prev, newRect]);
  };

  const handleSave = async () => {
    if (!pdfBuffer) return;
    setProcessing({ isProcessing: true, message: '正在產生 PDF...' });
    
    // Use setTimeout to allow UI render cycle to show the loading spinner
    setTimeout(async () => {
      try {
        const resultBytes = await saveRedactedPdf(pdfBuffer, redactions);
        const blob = new Blob([resultBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `pixelguard_redacted_${file?.name || 'doc.pdf'}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch (e) {
        console.error(e);
        alert('儲存失敗');
      } finally {
        setProcessing({ isProcessing: false, message: '' });
      }
    }, 50);
  };

  const handleAI = async () => {
    if (!pdfProxy || !canvasRef.current) return;
    setProcessing({ isProcessing: true, message: 'AI 正在分析本頁敏感資訊...' });

    try {
      // Get a clean image of the page (render again without redactions)
      const page = await pdfProxy.getPage(currIndex + 1);
      const tempCanvas = document.createElement('canvas');
      const viewport = await renderPage(page, tempCanvas, 1.0); // Native scale for AI
      const base64 = canvasToBase64(tempCanvas);

      const found = await detectSensitiveData(base64, currIndex, viewport.width, viewport.height);
      
      if (found.length === 0) {
        alert('未偵測到明顯的敏感資訊');
      } else {
        setRedactions(prev => [...prev, ...found]);
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      setProcessing({ isProcessing: false, message: '' });
    }
  };

  // --- Render ---

  if (!file) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-10 text-center border border-slate-100">
          <div className="w-20 h-20 bg-blue-600 rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-blue-200 rotate-3 transition-transform hover:rotate-6">
            <Upload className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-slate-800 mb-3">PixelGuard PDF</h1>
          <p className="text-slate-500 mb-8 leading-relaxed">
            瀏覽器端的安全 PDF 隱私保護工具。<br/>
            資料完全在本地處理，不會上傳伺服器。
          </p>
          
          <label className="relative inline-flex group cursor-pointer">
            <div className="absolute transition-all duration-1000 opacity-70 -inset-px bg-gradient-to-r from-[#44BCFF] via-[#FF44EC] to-[#FF675E] rounded-xl blur-lg group-hover:opacity-100 group-hover:-inset-1 group-hover:duration-200 animate-tilt"></div>
            <input type="file" accept="application/pdf" className="hidden" onChange={handleFileChange} />
            <span className="relative inline-flex items-center justify-center px-8 py-4 text-lg font-bold text-white transition-all duration-200 bg-slate-900 font-pj rounded-xl focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-slate-900 w-full">
              選擇 PDF 文件
            </span>
          </label>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-slate-100">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between shadow-sm z-20">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-1.5 rounded text-white">
            <FileText className="w-5 h-5" />
          </div>
          <h1 className="font-bold text-slate-700 hidden sm:block truncate max-w-[200px]" title={file.name}>{file.name}</h1>
        </div>

        <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-lg">
          <Button 
            variant="ghost" 
            size="sm" 
            active={mode === 'view'} 
            onClick={() => setMode('view')}
            title="瀏覽模式 (防止誤觸)"
          >
            <MousePointer2 className="w-4 h-4" />
          </Button>
          <Button 
            variant="ghost" 
            size="sm" 
            active={mode === 'mosaic'} 
            onClick={() => setMode('mosaic')}
            title="馬賽克工具"
          >
            <Grid2X2 className="w-4 h-4" />
          </Button>
          <div className="w-px h-4 bg-slate-300 mx-1"></div>
          <Button variant="ghost" size="sm" onClick={() => setRedactions(prev => {
            const temp = [...prev];
            temp.pop();
            return temp;
          })} title="復原">
            <Undo2 className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRedactions(prev => prev.filter(r => r.pageIndex !== currIndex))} title="清除本頁">
            <Eraser className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex items-center gap-3">
           <Button 
            variant="secondary" 
            className="hidden sm:inline-flex border-purple-200 text-purple-700 bg-purple-50 hover:bg-purple-100" 
            onClick={handleAI}
            disabled={processing.isProcessing}
          >
            <Sparkles className="w-4 h-4 mr-2" />
            AI 偵測
          </Button>
          <Button onClick={handleSave} disabled={processing.isProcessing}>
            {processing.isProcessing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Download className="w-4 h-4 mr-2" />}
            儲存檔案
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 bg-white border-r border-slate-200 flex flex-col hidden md:flex">
          <div className="p-4 border-b border-slate-100 font-medium text-slate-500 text-sm">
            頁面預覽 ({numPages})
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {Array.from({ length: numPages }).map((_, i) => (
              <button
                key={i}
                onClick={() => setCurrIndex(i)}
                className={`w-full aspect-[3/4] rounded border-2 transition-all relative flex items-center justify-center bg-slate-50 ${currIndex === i ? 'border-blue-500 ring-2 ring-blue-100' : 'border-slate-200 hover:border-slate-300'}`}
              >
                <span className="text-slate-400 font-mono text-sm">{i + 1}</span>
                {redactions.some(r => r.pageIndex === i) && (
                  <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-blue-500 shadow-sm" />
                )}
              </button>
            ))}
          </div>
        </aside>

        {/* Canvas Area */}
        <main className="flex-1 bg-slate-100 relative overflow-hidden flex flex-col">
          {/* Zoom Controls Overlay */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-white rounded-full shadow-lg border border-slate-200 p-2 flex items-center gap-4 z-10 px-6">
             <button onClick={() => setCurrIndex(p => Math.max(0, p - 1))} disabled={currIndex === 0} className="hover:text-blue-600 disabled:opacity-30">
               <ChevronLeft className="w-5 h-5" />
             </button>
             <span className="text-sm font-mono min-w-[3ch] text-center">{currIndex + 1}</span>
             <button onClick={() => setCurrIndex(p => Math.min(numPages - 1, p + 1))} disabled={currIndex === numPages - 1} className="hover:text-blue-600 disabled:opacity-30">
               <ChevronRight className="w-5 h-5" />
             </button>
             <div className="w-px h-4 bg-slate-300"></div>
             <button onClick={() => setScale(s => Math.max(0.5, s - 0.25))} className="hover:text-blue-600">
               <ZoomOut className="w-4 h-4" />
             </button>
             <span className="text-xs font-mono w-12 text-center">{Math.round(scale * 100)}%</span>
             <button onClick={() => setScale(s => Math.min(3.0, s + 0.25))} className="hover:text-blue-600">
               <ZoomIn className="w-4 h-4" />
             </button>
          </div>

          <div 
            className="flex-1 overflow-auto flex items-center justify-center p-8 relative" 
            ref={containerRef}
          >
             {processing.isProcessing && (
               <div className="absolute inset-0 z-50 bg-white/50 backdrop-blur-sm flex items-center justify-center">
                 <div className="bg-white px-6 py-4 rounded-xl shadow-xl border border-slate-100 flex items-center gap-3">
                   <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                   <span className="font-medium text-slate-700">{processing.message}</span>
                 </div>
               </div>
             )}
             
             <div className={`relative shadow-2xl transition-cursor ${mode === 'mosaic' ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}>
                <canvas 
                  ref={canvasRef} 
                  onMouseDown={onMouseDown}
                  onMouseMove={onMouseMove}
                  onMouseUp={onMouseUp}
                  onMouseLeave={onMouseUp}
                  className="bg-white block"
                />
             </div>
          </div>
        </main>
      </div>
    </div>
  );
}