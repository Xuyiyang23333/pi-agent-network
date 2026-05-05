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

  // ─── Role Management ───────────────────────────────────

  function startNetwork(roles: string[]): void {
    ensureRegistryDir();

    httpServer = http.createServer(handleRequest);
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer!.address();
      if (!addr || typeof addr === "string") {
        throw new Error("Failed to get server address");
      }
      serverPort = addr.port;

      const info: AgentInfo = {
        id: AGENT_ID,
        roles,
        host: "127.0.0.1",
        port: serverPort,
        status: "idle",
        startedAt: Date.now(),
      };
      writeOwnRegistry(info);
    });

    currentRoles = roles;
    pi.appendEntry(ROLE_CUSTOM_TYPE, { roles } satisfies RoleData);
  }

  function stopNetwork(): void {
    if (httpServer) {
      httpServer.close();
      httpServer = null;
      serverPort = 0;
    }
    deleteOwnRegistry();
    currentRoles = [];
    pendingSyncResponse = null;
    pendingSyncResolve = null;
  }

  // ─── /role Command ─────────────────────────────────────

  pi.registerCommand("role", {
    description: "Assign or remove agent roles. Usage: /role <name,...>, /role +name, /role -name, /role --off",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (trimmed === "--off") {
        stopNetwork();
        ctx.ui.notify("Roles cleared, left agent network", "info");
        return;
      }

      if (!trimmed) {
        if (currentRoles.length > 0) {
          ctx.ui.notify(
            `Current roles: ${currentRoles.join(", ")} (port ${serverPort})`,
            "info"
          );
        } else {
          ctx.ui.notify(
            "No roles assigned. Use /role <name,...> to join the network",
            "info"
          );
        }
        return;
      }

      let newRoles: string[];
      if (trimmed.startsWith("+")) {
        const delta = trimmed.slice(1).split(",").map(s => s.trim()).filter(Boolean);
        newRoles = [...new Set([...currentRoles, ...delta])];
      } else if (trimmed.startsWith("-")) {
        const delta = trimmed.slice(1).split(",").map(s => s.trim()).filter(Boolean);
        newRoles = currentRoles.filter(r => !delta.includes(r));
      } else {
        newRoles = [...new Set(trimmed.split(",").map(s => s.trim()).filter(Boolean))];
      }

      if (newRoles.length === 0) {
        stopNetwork();
        ctx.ui.notify("Roles cleared, left agent network", "info");
        return;
      }

      if (serverPort > 0) {
        currentRoles = newRoles;
        writeOwnRegistry({
          id: AGENT_ID,
          roles: newRoles,
          host: "127.0.0.1",
          port: serverPort,
          status: "idle",
          startedAt: Date.now(),
        });
        pi.appendEntry(ROLE_CUSTOM_TYPE, { roles: newRoles });
        ctx.ui.notify(`Roles updated: ${newRoles.join(", ")}`, "info");
      } else {
        startNetwork(newRoles);
        ctx.ui.notify(
          `Joining agent network as: ${newRoles.join(", ")}`,
          "info"
        );
      }
    },
  });

  // ─── set_role / unset_role Tools ───────────────────────

  pi.registerTool({
    name: "set_role",
    label: "Set Role",
    description:
      "Register yourself with one or more roles in the agent network. " +
      "Roles are user-defined labels like 'developer', 'reviewer', 'tester'. " +
      "After setting a role, other agents can discover and call you.",
    parameters: Type.Object({
      roles: Type.Array(Type.String(), {
        description: "List of role names to register",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const roles: string[] = params.roles;
      if (roles.length === 0) {
        stopNetwork();
        return {
          content: [{ type: "text", text: "All roles removed." }],
          details: {},
        };
      }
      if (serverPort > 0) {
        currentRoles = [...new Set(roles)];
        writeOwnRegistry({
          id: AGENT_ID,
          roles: currentRoles,
          host: "127.0.0.1",
          port: serverPort,
          status: "idle",
          startedAt: Date.now(),
        });
        pi.appendEntry(ROLE_CUSTOM_TYPE, { roles: currentRoles });
      } else {
        startNetwork(roles);
      }
      return {
        content: [{
          type: "text",
          text: `Roles set: ${currentRoles.join(", ")} (port ${serverPort})`,
        }],
        details: { roles: currentRoles, port: serverPort },
      };
    },
  });

  pi.registerTool({
    name: "unset_role",
    label: "Unset Role",
    description: "Remove all roles and leave the agent network.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      stopNetwork();
      return {
        content: [{ type: "text", text: "Left the agent network." }],
        details: {},
      };
    },
  });
}
