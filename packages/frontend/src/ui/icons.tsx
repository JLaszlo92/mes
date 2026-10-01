/** Navigációs ikonok — egyszerű, egyvonalas SVG-k, hogy ne kelljen ikonkönyvtár. */
const base = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export type IconName = "overview" | "production" | "quality" | "maintenance" | "alerts" | "admin" | "collapse" | "menu";

export default function Icon({ name }: { name: IconName }) {
  switch (name) {
    case "overview":
      return (
        <svg {...base} aria-hidden="true">
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
        </svg>
      );
    case "production":
      return (
        <svg {...base} aria-hidden="true">
          <path d="M3 20.5V10l5.5 3.5V10l5.5 3.5V6.5l7 3.5v10.5z" />
          <path d="M7 17h2M12 17h2M17 17h1" />
        </svg>
      );
    case "quality":
      return (
        <svg {...base} aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" />
          <path d="m8.5 12.2 2.4 2.4 4.6-5.2" />
        </svg>
      );
    case "maintenance":
      return (
        <svg {...base} aria-hidden="true">
          <path d="M14.7 6.3a4 4 0 0 0-5.2 5.2L4 17l3 3 5.5-5.5a4 4 0 0 0 5.2-5.2l-2.4 2.4-2.6-.4-.4-2.6z" />
        </svg>
      );
    case "alerts":
      return (
        <svg {...base} aria-hidden="true">
          <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" />
          <path d="M10 20.5a2 2 0 0 0 4 0" />
        </svg>
      );
    case "admin":
      return (
        <svg {...base} aria-hidden="true">
          <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
          <circle cx="15" cy="6" r="2" />
          <circle cx="9" cy="12" r="2" />
          <circle cx="17" cy="18" r="2" />
        </svg>
      );
    case "collapse":
      return (
        <svg {...base} aria-hidden="true">
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M9 4.5v15" />
        </svg>
      );
    case "menu":
      return (
        <svg {...base} aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      );
  }
}
