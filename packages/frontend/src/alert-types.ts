export interface Alert {
  id: string;
  /** Rendszerriasztásnál (pl. sikertelen mentés) null — ilyenkor machineName "System". */
  machineId: string | null;
  machineName: string;
  type: string;
  message: string;
  raisedAt: string;
  resolvedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}

export const ALERT_TYPE_LABEL: Record<string, string> = {
  machine_down: "Machine down",
  scrap_rate: "Scrap rate",
  backup_health: "Backup",
  raw_event_retention: "Data retention",
  ingestion_failing: "Event storage",
};

export const alertTypeLabel = (t: string) => ALERT_TYPE_LABEL[t] ?? t.replace(/_/g, " ");
