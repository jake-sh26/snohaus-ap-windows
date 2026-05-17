import { useEffect, useRef, useState } from "react";

/**
 * On-screen diagnostic HUD for the mobile PDF fullscreen view.
 *
 * Captures:
 *  - Viewport metrics (window.innerHeight, visualViewport, dpr)
 *  - Container heights for the fullscreen overlay + the PdfPreview scroll div
 *  - Live touch event stream (touchstart / touchmove / touchend / gesture*)
 *  - Computed touchAction / overflow for each ancestor of the PDF canvas
 *  - The most recent pointerdown/click target captured in InvoiceDrawer
 *
 * Sits at the bottom of the fullscreen overlay so the user can read it
 * directly on the iPhone without needing a connected Mac for Web Inspector.
 */
export function PdfDebugHud({ log }: { log: string[] }) {
  const [tick, setTick] = useState(0);
  const [touchStream, setTouchStream] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [scrollProbe, setScrollProbe] = useState<string>("(probing\u2026)");
  const touchStreamRef = useRef<string[]>([]);

  // Refresh viewport metrics 2x/sec.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, []);

  // Listen for touch + gesture events to detect what's actually firing.
  useEffect(() => {
    const push = (label: string) => {
      const ts = new Date().toISOString().slice(14, 23);
      touchStreamRef.current.push(`${ts} ${label}`);
      if (touchStreamRef.current.length > 30) touchStreamRef.current.shift();
      setTouchStream([...touchStreamRef.current]);
    };
    const onTS = (e: TouchEvent) => push(`touchstart n=${e.touches.length}`);
    const onTM = (e: TouchEvent) => push(`touchmove n=${e.touches.length} t0=(${e.touches[0]?.clientX|0},${e.touches[0]?.clientY|0})`);
    const onTE = (e: TouchEvent) => push(`touchend n=${e.touches.length}`);
    const onGS = () => push("gesturestart (pinch)");
    const onGC = (e: any) => push(`gesturechange scale=${e.scale?.toFixed(2)}`);
    const onGE = () => push("gestureend");
    const onWheel = (e: WheelEvent) => push(`wheel dY=${e.deltaY|0}`);
    document.addEventListener("touchstart", onTS, { passive: true, capture: true });
    document.addEventListener("touchmove", onTM, { passive: true, capture: true });
    document.addEventListener("touchend", onTE, { passive: true, capture: true });
    document.addEventListener("gesturestart", onGS as any, { passive: true, capture: true });
    document.addEventListener("gesturechange", onGC, { passive: true, capture: true });
    document.addEventListener("gestureend", onGE as any, { passive: true, capture: true });
    document.addEventListener("wheel", onWheel, { passive: true, capture: true });
    return () => {
      document.removeEventListener("touchstart", onTS, true);
      document.removeEventListener("touchmove", onTM, true);
      document.removeEventListener("touchend", onTE, true);
      document.removeEventListener("gesturestart", onGS as any, true);
      document.removeEventListener("gesturechange", onGC, true);
      document.removeEventListener("gestureend", onGE as any, true);
      document.removeEventListener("wheel", onWheel, true);
    };
  }, []);

  // Walk up from the PDF canvas container and report computed styles for each
  // ancestor. This is the smoking-gun report for "why isn't this scrolling".
  // IMPORTANT: prefer the canvas inside the fullscreen overlay if it exists
  // (there can be TWO pdf-canvas-container elements in the DOM — inline + fs).
  useEffect(() => {
    const id = setInterval(() => {
      const overlay = document.querySelector('[data-testid="pdf-fullscreen-overlay"]') as HTMLElement | null;
      const canvases = document.querySelectorAll('[data-testid="pdf-canvas-container"]');
      let canvas: HTMLElement | null = null;
      let scope = "";
      if (overlay) {
        canvas = overlay.querySelector('[data-testid="pdf-canvas-container"]') as HTMLElement | null;
        scope = "FS-OVERLAY";
      }
      if (!canvas && canvases.length) {
        canvas = canvases[canvases.length - 1] as HTMLElement;
        scope = `last-of-${canvases.length}`;
      }
      const overlayInfo = overlay
        ? (() => {
            const r = overlay.getBoundingClientRect();
            const cs = getComputedStyle(overlay);
            return `OVERLAY: ${r.width|0}x${r.height|0} @(${r.left|0},${r.top|0}) z=${cs.zIndex} pos=${cs.position} disp=${cs.display}`;
          })()
        : "OVERLAY: NOT IN DOM";
      if (!canvas) {
        setScrollProbe(`${overlayInfo}\n(no pdf-canvas-container)`);
        return;
      }
      const lines: string[] = [overlayInfo, `scope=${scope}`];
      let el: HTMLElement | null = canvas;
      let depth = 0;
      while (el && depth < 12) {
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const tid = el.getAttribute("data-testid");
        const id = tid ? `[${tid}]` : "";
        lines.push(
          `${depth} ${tag}${id} h=${rect.height|0} sh=${el.scrollHeight} ovY=${cs.overflowY} ta=${cs.touchAction}`
        );
        el = el.parentElement;
        depth++;
      }
      setScrollProbe(lines.join("\n"));
    }, 750);
    return () => clearInterval(id);
  }, []);

  const vv: any = (window as any).visualViewport;
  const meta = document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "(no meta)";

  return (
    <div
      style={{
        position: "fixed",
        left: 4,
        right: 4,
        bottom: 4,
        zIndex: 100000,
        background: "rgba(0,0,0,0.85)",
        color: "#0f0",
        fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        fontSize: 10,
        lineHeight: 1.25,
        padding: 6,
        borderRadius: 6,
        border: "1px solid #0f0",
        maxHeight: collapsed ? 24 : "45vh",
        overflowY: "auto",
        WebkitOverflowScrolling: "touch" as any,
        pointerEvents: "auto",
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      data-testid="pdf-debug-hud"
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <strong style={{ color: "#ff0" }}>PDF DEBUG HUD (tick {tick})</strong>
        <button
          onClick={() => setCollapsed((c) => !c)}
          style={{ color: "#0f0", background: "transparent", border: "1px solid #0f0", padding: "1px 6px", fontSize: 10 }}
        >
          {collapsed ? "+" : "\u2013"}
        </button>
      </div>
      {!collapsed && (
        <>
          <div style={{ color: "#9ff" }}>
            innerH={window.innerHeight} innerW={window.innerWidth} dpr={window.devicePixelRatio}<br />
            visualV: h={vv?.height|0} w={vv?.width|0} scale={vv?.scale?.toFixed(2)} pageT={vv?.pageTop|0}<br />
            meta: {meta}
          </div>
          <div style={{ color: "#ff0", marginTop: 4 }}>--- ancestor walk (PDF \u2192 root) ---</div>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", color: "#0f8", margin: 0 }}>{scrollProbe}</pre>
          <div style={{ color: "#ff0", marginTop: 4 }}>--- touch stream (last {touchStream.length}) ---</div>
          <pre style={{ whiteSpace: "pre-wrap", color: "#fc8", margin: 0 }}>{touchStream.slice(-12).join("\n")}</pre>
          <div style={{ color: "#ff0", marginTop: 4 }}>--- pointer/click log (last {log.length}) ---</div>
          <pre style={{ whiteSpace: "pre-wrap", color: "#f8f", margin: 0 }}>{log.slice(-10).join("\n")}</pre>
        </>
      )}
    </div>
  );
}
