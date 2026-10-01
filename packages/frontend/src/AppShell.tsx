import { useEffect, useState, type ReactNode } from "react";
import Icon, { type IconName } from "./ui/icons.js";
import { navigate } from "./router.js";

export interface NavItem {
  id: string;
  label: string;
}

export interface NavGroup {
  id: string;
  label: string;
  icon: IconName;
  items: NavItem[];
  /** Pl. nyugtázatlan riasztások száma — rendellenesség, ezért riasztásszínű. */
  badge?: number;
}

export function pathOf(group: NavGroup, item: NavItem): string {
  return `/${group.id}/${item.id}`;
}

const COLLAPSED_KEY = "mes.sidebarCollapsed";
const MOBILE_QUERY = "(max-width: 900px)";

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return mobile;
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Alkalmazás-keret: bal oldalsáv kétszintű navigációval (modul → nézet),
 * felső sáv morzsamenüvel és kapcsolati állapottal, alatta EGY nézet.
 *
 * - Asztali nézetben az oldalsáv ikonsávra csukható (megjegyzi).
 * - 900 px alatt az oldalsáv rejtett, a felső sáv menügombja nyitja rá.
 */
export default function AppShell({
  groups,
  activeGroupId,
  activeItemId,
  connected,
  role,
  onSignOut,
  topBarControls,
  children,
}: {
  groups: NavGroup[];
  activeGroupId: string;
  activeItemId: string;
  connected: boolean;
  role: string;
  onSignOut: () => void;
  /** A felső sáv bal oldalán, a morzsamenü után (hatókör-választó). */
  topBarControls?: ReactNode;
  children: ReactNode;
}) {
  const [collapsedPref, setCollapsed] = useState(readCollapsed);
  const isMobile = useIsMobile();
  // Mobilon nincs ikonsáv: ott az oldalsáv rátét, mindig teljes címkékkel.
  const collapsed = collapsedPref && !isMobile;
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([activeGroupId]));

  // Az aktív modul mindig nyitva van (pl. link vagy vissza gomb után).
  useEffect(() => {
    setExpanded((prev) => (prev.has(activeGroupId) ? prev : new Set(prev).add(activeGroupId)));
    setMobileOpen(false);
  }, [activeGroupId, activeItemId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, collapsedPref ? "1" : "0");
    } catch {
      /* privát mód: nem baj, csak nem jegyzi meg */
    }
  }, [collapsedPref]);

  const activeGroup = groups.find((g) => g.id === activeGroupId);
  const activeItem = activeGroup?.items.find((i) => i.id === activeItemId);

  function go(group: NavGroup, item: NavItem) {
    navigate(pathOf(group, item));
  }

  function toggleGroup(group: NavGroup) {
    // Egyelemes modul, vagy ikonsáv módban: közvetlenül az első nézetre ugrik.
    if (group.items.length === 1 || collapsed) return go(group, group.items[0]!);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(group.id)) next.delete(group.id);
      else next.add(group.id);
      return next;
    });
  }

  return (
    <div className="shell" data-collapsed={collapsed ? "true" : undefined} data-mobile-open={mobileOpen ? "true" : undefined}>
      {mobileOpen && <div className="shell-scrim" onClick={() => setMobileOpen(false)} />}
      <aside className="shell-nav" aria-label="Main navigation">
        <div className="shell-brand">
          <span className="shell-brand-mark" aria-hidden="true" />
          <span className="shell-brand-name">MES</span>
        </div>
        <nav className="shell-groups">
          {groups.map((group) => {
            const isActive = group.id === activeGroupId;
            const isOpen = expanded.has(group.id) && !collapsed && group.items.length > 1;
            return (
              <div key={group.id} className="shell-group">
                <button
                  type="button"
                  className="shell-group-btn"
                  data-active={isActive ? "true" : undefined}
                  aria-expanded={group.items.length > 1 && !collapsed ? isOpen : undefined}
                  aria-current={group.items.length === 1 && isActive ? "page" : undefined}
                  title={collapsed ? group.label : undefined}
                  onClick={() => toggleGroup(group)}
                >
                  <Icon name={group.icon} />
                  <span className="shell-label">{group.label}</span>
                  {group.badge ? (
                    <span className="shell-badge num" aria-label={`${group.badge} unacknowledged`}>
                      {group.badge > 99 ? "99+" : group.badge}
                    </span>
                  ) : null}
                  {group.items.length > 1 && !collapsed && <span className="shell-chevron" aria-hidden="true" data-open={isOpen ? "true" : undefined} />}
                </button>
                {isOpen && (
                  <ul className="shell-items">
                    {group.items.map((item) => {
                      const current = isActive && item.id === activeItemId;
                      return (
                        <li key={item.id}>
                          <a
                            href={pathOf(group, item)}
                            className="shell-item"
                            aria-current={current ? "page" : undefined}
                            onClick={(e) => {
                              // Új lap / ablak (Ctrl/Cmd/középső gomb) maradjon a böngészőé.
                              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                              e.preventDefault();
                              go(group, item);
                            }}
                          >
                            {item.label}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </nav>
        <div className="shell-nav-foot">
          <button
            type="button"
            className="shell-group-btn shell-collapse-btn"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand sidebar" : undefined}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <Icon name="collapse" />
            <span className="shell-label">Collapse</span>
          </button>
        </div>
      </aside>

      <div className="shell-main">
        <header className="shell-top">
          <button type="button" className="ui-btn ui-btn-ghost shell-menu-btn" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Icon name="menu" />
          </button>
          <div className="shell-crumbs" aria-label="Breadcrumb">
            <span className="shell-crumb-group">{activeGroup?.label}</span>
            {activeGroup && activeGroup.items.length > 1 && activeItem && (
              <>
                <span className="shell-crumb-sep" aria-hidden="true">/</span>
                <span className="shell-crumb-item">{activeItem.label}</span>
              </>
            )}
          </div>
          {topBarControls}
          <span className="ui-toolbar-spacer" />
          {connected ? (
            <span className="shell-live">Live</span>
          ) : (
            <span className="ui-pill ui-pill-alarm" role="status">
              Disconnected, retrying
            </span>
          )}
          <span className="shell-role">{role}</span>
          <button type="button" className="ui-btn ui-btn-small" onClick={onSignOut}>
            Sign out
          </button>
        </header>
        <main className="shell-content">{children}</main>
      </div>
    </div>
  );
}
