import Drawer from "./ui/Drawer.js";
import { formatDateTime, formatDuration } from "./ui/format.js";
import { alertTypeLabel, type Alert } from "./alert-types.js";

/** Full text and facts of one alert; the tables cut the message to fit their column. */
export default function AlertDetailsDrawer({ alert, onClose }: { alert: Alert; onClose: () => void }) {
  const endMs = alert.resolvedAt ? Date.parse(alert.resolvedAt) : Date.now();
  const durationSeconds = Math.max(0, (endMs - Date.parse(alert.raisedAt)) / 1000);
  return (
    <Drawer title={alertTypeLabel(alert.type)} subtitle={alert.machineName} onRequestClose={onClose}>
      <section className="ui-section">
        <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{alert.message}</p>
      </section>
      <section className="ui-section">
        <dl className="ui-facts">
          <dt>Machine</dt>
          <dd>{alert.machineName}</dd>
          <dt>Type</dt>
          <dd>{alertTypeLabel(alert.type)}</dd>
          <dt>Raised</dt>
          <dd>{formatDateTime(alert.raisedAt)}</dd>
          <dt>Status</dt>
          <dd>
            {alert.resolvedAt ? `Resolved ${formatDateTime(alert.resolvedAt)}` : "Open"}
            {" · "}
            {formatDuration(durationSeconds)}
          </dd>
          <dt>Acknowledged</dt>
          <dd>{alert.acknowledgedAt ? formatDateTime(alert.acknowledgedAt) : "No"}</dd>
        </dl>
      </section>
    </Drawer>
  );
}
