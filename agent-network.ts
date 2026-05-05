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

  // ─── Registry Helpers ──────────────────────────────────

  function ensureRegistryDir(): void {
    if (!fs.existsSync(REGISTRY_DIR)) {
      fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    }
  }

  function registryPath(id: string): string {
    return path.join(REGISTRY_DIR, `${id}.json`);
  }

  function readOwnRegistry(): AgentInfo | null {
    const p = registryPath(AGENT_ID);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
  }

  function writeOwnRegistry(info: AgentInfo): void {
    ensureRegistryDir();
    fs.writeFileSync(registryPath(AGENT_ID), JSON.stringify(info, null, 2));
  }

  function deleteOwnRegistry(): void {
    const p = registryPath(AGENT_ID);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  function updateOwnStatus(status: "idle" | "busy" | "offline"): void {
    const info = readOwnRegistry();
    if (!info) return;
    info.status = status;
    writeOwnRegistry(info);
  }

  function scanRegistry(): AgentInfo[] {
    ensureRegistryDir();
    const agents: AgentInfo[] = [];
    for (const file of fs.readdirSync(REGISTRY_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(REGISTRY_DIR, file), "utf-8")
        );
        if (data.id && Array.isArray(data.roles)) {
          agents.push(data);
        }
      } catch {
        // corrupt file, skip
      }
    }
    return agents;
  }

  function markOffline(agentId: string): void {
    const p = registryPath(agentId);
    if (!fs.existsSync(p)) return;
    try {
      const info: AgentInfo = JSON.parse(fs.readFileSync(p, "utf-8"));
      info.status = "offline";
      fs.writeFileSync(p, JSON.stringify(info, null, 2));
    } catch {
      // ignore — file may be corrupted or deleted concurrently
    }
  }
}
