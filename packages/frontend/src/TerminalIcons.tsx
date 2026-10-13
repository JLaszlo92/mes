/** Stroke icons of the terminal (24×24, currentColor), decorative: the button text says what they do. */
type P = { size?: number; color?: string };

function Svg({ size = 28, color = "currentColor", children, width = 2 }: P & { children: React.ReactNode; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const IconStop = (p: P) => (
  <Svg {...p} width={2.2}>
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </Svg>
);
export const IconPlay = (p: P) => (
  <Svg {...p} width={2.2}>
    <polygon points="7 4 20 12 7 20 7 4" />
  </Svg>
);
export const IconFault = (p: P) => (
  <Svg {...p}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Svg>
);
export const IconPulse = (p: P) => (
  <Svg {...p}>
    <path d="M3 12h4l3-8 4 16 3-8h4" />
  </Svg>
);
export const IconRuler = (p: P) => (
  <Svg {...p}>
    <path d="M21.3 8.7 8.7 21.3a1 1 0 0 1-1.4 0l-4.6-4.6a1 1 0 0 1 0-1.4L15.3 2.7a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4z" />
    <path d="m7.5 10.5 2 2" />
    <path d="m10.5 7.5 2 2" />
    <path d="m13.5 4.5 2 2" />
    <path d="m4.5 13.5 2 2" />
  </Svg>
);
export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M19 6l-1 14H6L5 6" />
  </Svg>
);
export const IconDoc = (p: P) => (
  <Svg {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M8 13h8" />
    <path d="M8 17h6" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p} width={2.4}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);
export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);
export const IconX = (p: P) => (
  <Svg {...p} width={2.2}>
    <circle cx="12" cy="12" r="10" />
    <path d="M15 9l-6 6" />
    <path d="M9 9l6 6" />
  </Svg>
);
export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Svg>
);
export const IconChevronLeft = (p: P) => (
  <Svg {...p} width={2.2}>
    <path d="M15 18l-6-6 6-6" />
  </Svg>
);
export const IconChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="M9 18l6-6-6-6" />
  </Svg>
);
export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);
export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </Svg>
);
export const IconPause = (p: P) => (
  <Svg {...p} width={2.4}>
    <rect x="6" y="5" width="4" height="14" />
    <rect x="14" y="5" width="4" height="14" />
  </Svg>
);
export const IconHistory = (p: P) => (
  <Svg {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l3 2" />
  </Svg>
);

/** The state symbol in the status band: a shape per state, so the state never rests on colour alone. */
export function StateIcon({ tone, size = 44 }: { tone: "run" | "down" | "planned" | "idle"; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      {tone === "run" && <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" />}
      {tone === "down" && <rect x="8.5" y="8.5" width="7" height="7" fill="currentColor" />}
      {tone === "planned" && (
        <>
          <rect x="8.5" y="8" width="2.4" height="8" fill="currentColor" stroke="none" />
          <rect x="13.1" y="8" width="2.4" height="8" fill="currentColor" stroke="none" />
        </>
      )}
      {tone === "idle" && <path d="M8 12h8" strokeWidth={2.6} strokeLinecap="round" />}
    </svg>
  );
}
