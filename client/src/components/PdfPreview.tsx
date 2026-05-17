import { useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";

// Re-render the PDF if the container width changes by more than this many pixels.
// Prevents the "page is too small / not scrollable" issue when the parent flex
// container hasn't settled at first render and reports a near-zero width.
const RESIZE_THRESHOLD_PX = 40;

// PDF.js loaded via CDN. We use the global once it's available so we don't
// have to bundle the worker into our Vite build.
const PDFJS_VERSION = "4.10.38";
const PDFJS_CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
const PDFJS_WORKER = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

let pdfjsPromise: Promise<any> | null = null;
function loadPdfJs(): Promise<any> {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = import(/* @vite-ignore */ PDFJS_CDN).then((mod) => {
    const pdfjs = mod.default || mod;
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return pdfjs;
  });
  return pdfjsPromise;
}

export function PdfPreview({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [pageCount, setPageCount] = useState(0);
  // Bumped when we want to force a re-render (e.g. parent container resized).
  const [renderKey, setRenderKey] = useState(0);
  const lastRenderedWidthRef = useRef(0);

  // Watch container size; trigger re-render when width changes meaningfully.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (Math.abs(w - lastRenderedWidthRef.current) >= RESIZE_THRESHOLD_PX) {
          setRenderKey((k) => k + 1);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setErrorMsg("");
    setPageCount(0);

    (async () => {
      try {
        const pdfjs = await loadPdfJs();
        if (cancelled) return;
        const loadingTask = pdfjs.getDocument({ url, withCredentials: false });
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        setPageCount(pdf.numPages);

        const container = containerRef.current;
        if (!container) return;
        container.innerHTML = "";

        // Use the OUTER scroll container to measure available width —
        // the inner flex column may report 0 before layout settles.
        const measureEl = scrollRef.current || container;
        const containerWidth = Math.max(
          measureEl.clientWidth,
          measureEl.getBoundingClientRect().width,
          280, // sane minimum
        );
        lastRenderedWidthRef.current = containerWidth;

        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled) return;
          const page = await pdf.getPage(i);
          const viewport1 = page.getViewport({ scale: 1 });
          // Fit width with retina scaling for sharpness, capped at 2x
          const scale = Math.min((containerWidth - 16) / viewport1.width, 2.5);
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const viewport = page.getViewport({ scale: scale * dpr });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = `${viewport.width / dpr}px`;
          canvas.style.height = `${viewport.height / dpr}px`;
          canvas.style.display = "block";
          canvas.style.marginBottom = "8px";
          canvas.style.borderRadius = "6px";
          canvas.style.boxShadow = "0 1px 2px rgba(0,0,0,.06), 0 0 0 1px rgba(0,0,0,.05)";
          canvas.style.background = "white";
          canvas.style.maxWidth = "100%";
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (cancelled) return;
          container.appendChild(canvas);
        }

        if (!cancelled) setStatus("ready");
      } catch (err: any) {
        if (cancelled) return;
        console.error("PdfPreview error:", err);
        setErrorMsg(err?.message || "Failed to load PDF");
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
    // renderKey re-triggers render on container resize
  }, [url, renderKey]);

  return (
    <div
      ref={scrollRef}
      className="relative h-full w-full overflow-y-auto overflow-x-auto rounded-md border border-border bg-muted/40 p-1"
      style={{ touchAction: 'pan-y pan-x pinch-zoom', WebkitOverflowScrolling: 'touch' as any }}
    >
      <div ref={containerRef} className="flex flex-col items-center min-h-full" data-testid="pdf-canvas-container" />
      {status === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="size-4 mr-2 animate-spin" /> Loading PDF…
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-sm text-destructive p-4 text-center">
          <AlertCircle className="size-5 mb-2" />
          <div className="font-medium">Couldn't load PDF</div>
          <div className="text-xs text-muted-foreground mt-1">{errorMsg}</div>
        </div>
      )}
      {status === "ready" && pageCount > 1 && (
        <div className="sticky bottom-1 mx-auto w-fit text-[10px] uppercase tracking-wider text-muted-foreground bg-background/90 backdrop-blur px-2 py-0.5 rounded-full border border-border">
          {pageCount} pages
        </div>
      )}
    </div>
  );
}
