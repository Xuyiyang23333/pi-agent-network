/**
 * pi-agent-network — P2P multi-agent collaboration
 *
 * Agents discover each other via ~/.pi/agent/registry/ and communicate
 * via HTTP. The LLM calls other agents through the `call` tool.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

// ─── Types ───────────────────────────────────────────────

interface AgentInfo {
  id: string;
  roles: string[];
  host: string;
  port: number;
  status: "idle" | "busy" | "offline";
  startedAt: number;
}

interface CallRequest {
  from: string;
  to: string;
  message: string;
  synchronous: boolean;
}

interface CallResponse {
  reply?: string;
  error?: string;
  accepted?: boolean;
}

interface PendingReply {
  from: string;
  reply: string;
  timestamp: number;
}

interface RoleData {
  roles: string[];
}

// ─── Constants ───────────────────────────────────────────

const REGISTRY_DIR = path.join(os.homedir(), ".pi", "agent", "registry");
const ROLE_CUSTOM_TYPE = "agent-network-role";
const AGENT_ID = randomUUID();
const REPLY_TTL_MS = 60 * 60 * 1000; // 1 hour

export default function (pi: ExtensionAPI) {
  // ─── Module State ──────────────────────────────────────

  let currentRoles: string[] = [];
  let httpServer: http.Server | null = null;
  let serverPort: number = 0;

  // Incoming synchronous call: resolve when agent_end fires
  let pendingSyncResolve: ((reply: string) => void) | null = null;
  let pendingSyncResponse: http.ServerResponse | null = null;

  // Pending async replies: Map<callerId, PendingReply[]>
  const pendingReplies = new Map<string, PendingReply[]>();
}
