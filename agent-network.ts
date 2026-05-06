/**
 * pi-agent-network — P2P multi-agent collaboration
 *
 * Agents discover each other via ~/.pi/agent/registry/ and communicate
 * via HTTP. The LLM calls other agents through the `call` tool.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
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
  status: "idle" | "busy";
  startedAt: number;
}

interface CallRequest {
  from: string;
  to: string;
  message: string;
  synchronous: boolean;
  fromRoles?: string[];
  replyHost?: string;
  replyPort?: number;
  isReply?: boolean;
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
const STATUS_KEY = "agent-roles";
const ROLE_CUSTOM_TYPE = "agent-network-role";
const AGENT_ID = randomUUID();
const REPLY_TTL_MS = 60 * 60 * 1000; // 1 hour

export default function (pi: ExtensionAPI) {
  // ─── Module State ──────────────────────────────────────

  let currentRoles: string[] = [];
  let httpServer: http.Server | null = null;
  let serverPort: number = 0;

  // Incoming synchronous call: resolve when agent_end fires
  let pendingSyncResolve: ((reply: string) => Promise<void>) | null = null;
  let pendingSyncResponse: http.ServerResponse | null = null;

  // Pending async replies: Map<callerId, PendingReply[]>
  const pendingReplies = new Map<string, PendingReply[]>();

  // Track busy→idle transition for pending-reply notification
  let wasBusy = false;

  // Track async reply avoidance: if LLM already called the caller back,
  // skip the agent_end isReply delivery to avoid double-delivery.
  let pendingAsyncCaller: string | null = null;
  let callerRepliedViaCall: boolean = false;

  // Footer status display — stored from session_start
  let storedUi: {
    setStatus(key: string, text: string | undefined): void;
    theme: { fg(color: string, text: string): string };
  } | null = null;

  function updateFooterStatus(roles: string[]): void {
    if (!storedUi) return;
    if (roles.length === 0) {
      storedUi.setStatus(STATUS_KEY, undefined);
    } else {
      storedUi.setStatus(STATUS_KEY, storedUi.theme.fg("accent", "🎭 " + roles.join(", ")));
    }
  }

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
    const p = registryPath(AGENT_ID);
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(info, null, 2));
    fs.renameSync(tmp, p);
  }

  function deleteOwnRegistry(): void {
    const p = registryPath(AGENT_ID);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    const tmp = p + ".tmp";
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }

  function updateOwnStatus(status: "idle" | "busy"): void {
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
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // ignore — file may be deleted concurrently
    }
  }

  // ─── Role Management ───────────────────────────────────

  function startNetwork(roles: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      ensureRegistryDir();
      httpServer = http.createServer(handleRequest);
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer!.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Failed to get server address"));
          return;
        }
        serverPort = addr.port;

        currentRoles = roles;
        pi.appendEntry(ROLE_CUSTOM_TYPE, { roles } satisfies RoleData);

        pi.sendMessage({
          customType: ROLE_CUSTOM_TYPE,
          content: `你已加入 agent 网络，当前角色: ${roles.join("、")}。` +
            `其他 agent 可以通过 \`call\` 工具调用你，你也可以使用 \`list_agents\` 发现其他 agent，` +
            `用 \`call\` 与他们通信。`,
          display: true,
        });

        const info: AgentInfo = {
          id: AGENT_ID,
          roles,
          host: "127.0.0.1",
          port: serverPort,
          status: "idle",
          startedAt: Date.now(),
        };
        writeOwnRegistry(info);
        resolve();
      });

      httpServer.on("error", (err) => {
        reject(err);
      });
    });
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
    pendingReplies.clear();
    wasBusy = false;
    pendingAsyncCaller = null;
    callerRepliedViaCall = false;
  }

  // ─── /role Command ─────────────────────────────────────

  pi.registerCommand("role", {
    description: "Assign or remove agent roles. Usage: /role <name,...>, /role +name, /role -name, /role --off",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (trimmed === "--off") {
        pi.sendMessage({
          customType: ROLE_CUSTOM_TYPE,
          content: "你已退出 agent 网络，不再接受其他 agent 的调用。",
          display: true,
        });
        stopNetwork();
        updateFooterStatus([]);
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
        pi.sendMessage({
          customType: ROLE_CUSTOM_TYPE,
          content: "你已退出 agent 网络，不再接受其他 agent 的调用。",
          display: true,
        });
        stopNetwork();
        updateFooterStatus([]);
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
        pi.sendMessage({
          customType: ROLE_CUSTOM_TYPE,
          content: `你的 agent 网络角色已更新为: ${newRoles.join("、")}。`,
          display: true,
        });
        updateFooterStatus(newRoles);
        ctx.ui.notify(`Roles updated: ${newRoles.join(", ")}`, "info");
      } else {
        await startNetwork(newRoles);
        updateFooterStatus(newRoles);
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
        pi.sendMessage({
          customType: ROLE_CUSTOM_TYPE,
          content: "你已退出 agent 网络，不再接受其他 agent 的调用。",
          display: true,
        });
        stopNetwork();
        updateFooterStatus([]);
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
        pi.sendMessage({
          customType: ROLE_CUSTOM_TYPE,
          content: `你的 agent 网络角色已更新为: ${currentRoles.join("、")}。`,
          display: true,
        });
        updateFooterStatus(currentRoles);
      } else {
        await startNetwork(roles);
        updateFooterStatus(roles);
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
      pi.sendMessage({
        customType: ROLE_CUSTOM_TYPE,
        content: "你已退出 agent 网络，不再接受其他 agent 的调用。",
        display: true,
      });
      stopNetwork();
      updateFooterStatus([]);
      return {
        content: [{ type: "text", text: "Left the agent network." }],
        details: {},
      };
    },
  });

  // ─── HTTP Server ───────────────────────────────────────

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "POST" || req.url !== "/message") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    let body = "";
    req.on("error", () => {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "request error" }));
    });
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let callReq: CallRequest;
      try {
        callReq = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
      }

      // Validate required fields
      if (
        typeof callReq.from !== "string" ||
        typeof callReq.to !== "string" ||
        typeof callReq.message !== "string" ||
        typeof callReq.synchronous !== "boolean"
      ) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "missing required fields" }));
        return;
      }

      // Incoming async reply: if we're busy, store in mailbox;
      // if idle, inject directly into conversation with [异步回复] prefix.
      if (callReq.isReply) {
        const ownInfo = readOwnRegistry();
        if (ownInfo?.status === "busy") {
          // Busy: store in mailbox for later check_reply
          const replies = pendingReplies.get(callReq.from) || [];
          replies.push({ from: callReq.from, reply: callReq.message, timestamp: Date.now() });
          pendingReplies.set(callReq.from, replies);
          res.writeHead(200);
          res.end(JSON.stringify({ accepted: true }));
          return;
        }
        // Idle: inject directly — LLM sees it immediately
        const senderRoles = callReq.fromRoles?.length
          ? callReq.fromRoles.join("、")
          : `(unknown, id=${callReq.from.slice(0, 8)})`;
        const formattedMsg = `[异步回复] 来自 ${callReq.from.slice(0, 8)}，发送方: ${senderRoles}\n${callReq.message}`;
        wasBusy = true;
        updateOwnStatus("busy");
        pendingSyncResolve = async () => {}; // dummy: trigger idle restore in agent_end
        pi.sendUserMessage(formattedMsg, { deliverAs: "followUp" });
        res.writeHead(200);
        res.end(JSON.stringify({ accepted: true }));
        return;
      }

      // Check if we're busy
      const ownInfo = readOwnRegistry();
      if (ownInfo && ownInfo.status === "busy") {
        res.writeHead(409);
        res.end(JSON.stringify({ error: "busy" }));
        return;
      }

      // Mark busy
      wasBusy = true;
      updateOwnStatus("busy");

      const senderRoles = callReq.fromRoles?.length
        ? callReq.fromRoles.join("、")
        : `(unknown, id=${callReq.from.slice(0, 8)})`;
      const formattedMsg = callReq.synchronous
        ? `[同步调用] 来自 ${callReq.from.slice(0, 8)}，发送方: ${senderRoles}\n${callReq.message}`
        : `[异步消息] 来自 ${callReq.from.slice(0, 8)}，发送方: ${senderRoles}\n${callReq.message}`;

      if (callReq.synchronous) {
        pendingSyncResponse = res;
        pendingSyncResolve = null;
        pi.sendUserMessage(formattedMsg, { deliverAs: "steer" });
        // Response sent in agent_end handler
      } else {
        // Async: accept immediately
        res.writeHead(202);
        res.end(JSON.stringify({ accepted: true }));

        // Receiver always sends isReply: true — the caller's handleRequest
        // decides the delivery path based on its own (accurate) status.
        // Dead-letter fallback if the caller is unreachable.
        if (callReq.replyHost && callReq.replyPort) {
          pendingAsyncCaller = callReq.from;
          pendingSyncResolve = async (reply: string) => {
            const result = await httpPost(callReq.replyHost as string, callReq.replyPort as number, {
              from: AGENT_ID,
              to: callReq.from,
              message: reply,
              synchronous: false,
              fromRoles: currentRoles,
              isReply: true,
            });
            if (result.error) {
              // Dead letter: store locally so it isn't silently lost
              const replies = pendingReplies.get(callReq.from) || [];
              replies.push({ from: AGENT_ID, reply, timestamp: Date.now() });
              pendingReplies.set(callReq.from, replies);
            }
          };
        } else {
          pendingSyncResolve = async (reply: string) => {
            const replies = pendingReplies.get(callReq.from) || [];
            replies.push({ from: AGENT_ID, reply, timestamp: Date.now() });
            pendingReplies.set(callReq.from, replies);
          };
        };

        pi.sendUserMessage(formattedMsg, { deliverAs: "followUp" });
      }
    });
  }

  // ─── HTTP Client ───────────────────────────────────────

  function httpPost(
    host: string,
    port: number,
    body: CallRequest
  ): Promise<CallResponse> {
    return new Promise((resolve) => {
      const data = JSON.stringify(body);
      const req = http.request(
        {
          hostname: host,
          port,
          path: "/message",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
          },
        },
        (res) => {
          let responseBody = "";
          res.on("data", (chunk) => (responseBody += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(responseBody));
            } catch {
              resolve({ error: "invalid response" });
            }
          });
        }
      );

      req.on("error", () => {
        resolve({ error: "connection failed" });
      });

      req.write(data);
      req.end();
    });
  }

  // ─── call Tool ─────────────────────────────────────────

  pi.registerTool({
    name: "call",
    label: "Call Agent",
    description:
      "Call another agent in the network by its role name. " +
      "Use synchronous=true (default) to wait for a reply, " +
      "or synchronous=false to send and continue without waiting. " +
      "IMPORTANT: messages prefixed with [同步调用] are synchronous calls " +
      "whose replies are forwarded automatically — respond directly, do NOT use the call tool.",
    promptGuidelines: [
      "When you receive a message prefixed with [同步调用] 来自 ..., " +
      "the caller is waiting for your reply. Process the request and respond " +
      "with your answer directly — your response text is forwarded automatically. " +
      "Do NOT use the call tool to reply.",
      "When you receive a message prefixed with [异步消息] 来自 ..., " +
      "the caller is NOT waiting. You may use the call tool later to respond " +
      "if needed.",
      "After calling another agent with synchronous=false, do NOT wait or poll. " +
      "Your message has been delivered. End your turn. Use check_reply later " +
      "to see if a response has arrived.",
    ],
    parameters: Type.Object({
      to: Type.String({
        description: "Target role name, e.g. 'reviewer', 'tester'. Use comma to target multiple roles (async only).",
      }),
      message: Type.String({
        description: "Message to send to the target agent",
      }),
      synchronous: Type.Optional(Type.Boolean({
        description: "Wait for reply (true, default) or fire-and-forget (false)",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const to: string = params.to;
      const message: string = params.message;
      const synchronous: boolean = params.synchronous ?? true;
      const targetRoles = to.split(",").map(s => s.trim()).filter(Boolean);

      if (targetRoles.length === 0) {
        return {
          content: [{ type: "text", text: "未指定目标角色。" }],
          details: { error: "no target" },
        };
      }

      if (synchronous && targetRoles.length > 1) {
        return {
          content: [{ type: "text", text: "多目标仅支持异步模式（synchronous: false）。" }],
          details: { error: "multi-target requires async" },
        };
      }

      // Deadlock prevention: mark self BUSY before blocking on outbound sync call
      if (synchronous) {
        updateOwnStatus("busy");
      }

      const agents = scanRegistry();

      // Resolve target agent for each role
      const resolved: { role: string; agent: AgentInfo | null; error?: string }[] = [];
      for (const role of targetRoles) {
        const candidates = agents.filter(
          (a) => a.roles.includes(role) && a.id !== AGENT_ID
        );
        if (candidates.length === 0) {
          resolved.push({ role, agent: null, error: "no agent" });
          continue;
        }
        // Prefer idle
        const idle = candidates.filter((a) => a.status === "idle");
        const target = idle.length > 0
          ? idle[Math.floor(Math.random() * idle.length)]
          : candidates[0];
        resolved.push({ role, agent: target });
      }

      // ── Synchronous single-target (original behavior) ──
      if (synchronous) {
        const { role, agent } = resolved[0];
        if (!agent) {
          updateOwnStatus("idle");
          return {
            content: [{ type: "text", text: `没有找到可用的 '${role}' 角色的 agent。` }],
            details: { error: `no ${role} agent available` },
          };
        }
        const t = agent;
        const requestBody: CallRequest = {
          from: AGENT_ID, to: role, message, synchronous: true,
          fromRoles: currentRoles,
        };
        const result = await httpPost(t.host, t.port, requestBody);

        if (result.error === "busy") {
          updateOwnStatus("idle");
          return {
            content: [{ type: "text", text: `${role} (${t.id}) 正忙，请稍后重试。` }],
            details: { error: "busy", agentId: t.id },
          };
        }
        if (result.error) {
          markOffline(t.id);
          updateOwnStatus("idle");
          return {
            content: [{ type: "text", text: `${role} (${t.id}) 无法连接，已标记为离线。` }],
            details: { error: "connection failed", agentId: t.id },
          };
        }
        updateOwnStatus("idle");
        return {
          content: [{ type: "text", text: result.reply || "(empty reply)" }],
          details: { reply: result.reply, from: t.id },
        };
      }

      // ── Async — parallel send to all resolved targets ──
      const sendPromises = resolved.map(async ({ role, agent, error }) => {
        if (!agent) return { role, error: error! };
        const t = agent;
        const requestBody: CallRequest = {
          from: AGENT_ID, to: role, message, synchronous: false,
          fromRoles: currentRoles,
          replyHost: "127.0.0.1", replyPort: serverPort,
        };
        const result = await httpPost(t.host, t.port, requestBody);
        if (result.error === "busy") return { role, agentId: t.id, error: "busy" };
        if (result.error) {
          markOffline(t.id);
          return { role, agentId: t.id, error: "connection failed" };
        }
        // Track for double-delivery avoidance
        if (pendingAsyncCaller && t.id === pendingAsyncCaller) {
          callerRepliedViaCall = true;
        }
        return { role, agentId: t.id };
      });

      const results = await Promise.all(sendPromises);
      const sent = results.filter(r => !r.error).length;
      const isMulti = targetRoles.length > 1;

      if (isMulti) {
        const lines = [`已发送给 ${sent}/${targetRoles.length} 个角色。`];
        for (const r of results) {
          if (r.error) lines.push(`  ${r.role}: ${r.error}`);
          else lines.push(`  ${r.role} (${r.agentId})`);
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { results },
        };
      } else {
        const r = results[0];
        if (r.error === "no agent") {
          return {
            content: [{ type: "text", text: `没有找到可用的 '${r.role}' 角色的 agent。` }],
            details: { error: `no ${r.role} agent available` },
          };
        }
        if (r.error === "busy") {
          return {
            content: [{ type: "text", text: `${r.role} (${r.agentId}) 正忙，请稍后重试。` }],
            details: { error: "busy", agentId: r.agentId },
          };
        }
        if (r.error) {
          return {
            content: [{ type: "text", text: `${r.role} (${r.agentId}) 无法连接，已标记为离线。` }],
            details: { error: "connection failed", agentId: r.agentId },
          };
        }
        return {
          content: [{ type: "text", text: `已发送给 ${r.role} (${r.agentId})` }],
          details: { accepted: true, agentId: r.agentId },
        };
      }
    },
    renderCall(_args, theme, context) {
      const to = (_args.to as string) || "?";
      const sync = (_args.synchronous as boolean) ?? true;
      const msg = (_args.message as string) || "";
      const mode = sync ? "(sync)" : "(async)";
      const displayMsg = msg.length > 300 ? msg.slice(0, 300) + "…" : msg;

      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        theme.fg("accent", theme.bold("📞 " + to)) +
        " " + theme.fg("muted", mode) +
        (displayMsg ? "\n" + theme.fg("dim", displayMsg) : "")
      );
      return text;
    },
    renderResult(result, _options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const details = result.details as Record<string, unknown> | undefined;
      const expanded = _options.expanded as boolean;

      if (details?.error) {
        text.setText(theme.fg("error", `⚠ ${details.error}`));
      } else if (details?.reply) {
        const reply = details.reply as string;
        if (expanded) {
          text.setText(theme.fg("dim", "←\n" + reply));
        } else {
          const preview = reply.length > 200 ? reply.slice(0, 200) + "…" : reply;
          text.setText(
            theme.fg("dim", `← ${preview}`) +
            (reply.length > 200 ? " " + theme.fg("muted", `(${reply.length} chars, ${keyHint("app.tools.expand", "expand")})`) : "")
          );
        }
      } else if (details?.accepted) {
        text.setText(theme.fg("muted", "📨 已发送"));
      }
      return text;
    },
  });

  // ─── list_agents Tool ──────────────────────────────────

  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description:
      "List all agents currently in the network. " +
      "Optionally filter by role (e.g. 'reviewer'). " +
      "Returns agent ID, roles, status, and uptime.",
    parameters: Type.Object({
      role: Type.Optional(Type.String({
        description: "Optional: filter by role name",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const role: string | undefined = params.role;
      const agents = scanRegistry();
      const filtered = role
        ? agents.filter((a) => a.roles.includes(role))
        : agents;

      return {
        content: [{
          type: "text",
          text: filtered.length === 0
            ? "没有找到 agent。"
            : filtered.map((a) =>
                `[${a.status}] ${a.id} — ${a.roles.join(", ")} (${Math.round((Date.now() - a.startedAt) / 1000)}s)`
              ).join("\n"),
        }],
        details: {
          agents: filtered.map((a) => ({
            id: a.id,
            roles: a.roles,
            status: a.status,
            uptime: Math.round((Date.now() - a.startedAt) / 1000),
          })),
        },
      };
    },
  });

  // ─── check_reply Tool ──────────────────────────────────

  pi.registerTool({
    name: "check_reply",
    label: "Check Replies",
    description:
      "Check for pending async replies from other agents. " +
      "Call this after using call() with synchronous=false. " +
      "Optionally filter by sender agent ID.",
    promptSnippet: "Check for pending replies from async calls to other agents",
    promptGuidelines: [
      "After using call() with synchronous=false, the other agent may reply later. " +
      "Use check_reply to retrieve any pending responses when you are ready to read them. " +
      "Do NOT call check_reply in a loop — check once per turn or when the user asks.",
    ],
    parameters: Type.Object({
      from: Type.Optional(Type.String({
        description: "Optional: filter by sender agent ID",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const from: string | undefined = params.from;

      // TTL cleanup: discard replies older than 1 hour
      const now = Date.now();
      for (const [key, replies] of pendingReplies) {
        const filtered = replies.filter(r => now - r.timestamp < REPLY_TTL_MS);
        if (filtered.length === 0) {
          pendingReplies.delete(key);
        } else {
          pendingReplies.set(key, filtered);
        }
      }

      if (from) {
        const replies = pendingReplies.get(from) || [];
        pendingReplies.delete(from);
        return {
          content: [{
            type: "text",
            text: replies.length === 0
              ? `没有来自 ${from} 的待收回复。`
              : replies.map((r) => `[${from}]\n${r.reply}`).join("\n\n"),
          }],
          details: { replies },
        };
      }

      // Return all
      const all: PendingReply[] = [];
      for (const [, replies] of pendingReplies) {
        all.push(...replies);
      }
      pendingReplies.clear();

      return {
        content: [{
          type: "text",
          text: all.length === 0
            ? "没有待收回复。"
            : all.map((r) => `[${r.from}]\n${r.reply}`).join("\n\n"),
        }],
        details: { replies: all },
      };
    },
  });

  // ─── Capture & Forward Replies ─────────────────────────

  function extractText(message: unknown): string {
    if (!message) return "(no response)";
    if (typeof message === "string") return message;
    if (typeof message === "object" && message !== null && "content" in message) {
      const content = (message as { content: unknown }).content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter(
            (b: unknown) =>
              typeof b === "object" && b !== null &&
              "type" in b && (b as { type: string }).type === "text" &&
              "text" in b && typeof (b as { text: unknown }).text === "string"
          )
          .map((b) => (b as { text: string }).text)
          .join("\n") || "(no response)";
      }
    }
    return "(no response)";
  }

  pi.on("agent_end", async (event) => {
    if (!pendingSyncResponse && !pendingSyncResolve) return;

    const assistantMessages = (event.messages as Array<{ role: string; content?: unknown }>).filter(
      (m) => m.role === "assistant"
    );
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    const replyText = extractText(lastAssistant);

    // Sync: send HTTP response (sync and async are mutually exclusive by design)
    if (pendingSyncResponse) {
      if (pendingSyncResponse.writable) {
        pendingSyncResponse.writeHead(200, {
          "Content-Type": "application/json",
        });
        pendingSyncResponse.end(JSON.stringify({ reply: replyText }));
      }
      pendingSyncResponse = null;
      pendingAsyncCaller = null;
      callerRepliedViaCall = false;
      updateOwnStatus("idle");
    } else if (pendingSyncResolve) {
      // Async: deliver reply (POST back or stash locally)
      if (callerRepliedViaCall) {
        // LLM already replied via call tool, skip isReply to avoid double-delivery
        pendingSyncResolve = null;
        pendingAsyncCaller = null;
        callerRepliedViaCall = false;
        updateOwnStatus("idle");
      } else {
        await pendingSyncResolve(replyText);
        pendingSyncResolve = null;
        pendingAsyncCaller = null;
        updateOwnStatus("idle");
      }
    }

    // Notify LLM about pending replies collected while busy
    if (wasBusy) {
      let count = 0;
      for (const [, replies] of pendingReplies) count += replies.length;
      if (count > 0) {
        pi.sendMessage({
          customType: "agent-network-reply-notify",
          content: `你有 ${count} 条待收回复（来自异步调用），可以用 check_reply 查看。`,
          display: true,
        });
      }
      wasBusy = false;
    }
  });

  // ─── Lifecycle: Restore Roles on /resume ───────────────

  pi.on("session_start", async (_event, ctx) => {
    storedUi = ctx.ui;
    ensureRegistryDir();

    const entries = ctx.sessionManager.getEntries();
    let lastRole: RoleData | null = null;
    for (const entry of entries) {
      if (
        (entry as { type?: string; customType?: string }).type === "custom" &&
        (entry as { customType: string }).customType === ROLE_CUSTOM_TYPE
      ) {
        lastRole = (entry as { data: RoleData }).data;
      }
    }

    if (lastRole && lastRole.roles.length > 0) {
      await startNetwork(lastRole.roles);
      updateFooterStatus(lastRole.roles);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Restored roles from session: ${lastRole.roles.join(", ")}`,
          "info"
        );
      }
    }
  });

  // ─── Lifecycle: Clean Up on Exit ───────────────────────

  pi.on("session_shutdown", async (_event, _ctx) => {
    updateFooterStatus([]);
    stopNetwork();
  });
}
