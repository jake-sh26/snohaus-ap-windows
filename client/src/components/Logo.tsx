// PNG with transparent background — looks correct on light, dark, and branded surfaces.
import logoUrl from "@assets/snohaus-logo.png";

export function SnowMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Sno-Haus"
    >
      {/* Mountain triangles */}
      <path d="M3 25 L11 11 L16 19 L21 11 L29 25 Z" fill="currentColor" fillOpacity="0.12" />
      {/* Peak strokes */}
      <path d="M3 25 L11 11 L16 19 L21 11 L29 25" />
      {/* Snowcap accents */}
      <path d="M9 14 L11 11 L13 14" />
      <path d="M19 14 L21 11 L23 14" />
      {/* Snowflake center detail */}
      <circle cx="16" cy="6" r="1" fill="currentColor" />
      <path d="M16 4 L16 8 M14 6 L18 6" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <img
        src={logoUrl}
        alt="Sno-Haus"
        className="h-7 w-auto select-none"
        draggable={false}
      />
      <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium">AP Review</span>
    </span>
  );
}
