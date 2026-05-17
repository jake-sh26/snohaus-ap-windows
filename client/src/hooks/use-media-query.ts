import { useState, useEffect } from "react";

/**
 * Custom hook that returns true while the media query matches.
 * Example: useMediaQuery("(max-width: 767px)") returns true on mobile.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Use addListener for legacy compat, addEventListener for modern
    if (mql.addEventListener) {
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    } else {
      // Fallback for older browsers
      (mql as any).addListener(handler);
      return () => (mql as any).removeListener(handler);
    }
  }, [query]);

  return matches;
}

/** Returns true when viewport width < 768px (mobile breakpoint) */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}
