// Tiny change notification for alerts: the Alerts panel tells the sidebar badge
// right away after an acknowledge, instead of waiting for the next poll.
type Listener = () => void;
const listeners = new Set<Listener>();

export function notifyAlertsChanged(): void {
  for (const listener of listeners) listener();
}

export function onAlertsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
