import { randomBytes, createHash } from "node:crypto";
import { pool } from "./db.js";

export type SignalSourceType = "simulated" | "gpio" | "s7" | "opcua" | "modbus";
export type StatusMode = "status_bit" | "signal_presence";

const HEARTBEAT_STALE_SECONDS = 90;

export interface EdgeNodeChannel {
  id: string;
  edgeNodeId: string;
  machineId: string | null;
  machineName: string | null;
  signalSource: SignalSourceType;
  connectionConfig: Record<string, unknown>;
  statusMode: StatusMode;
  noSignalTimeoutSeconds: number;
  acceptProductionWhileDown: boolean;
}

export interface EdgeNode {
  id: string;
  name: string;
  currentSessionId: string | null;
  lastHeartbeatAt: string | null;
  isOnline: boolean;
  createdAt: string;
  channels: EdgeNodeChannel[];
}

type NodeRow = {
  id: string;
  name: string;
  current_session_id: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
};

type ChannelRow = {
  id: string;
  edge_node_id: string;
  machine_id: string | null;
  machine_name: string | null;
  signal_source: SignalSourceType;
  connection_config: Record<string, unknown>;
  status_mode: StatusMode;
  no_signal_timeout_seconds: number;
  accept_production_while_down: boolean;
};

function toChannel(row: ChannelRow): EdgeNodeChannel {
  return {
    id: row.id,
    edgeNodeId: row.edge_node_id,
    machineId: row.machine_id,
    machineName: row.machine_name,
    signalSource: row.signal_source,
    connectionConfig: row.connection_config,
    statusMode: row.status_mode,
    noSignalTimeoutSeconds: row.no_signal_timeout_seconds,
    acceptProductionWhileDown: row.accept_production_while_down,
  };
}

function isOnlineFrom(lastHeartbeatAt: string | null): boolean {
  return (
    lastHeartbeatAt !== null && Date.now() - new Date(lastHeartbeatAt).getTime() < HEARTBEAT_STALE_SECONDS * 1000
  );
}

const CHANNEL_SELECT = `
  SELECT enc.*, m.name AS machine_name
  FROM edge_node_channels enc
  LEFT JOIN machines m ON m.id = enc.machine_id
`;

export async function listEdgeNodes(): Promise<EdgeNode[]> {
  const nodesResult = await pool.query<NodeRow>(`SELECT * FROM edge_nodes ORDER BY name`);
  const channelsResult = await pool.query<ChannelRow>(`${CHANNEL_SELECT} ORDER BY enc.created_at`);

  const channelsByNode = new Map<string, EdgeNodeChannel[]>();
  for (const row of channelsResult.rows) {
    const list = channelsByNode.get(row.edge_node_id) ?? [];
    list.push(toChannel(row));
    channelsByNode.set(row.edge_node_id, list);
  }

  return nodesResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    currentSessionId: row.current_session_id,
    lastHeartbeatAt: row.last_heartbeat_at,
    isOnline: isOnlineFrom(row.last_heartbeat_at),
    createdAt: row.created_at,
    channels: channelsByNode.get(row.id) ?? [],
  }));
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export async function createEdgeNode(name: string): Promise<{ id: string; name: string; token: string }> {
  const token = generateToken();
  const id = randomBytes(12).toString("hex");
  await pool.query(`INSERT INTO edge_nodes (id, name, token_hash) VALUES ($1, $2, $3)`, [id, name, hashToken(token)]);
  return { id, name, token };
}

export async function deleteEdgeNode(id: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM edge_nodes WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function regenerateToken(id: string): Promise<string | undefined> {
  const token = generateToken();
  const result = await pool.query(`UPDATE edge_nodes SET token_hash = $2, current_session_id = NULL WHERE id = $1`, [
    id,
    hashToken(token),
  ]);
  return (result.rowCount ?? 0) > 0 ? token : undefined;
}

export interface ChannelInput {
  machineId?: string;
  signalSource: SignalSourceType;
  connectionConfig?: Record<string, unknown>;
  statusMode?: StatusMode;
  noSignalTimeoutSeconds?: number;
  acceptProductionWhileDown?: boolean;
}

export async function addChannel(edgeNodeId: string, input: ChannelInput): Promise<EdgeNodeChannel> {
  const id = randomBytes(12).toString("hex");
  await pool.query(
    `INSERT INTO edge_node_channels
       (id, edge_node_id, machine_id, signal_source, connection_config, status_mode, no_signal_timeout_seconds, accept_production_while_down)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      edgeNodeId,
      input.machineId ?? null,
      input.signalSource,
      JSON.stringify(input.connectionConfig ?? {}),
      input.statusMode ?? "status_bit",
      input.noSignalTimeoutSeconds ?? 60,
      input.acceptProductionWhileDown ?? true,
    ],
  );
  const result = await pool.query<ChannelRow>(`${CHANNEL_SELECT} WHERE enc.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new Error("failed to load newly created channel");
  return toChannel(row);
}

export async function deleteChannel(channelId: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM edge_node_channels WHERE id = $1`, [channelId]);
  return (result.rowCount ?? 0) > 0;
}

export class DuplicateSessionError extends Error {
  constructor() {
    super("another instance of this edge node is already active");
  }
}
export class InvalidTokenError extends Error {
  constructor() {
    super("invalid token");
  }
}
export class InvalidSessionError extends Error {
  constructor() {
    super("session no longer valid — this edge node may have been claimed by another instance");
  }
}

export interface ClaimResult {
  sessionId: string;
  channels: EdgeNodeChannel[];
}

/**
 * Egy edge-agent folyamat induláskor ezzel jelentkezik be, és megkapja
 * az ÖSSZES hozzá rendelt csatorna (gép) konfigurációját egyben.
 */
export async function claimEdgeNode(token: string): Promise<ClaimResult> {
  const nodeResult = await pool.query<NodeRow>(`SELECT * FROM edge_nodes WHERE token_hash = $1`, [hashToken(token)]);
  const node = nodeResult.rows[0];
  if (!node) throw new InvalidTokenError();

  const isStale =
    node.last_heartbeat_at === null ||
    Date.now() - new Date(node.last_heartbeat_at).getTime() >= HEARTBEAT_STALE_SECONDS * 1000;

  if (node.current_session_id && !isStale) {
    throw new DuplicateSessionError();
  }

  const sessionId = randomBytes(16).toString("hex");
  await pool.query(`UPDATE edge_nodes SET current_session_id = $2, last_heartbeat_at = now() WHERE id = $1`, [
    node.id,
    sessionId,
  ]);

  const channelsResult = await pool.query<ChannelRow>(`${CHANNEL_SELECT} WHERE enc.edge_node_id = $1`, [node.id]);
  return { sessionId, channels: channelsResult.rows.map(toChannel) };
}

export async function recordHeartbeat(token: string, sessionId: string): Promise<void> {
  const result = await pool.query<{ id: string; current_session_id: string | null }>(
    `SELECT id, current_session_id FROM edge_nodes WHERE token_hash = $1`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) throw new InvalidTokenError();
  if (row.current_session_id !== sessionId) {
    throw new InvalidSessionError();
  }
  await pool.query(`UPDATE edge_nodes SET last_heartbeat_at = now() WHERE id = $1`, [row.id]);
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23503";
}