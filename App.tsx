import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, Download, Undo2, Redo2, Eraser, MousePointer2, Grid2X2, Loader2, FileText, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Plus, X, Pencil, Ban, Droplets, Square, Type, Highlighter } from 'lucide-react';
import { AnnotationObject, ToolMode, ProcessingState, DocumentSession, RedactionType, Point } from './types';
import { loadPdfDocument, renderPage, saveRedactedPdf, renderAnnotationOnCanvas } from './utils/pdfUtils';
import { Button } from './components/Toolbar';
import { clsx } from 'clsx';

// --- Thumbnail Component ---
const PageThumbnail = ({ 
  doc, 
  pageIndex, 
  isActive, 
  onClick 
}: { 
  doc: DocumentSession; 
  pageIndex: number; 
  isActive: boolean; 
  onClick: () => void; 
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let mounted = true;
    const renderThumb = async () => {
      if (!canvasRef.current) return;
      try {
        const page = await doc.pdfProxy.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: 0.2 }); // Small scale for thumbnail
        
        // Render to canvas
        await renderPage(page, canvasRef.current, 0.2);
        
        if (mounted) setLoaded(true);
      } catch (e) {
        console.error("Thumbnail render error", e);
      }
    };
    
    // Simple Intersection Observer could be added here for performance on large docs
    // For now, we render on mount.
    renderThumb();
    
    return () => { mounted = false; };
  }, [doc, pageIndex]);

  return (
    <div 
      onClick={onClick}
      className={clsx(
        "w-full cursor-pointer group flex flex-col items-center gap-1 p-2 rounded-lg transition-colors border-2",
        isActive ? "bg-blue-50 border-blue-500" : "bg-transparent border-transparent hover:bg-slate-100"
      )}
    >
      <div className={clsx("relative shadow-sm bg-white min-h-[100px] w-full flex items-center justify-center overflow-hidden", !loaded && "animate-pulse bg-slate-200")}>
        <canvas ref={canvasRef} className="max-w-full h-auto object-contain" />
        {/* Redaction Indicators for Thumbnail */}
        {loaded && doc.annotations.some(r => r.pageIndex === pageIndex) && (
           <div className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-red-500 border border-white shadow-sm" />
        )}
      </div>
      <span className={clsx("text-xs font-mono", isActive ? "text-blue-700 font-bold" : "text-slate-500")}>
        {pageIndex + 1}
      </span>
    </div>
  );
};

export default function App() {
  // --- State ---
  const [documents, setDocuments] = useState<DocumentSession[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  
  // UI State
  const [toolType, setToolType] = useState<RedactionType>('mosaic');
  const [mode, setMode] = useState<ToolMode>('view');
  const [processing, setProcessing] = useState<ProcessingState>({ isProcessing: false, message: '' });

  // Save Modal State
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveFileName, setSaveFileName] = useState('');

  // Helpers
  const activeDoc = documents.find(d => d.id === activeDocId);
  
  // --- Refs ---
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentViewport = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Interaction Refs
  const isDragging = useRef(false);
  const startPos = useRef<{x: number, y: number} | null>(null);
  const currentMousePos = useRef<{x: number, y: number} | null>(null);
  const currentPath = useRef<Point[]>([]);

  // --- Document Management ---

  const createDocument = async (file: File) => {
    const { proxy, buffer } = await loadPdfDocument(file);
    const newDoc: DocumentSession = {
      id: Math.random().toString(36).slice(2),
      name: file.name,
      file,
      pdfProxy: proxy,
      pdfBuffer: buffer,
      numPages: proxy.numPages,
      currIndex: 0,
      scale: 1.0,
      annotations: [],
      redoStack: []
    };
    return newDoc;
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    setProcessing({ isProcessing: true, message: '讀取文件中...' });
    try {
      const newDocs: DocumentSession[] = [];
      for (let i = 0; i < files.length; i++) {
        newDocs.push(await createDocument(files[i]));
      }
      
      setDocuments(prev => [...prev, ...newDocs]);
      if (newDocs.length > 0) {
        setActiveDocId(newDocs[0].id);
        // Default stays as 'view' mode as initialized in state
      }
    } catch (err) {
      console.error(err);
      alert('無法載入 PDF，請確認檔案格式。');
    } finally {
      setProcessing({ isProcessing: false, message: '' });
      e.target.value = '';
    }
  };

  const updateActiveDoc = useCallback((updater: (doc: DocumentSession) => Partial<DocumentSession>) => {
    if (!activeDocId) return;
    setDocuments(prev => prev.map(d => {
      if (d.id === activeDocId) {
        return { ...d, ...updater(d) };
      }
      return d;
    }));
  }, [activeDocId]);

  const closeDocument = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDocuments(prev => {
      const newDocs = prev.filter(d => d.id !== id);
      if (activeDocId === id && newDocs.length > 0) {
        setActiveDocId(newDocs[newDocs.length - 1].id);
      } else if (newDocs.length === 0) {
        setActiveDocId(null);
      }
      return newDocs;
    });
  };

  const renameDocument = (id: string) => {
    const doc = documents.find(d => d.id === id);
    if (!doc) return;
    const newName = prompt('請輸入新檔名:', doc.name);
    if (newName && newName.trim()) {
      setDocuments(prev => prev.map(d => d.id === id ? { ...d, name: newName.trim() } : d));
    }
  };

  // --- Undo / Redo Logic ---

  const handleUndo = useCallback(() => {
    updateActiveDoc(d => {
      if (d.annotations.length === 0) return {};
      const newAnns = [...d.annotations];
      const popped = newAnns.pop();
      if (!popped) return {};
      return {
        annotations: newAnns,
        redoStack: [...(d.redoStack || []), popped]
      };
    });
  }, [updateActiveDoc]);

  const handleRedo = useCallback(() => {
    updateActiveDoc(d => {
      const stack = d.redoStack || [];
      if (stack.length === 0) return {};
      const newStack = [...stack];
      const next = newStack.pop();
      if (!next) return {};
      return {
        annotations: [...d.annotations, next],
        redoStack: newStack
      };
    });
  }, [updateActiveDoc]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if input is active (e.g., during rename prompt or text inputs, though prompts block)
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (e.shiftKey) {
            handleRedo();
          } else {
            handleUndo();
          }
        }
        if (e.key.toLowerCase() === 'y') {
          e.preventDefault();
          handleRedo();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo]);


  // --- Rendering ---

  useEffect(() => {
    let mounted = true;
    const renderBase = async () => {
      if (!activeDoc) {
        offscreenCanvasRef.current = null;
        currentViewport.current = null;
        return;
      }
      setProcessing(p => p.isProcessing ? p : { isProcessing: true, message: '渲染中...' });
      
      try {
        const page = await activeDoc.pdfProxy.getPage(activeDoc.currIndex + 1);
        const viewport = page.getViewport({ scale: activeDoc.scale });
        
        currentViewport.current = renderPage(page, document.createElement('canvas'), activeDoc.scale);
        
        if (!offscreenCanvasRef.current) offscreenCanvasRef.current = document.createElement('canvas');
        
        const vp = await renderPage(page, offscreenCanvasRef.current, activeDoc.scale);
        currentViewport.current = vp;

        if (mounted) drawOverlay();
      } catch (e) {
        console.error(e);
      } finally {
        if (mounted) setProcessing(p => ({ ...p, isProcessing: false, message: '' }));
      }
    };
    renderBase();
    return () => { mounted = false; };
  }, [activeDoc?.id, activeDoc?.currIndex, activeDoc?.scale]);

  const drawOverlay = useCallback(() => {
    if (!canvasRef.current || !offscreenCanvasRef.current || !currentViewport.current || !activeDoc) return;

    const ctx = canvasRef.current.getContext('2d');
    const osCanvas = offscreenCanvasRef.current;
    if (!ctx) return;

    if (canvasRef.current.width !== osCanvas.width || canvasRef.current.height !== osCanvas.height) {
      canvasRef.current.width = osCanvas.width;
      canvasRef.current.height = osCanvas.height;
    }

    // 1. PDF Base
    ctx.drawImage(osCanvas, 0, 0);

    // 2. Existing Annotations
    const pageAnns = activeDoc.annotations.filter(r => r.pageIndex === activeDoc.currIndex);
    const viewport = currentViewport.current;

    pageAnns.forEach(ann => {
       renderAnnotationOnCanvas(ctx, ann, viewport);
    });

    // 3. Active Interaction Preview
    if (isDragging.current && mode === 'edit') {
       if (toolType === 'pen' && currentPath.current.length > 0) {
          // Draw Pen Path
          ctx.beginPath();
          const path = currentPath.current;
          
          if (path.length > 0) {
            ctx.moveTo(path[0].x, path[0].y);
            for (let i = 1; i < path.length; i++) {
                ctx.lineTo(path[i].x, path[i].y);
            }
            ctx.strokeStyle = '#ef4444'; // Red preview
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke();
          }

       } else if (startPos.current && currentMousePos.current && toolType !== 'pen' && toolType !== 'text') {
          // Draw Box Preview
          const start = startPos.current;
          const end = currentMousePos.current;
          const x = Math.min(start.x, end.x);
          const y = Math.min(start.y, end.y);
          const w = Math.abs(end.x - start.x);
          const h = Math.abs(end.y - start.y);

          ctx.save();
          if (toolType === 'rectangle') {
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, w, h);
          } else {
             // Redaction preview
             ctx.strokeStyle = '#2563eb';
             ctx.lineWidth = 2;
             ctx.setLineDash([5, 5]);
             ctx.strokeRect(x, y, w, h);
             ctx.globalAlpha = 0.5;
             ctx.fillStyle = toolType === 'blackout' ? 'black' : toolType === 'whiteout' ? 'white' : 'rgba(0,0,0,0.2)';
             ctx.fillRect(x,y,w,h);
          }
          ctx.restore();
       }
    }

  }, [activeDoc, toolType, mode]);

  useEffect(() => {
    drawOverlay();
  }, [drawOverlay]);

  // --- Interaction ---

  const getPos = (e: React.MouseEvent) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const r = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (mode !== 'edit' || !activeDoc) return;
    
    // Text tool is click-based
    if (toolType === 'text') return;

    isDragging.current = true;
    const pos = getPos(e);
    startPos.current = pos;
    currentMousePos.current = pos;
    
    if (toolType === 'pen') {
      currentPath.current = [pos];
    }
    drawOverlay();
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!isDragging.current) return;
    const pos = getPos(e);
    currentMousePos.current = pos;
    
    if (toolType === 'pen') {
      currentPath.current.push(pos);
    }
    drawOverlay();
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (toolType === 'text') return; // Handled in onClick
    if (!isDragging.current || !startPos.current || !currentViewport.current || !activeDoc) return;
    
    isDragging.current = false;
    const endPos = getPos(e);
    const start = startPos.current;
    
    const viewport = currentViewport.current;

    if (toolType === 'pen') {
       // Convert Path to PDF Coords
       const pdfPath = currentPath.current.map(p => {
         const [px, py] = viewport.convertToPdfPoint(p.x, p.y);
         return { x: px, y: py };
       });
       
       if (pdfPath.length > 2) {
         const newAnn: AnnotationObject = {
            id: Math.random().toString(36).slice(2),
            pageIndex: activeDoc.currIndex,
            x: 0, y: 0, width: 0, height: 0, 
            type: 'pen',
            path: pdfPath,
            color: '#ef4444',
            strokeWidth: 2
         };
         updateActiveDoc(d => ({ 
           annotations: [...d.annotations, newAnn],
           redoStack: [] // Clear redo on new action
         }));
       }
       currentPath.current = [];
    } else {
       // Box based tools
       const x = Math.min(start.x, endPos.x);
       const y = Math.min(start.y, endPos.y);
       const w = Math.abs(endPos.x - start.x);
       const h = Math.abs(endPos.y - start.y);

       if (w > 5 && h > 5) {
          const [pX1, pY1] = viewport.convertToPdfPoint(x, y);
          const [pX2, pY2] = viewport.convertToPdfPoint(x + w, y + h);
          
          const pdfX = Math.min(pX1, pX2);
          const pdfY = Math.min(pY1, pY2);
          const pdfW = Math.abs(pX2 - pX1);
          const pdfH = Math.abs(pY2 - pY1);
          
          const newAnn: AnnotationObject = {
             id: Math.random().toString(36).slice(2),
             pageIndex: activeDoc.currIndex,
             x: pdfX, y: pdfY, width: pdfW, height: pdfH,
             type: toolType,
             color: toolType === 'rectangle' ? '#ef4444' : undefined,
             strokeWidth: 2
          };
          updateActiveDoc(d => ({ 
            annotations: [...d.annotations, newAnn],
            redoStack: [] // Clear redo on new action
          }));
       }
    }
    
    startPos.current = null;
    currentMousePos.current = null;
    drawOverlay();
  };

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (!activeDoc || !currentViewport.current) return;

    if (mode === 'edit' && toolType === 'text') {
       const pos = getPos(e);
       const text = prompt("請輸入文字:", "");
       if (text) {
          const [px, py] = currentViewport.current.convertToPdfPoint(pos.x, pos.y);
          const newAnn: AnnotationObject = {
             id: Math.random().toString(36).slice(2),
             pageIndex: activeDoc.currIndex,
             x: px, y: py, width: 100, height: 20, // Default size
             type: 'text',
             text: text,
             fontSize: 14,
             color: '#000000'
          };
          updateActiveDoc(d => ({ 
            annotations: [...d.annotations, newAnn],
            redoStack: [] // Clear redo on new action
          }));
       }
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!activeDoc || !currentViewport.current) return;
    const pos = getPos(e);
    const viewport = currentViewport.current;

    const pageAnns = activeDoc.annotations.filter(r => r.pageIndex === activeDoc.currIndex);
    for (let i = pageAnns.length - 1; i >= 0; i--) {
       const ann = pageAnns[i];
       if (ann.type === 'text' || ann.type === 'rectangle' || ann.type === 'pen') {
          if (ann.type === 'pen') continue;

          const [x1, y1] = viewport.convertToViewportPoint(ann.x, ann.y + ann.height);
          const [x2, y2] = viewport.convertToViewportPoint(ann.x + ann.width, ann.y);
          const ax = Math.min(x1, x2);
          const ay = Math.min(y1, y2);
          const aw = Math.abs(x2 - x1);
          const ah = Math.abs(y2 - y1);
          
          if (pos.x >= ax && pos.x <= ax + aw && pos.y >= ay && pos.y <= ay + ah) {
             if (ann.type === 'text') {
                 const newText = prompt("編輯文字:", ann.text);
                 if (newText !== null) {
                    updateActiveDoc(d => ({
                      annotations: d.annotations.map(a => a.id === ann.id ? { ...a, text: newText } : a),
                      redoStack: [] // Clear redo on edit
                    }));
                 }
                 return; 
             }
          }
       }
    }
  };

  // --- Save Logic ---

  const handleSaveClick = () => {
    if (!activeDoc) return;
    // Suggest a filename based on the document name
    const baseName = activeDoc.name.replace(/\.pdf$/i, '');
    setSaveFileName(`pixelguard_${baseName}`);
    setShowSaveModal(true);
  };

  const performSave = async () => {
    if (!activeDoc) return;
    setShowSaveModal(false);
    setProcessing({ isProcessing: true, message: '產生 PDF 中...' });
    
    // Ensure extension
    let filename = saveFileName.trim();
    if (!filename.toLowerCase().endsWith('.pdf')) {
      filename += '.pdf';
    }

    setTimeout(async () => {
      try {
        const resultBytes = await saveRedactedPdf(activeDoc.pdfBuffer, activeDoc.annotations);
        const blob = new Blob([resultBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch (e: any) {
        alert('儲存失敗: ' + e.message);
      } finally {
        setProcessing({ isProcessing: false, message: '' });
      }
    }, 50);
  };

  // --- Render ---

  if (documents.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-10 text-center border border-slate-100">
          <div className="w-20 h-20 bg-blue-600 rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-blue-200 rotate-3 transition-transform hover:rotate-6">
            <Upload className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-slate-800 mb-3">PixelGuard PDF</h1>
          <p className="text-slate-500 mb-8 leading-relaxed">
            安全、離線的 PDF 編輯工具。<br/>
            支援馬賽克、繪圖、標註與文字編輯。
          </p>
          
          <label className="relative inline-flex group cursor-pointer w-full">
            <div className="absolute transition-all duration-1000 opacity-70 -inset-px bg-gradient-to-r from-[#44BCFF] via-[#FF44EC] to-[#FF675E] rounded-xl blur-lg group-hover:opacity-100 group-hover:-inset-1 group-hover:duration-200 animate-tilt"></div>
            <input type="file" accept="application/pdf" multiple className="hidden" onChange={handleFileChange} />
            <span className="relative inline-flex items-center justify-center px-8 py-4 text-lg font-bold text-white transition-all duration-200 bg-slate-900 font-pj rounded-xl focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-slate-900 w-full">
              開啟 PDF
            </span>
          </label>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-slate-100 relative">
      {/* Tab Bar */}
      <div className="bg-slate-200 flex items-end px-2 pt-2 gap-1 overflow-x-auto border-b border-slate-300">
        {documents.map(doc => (
          <div 
            key={doc.id}
            onClick={() => setActiveDocId(doc.id)}
            onDoubleClick={() => renameDocument(doc.id)}
            className={clsx(
              "group relative flex items-center gap-2 px-4 py-2 rounded-t-lg text-sm font-medium cursor-pointer select-none min-w-[120px] max-w-[200px] transition-colors",
              activeDocId === doc.id 
                ? "bg-white text-slate-700 shadow-[0_-1px_2px_rgba(0,0,0,0.05)]" 
                : "bg-slate-100 text-slate-500 hover:bg-slate-50 hover:text-slate-600"
            )}
            title={doc.name}
          >
            <span className="truncate flex-1">{doc.name}</span>
            <button 
              onClick={(e) => closeDocument(e, doc.id)}
              className="p-0.5 rounded-full hover:bg-slate-200 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X className="w-3 h-3" />
            </button>
            {activeDocId === doc.id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600"></div>}
          </div>
        ))}
        <label className="flex items-center justify-center w-8 h-8 mb-1 rounded-lg hover:bg-slate-300 cursor-pointer ml-1 transition-colors">
          <input type="file" accept="application/pdf" multiple className="hidden" onChange={handleFileChange} />
          <Plus className="w-5 h-5 text-slate-600" />
        </label>
      </div>

      {/* Toolbar */}
      <header className="bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between shadow-sm z-20 flex-wrap gap-2 relative">
        <div className="flex items-center gap-2">
           <div className="flex bg-slate-100 p-1 rounded-lg">
             <Button variant="ghost" size="sm" active={mode === 'view'} onClick={() => setMode('view')} title="瀏覽模式">
               <MousePointer2 className="w-4 h-4" />
             </Button>
             <Button variant="ghost" size="sm" active={mode === 'edit'} onClick={() => setMode('edit')} title="編輯模式">
               <Pencil className="w-4 h-4" />
             </Button>
           </div>
           
           <div className="w-px h-5 bg-slate-300 mx-1"></div>

           <div className="flex items-center gap-1">
             <Button variant="ghost" size="sm" active={toolType === 'mosaic'} onClick={() => { setToolType('mosaic'); setMode('edit'); }} title="馬賽克">
               <Grid2X2 className="w-4 h-4 mr-1.5" /> 馬賽克
             </Button>
             <Button variant="ghost" size="sm" active={toolType === 'blur'} onClick={() => { setToolType('blur'); setMode('edit'); }} title="模糊">
               <Droplets className="w-4 h-4 mr-1.5" /> 模糊
             </Button>
             
             <div className="w-px h-4 bg-slate-200 mx-1"></div>
             
             <Button variant="ghost" size="sm" active={toolType === 'pen'} onClick={() => { setToolType('pen'); setMode('edit'); }} title="畫筆">
               <Highlighter className="w-4 h-4 mr-1.5" /> 畫筆
             </Button>
             <Button variant="ghost" size="sm" active={toolType === 'rectangle'} onClick={() => { setToolType('rectangle'); setMode('edit'); }} title="方框">
               <Square className="w-4 h-4 mr-1.5" /> 方框
             </Button>
             <Button variant="ghost" size="sm" active={toolType === 'text'} onClick={() => { setToolType('text'); setMode('edit'); }} title="文字">
               <Type className="w-4 h-4 mr-1.5" /> 文字
             </Button>

             <div className="w-px h-4 bg-slate-200 mx-1"></div>

             <Button variant="ghost" size="sm" active={toolType === 'blackout'} onClick={() => { setToolType('blackout'); setMode('edit'); }} title="黑塗">
               <div className="w-4 h-4 bg-black border border-slate-300 rounded-sm"></div>
             </Button>
             <Button variant="ghost" size="sm" active={toolType === 'whiteout'} onClick={() => { setToolType('whiteout'); setMode('edit'); }} title="白塗">
               <div className="w-4 h-4 bg-white border border-slate-300 rounded-sm"></div>
             </Button>
           </div>
        </div>

        <div className="flex items-center gap-2">
           <Button variant="ghost" size="sm" onClick={handleUndo} title="復原 (Ctrl+Z)" disabled={!activeDoc || activeDoc.annotations.length === 0}>
             <Undo2 className="w-4 h-4" />
           </Button>
           <Button variant="ghost" size="sm" onClick={handleRedo} title="重做 (Ctrl+Y)" disabled={!activeDoc || !activeDoc.redoStack || activeDoc.redoStack.length === 0}>
             <Redo2 className="w-4 h-4" />
           </Button>

           <div className="w-px h-5 bg-slate-300 mx-1"></div>

           <Button variant="ghost" size="sm" onClick={() => updateActiveDoc(d => ({ 
             annotations: d.annotations.filter(r => r.pageIndex !== d.currIndex),
             redoStack: [] // Clearing page is destructive, simplify by clearing redo
           }))} title="清除本頁">
             <Eraser className="w-4 h-4" />
           </Button>
           
           <div className="w-px h-5 bg-slate-300 mx-1"></div>
           
           <Button onClick={handleSaveClick} disabled={processing.isProcessing}>
             {processing.isProcessing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Download className="w-4 h-4 mr-2" />}
             儲存
           </Button>
        </div>
      </header>

      {/* Main Content */}
      {activeDoc ? (
        <div className="flex flex-1 overflow-hidden relative">
          {/* Sidebar */}
          <aside className="w-56 bg-white border-r border-slate-200 flex flex-col hidden md:flex overflow-hidden">
             <div className="p-3 border-b border-slate-100 font-medium text-slate-500 text-xs uppercase tracking-wider">
               {activeDoc.numPages} 頁面
             </div>
             <div className="flex-1 overflow-y-auto p-3 space-y-3">
               {Array.from({ length: activeDoc.numPages }).map((_, i) => (
                 <PageThumbnail
                   key={i}
                   doc={activeDoc}
                   pageIndex={i}
                   isActive={activeDoc.currIndex === i}
                   onClick={() => updateActiveDoc(() => ({ currIndex: i }))}
                 />
               ))}
             </div>
          </aside>

          {/* Canvas */}
          <main className="flex-1 bg-slate-100 relative overflow-hidden flex flex-col">
             {/* Float Controls */}
             <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur rounded-full shadow-lg border border-slate-200 p-1.5 flex items-center gap-3 z-10 px-4 transition-opacity hover:opacity-100 opacity-80">
                <button onClick={() => updateActiveDoc(d => ({ currIndex: Math.max(0, d.currIndex - 1) }))} disabled={activeDoc.currIndex === 0} className="p-1 hover:text-blue-600 disabled:opacity-30">
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <span className="text-sm font-mono min-w-[3ch] text-center">{activeDoc.currIndex + 1} / {activeDoc.numPages}</span>
                <button onClick={() => updateActiveDoc(d => ({ currIndex: Math.min(d.numPages - 1, d.currIndex + 1) }))} disabled={activeDoc.currIndex === activeDoc.numPages - 1} className="p-1 hover:text-blue-600 disabled:opacity-30">
                  <ChevronRight className="w-5 h-5" />
                </button>
                <div className="w-px h-4 bg-slate-300"></div>
                <button onClick={() => updateActiveDoc(d => ({ scale: Math.max(0.5, d.scale - 0.25) }))} className="p-1 hover:text-blue-600">
                  <ZoomOut className="w-4 h-4" />
                </button>
                <span className="text-xs font-mono w-10 text-center">{Math.round(activeDoc.scale * 100)}%</span>
                <button onClick={() => updateActiveDoc(d => ({ scale: Math.min(3.0, d.scale + 0.25) }))} className="p-1 hover:text-blue-600">
                  <ZoomIn className="w-4 h-4" />
                </button>
             </div>

             <div 
               className="flex-1 overflow-auto relative"
               ref={containerRef}
             >
                <div className="min-h-full min-w-full flex items-center justify-center p-8">
                  <div className={clsx(
                    "relative shadow-2xl transition-cursor bg-white",
                    mode === 'edit' && toolType === 'text' ? 'cursor-text' : 
                    mode === 'edit' && toolType === 'pen' ? 'cursor-crosshair' : 
                    mode === 'edit' ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"
                  )}>
                    <canvas 
                      ref={canvasRef}
                      onMouseDown={onMouseDown}
                      onMouseMove={onMouseMove}
                      onMouseUp={onMouseUp}
                      onMouseLeave={onMouseUp}
                      onClick={handleCanvasClick}
                      onDoubleClick={handleDoubleClick}
                      className="block"
                    />
                  </div>
                </div>
             </div>
          </main>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-slate-400">
          <div className="text-center">
            <Ban className="w-12 h-12 mx-auto mb-2 opacity-20" />
            <p>無開啟的文件</p>
          </div>
        </div>
      )}

      {/* Save Modal */}
      {showSaveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-semibold text-lg text-slate-800">下載檔案</h3>
              <button 
                onClick={() => setShowSaveModal(false)}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6">
              <label className="block text-sm font-medium text-slate-700 mb-2">
                檔案名稱
              </label>
              <div className="relative">
                <input 
                  type="text" 
                  value={saveFileName}
                  onChange={(e) => setSaveFileName(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none pr-12"
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && performSave()}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm select-none">
                  .pdf
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-2">
                將會處理所有頁面的編輯內容並產生新的 PDF 檔案。
              </p>
            </div>
            <div className="px-6 py-4 bg-slate-50 flex items-center justify-end gap-3 border-t border-slate-100">
              <Button variant="ghost" onClick={() => setShowSaveModal(false)}>
                取消
              </Button>
              <Button onClick={performSave}>
                <Download className="w-4 h-4 mr-2" />
                確認下載
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}