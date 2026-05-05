# pi-agent-network Design & Plan Review Report

> 审查日期：2026-05-06
> 审查范围：`design.md`、`plan.md`

---

## 一、审查概要

| 维度 | 评价 |
|------|------|
| 架构设计 | ✅ 优秀——P2P 无中心 + 文件注册 + HTTP 通信，简洁务实 |
| 功能完整性 | ✅ 覆盖同步/异步双模、角色管理、服务发现、容错恢复 |
| 实现计划 | ✅ 任务拆分合理，代码可执行，自检清单完整 |
| 潜在风险 | ⚠️ 存在竞态条件、死锁隐患、边界情况处理不足 |

整体而言，设计方向正确，计划可落地。以下列出需要关注的问题和改进建议。

---

## 二、Design Spec 审查

### 2.1 死锁风险 🔴 严重

**问题**：同步模式下调用方完全阻塞。若 agent A → agent B（同步），B 在处理过程中通过 LLM 又 `call` agent A，A 因阻塞无法响应，B 的 HTTP 连接也将卡住，形成死锁。

**当前缓解**：B 处理期间 status 为 BUSY，其他调用会收到 409。但 A 在阻塞前仍是 IDLE，若 B 恰好 call A，A 的 server 会响应并陷入双重阻塞。

**建议**：
- 在 `call` 请求中附带调用链，被调用方检测自己是否已在链中
- 或限制：同步模式下 agent 标记自己为 BUSY，拒绝外来同步请求

---

### 2.2 同步调用无超时 🔴 严重

**问题**：设计明确说"无人工超时——只要 HTTP 连接未断，说明对方还在工作"。但 TCP 连接可能因防火墙/NAT 静默断开而不被双方感知（半开连接），导致调用方永久挂起。

**建议**：增加保底超时（如 30 分钟），超时后返回错误给 LLM，并标记目标为 offline。

---

### 2.3 注册文件跨进程竞争 🟡 中等

**问题**：多个 pi 实例各自读写 registry 目录。`markOffline()` 会跨 agent 写别人的注册文件——这是多进程并发写同一个文件，没有锁保护。

```typescript
// plan.md 中 markOffline 直接写他人文件
fs.writeFileSync(p, JSON.stringify(info, null, 2));
```

**建议**：
- 写操作使用原子写入（先写 `.tmp` 文件再 `rename`）
- 至少在文档中记录此为已知限制（本地协作场景下概率极低）

---

### 2.4 Agent ID 碰撞风险 🟡 中等

**问题**：`randomBytes(4).toString("hex")` 仅 4 字节 = 8 hex = 2³² 空间。在同一台机器上运行多个 agent 时，虽然碰撞概率不高，但一旦发生会导致一个 agent 覆盖另一个的注册文件。

**建议**：改用 8 字节（16 hex，2⁶⁴ 空间）或 `crypto.randomUUID()`，成本几乎为零。

---

### 2.5 端口分配 TOCTOU 🟡 中等

**问题**：Plan 中端口分配逻辑先用临时 server 占端口、记下端口号、释放、再用实际 server 绑定。释放到重新绑定之间存在被其他进程抢占的窗口。

**建议**：让实际 HTTP server 直接 `listen(0)`，从 `server.address()` 读取系统分配的端口，从根本上消除竞态。

---

### 2.6 同步响应写入的健壮性 🟡 中等

**问题**：`agent_end` 中直接向 `pendingSyncResponse` 写回 HTTP 响应。若调用方已主动断开连接，`res.end()` 会抛异常。

**建议**：写之前检查 `res.writable`，或监听 `res.on('close')` 提前清理。

---

### 2.7 异步回复仅存内存 🟢 已知限制

设计已承认此限制。补充建议：异步回复可加 TTL 清理机制（见 3.8 节），避免调用方永久不来取导致内存泄漏。

---

## 三、Implementation Plan 审查

### 3.1 路径不一致 🟡 中等

| 位置 | 路径 |
|------|------|
| plan.md 文件结构图 | `~/.pi/agent-network/registry/` |
| plan.md 代码常量 | `~/.pi/agent/registry/` |
| design.md | `~/.pi/agent/registry/` |

需要统一。建议沿用 design.md 的 `~/.pi/agent/registry/`，与 pi 生态其他扩展保持一致的目录结构。

---

### 3.2 API 签名需验证 🟡 中等

以下 pi ExtensionAPI 调用需要对照官方文档确认签名：

| 调用 | 疑点 |
|------|------|
| `pi.appendEntry(ROLE_CUSTOM_TYPE, { roles })` | 第二个参数是 data 对象还是需要包装？ |
| `ctx.sessionManager.getEntries()` | 方法名是否正确？是否有 `sessionManager`？ |
| `ctx.hasUI` | 是否存在该属性？ |
| `pi.on("session_start", async (_event, ctx) => ...)` | `ctx` 参数是否由事件系统提供？ |

**建议**：参照 pi 文档 `docs/sdk.md` 和 `docs/extensions.md` 核实 API。

---

### 3.3 `message_end` 钩子缺失 🟡 中等

**问题**：Design 明确提到：

> `message_end → 判断收到的是否为来自其他 agent 的消息，维护状态`

但 Plan 中完全没有对应的实现。需要添加判断逻辑：当 agent 完成一轮 LLM 推理后，检查该轮对话是否由外部 `call` 触发，若是则触发相应的回复发送。

---

### 3.4 `extractText` 边界情况 🟡 中等

```typescript
function extractText(message: any): string {
  if (message.content) {
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)  // ← b.text 可能为 undefined
        .join("\n");
    }
  }
  return "(no response)";
}
```

**问题**：若 content 数组中有非标准 block（如 tool_use），`b.text` 为 `undefined`，最终拼接出字符串 `"undefined"`。

**建议**：加 `typeof b.text === 'string'` 检查，或使用 `filter` 后再 `map`。

---

### 3.5 异步回复无清理机制 🟡 中等

**问题**：`pendingReplies` Map 仅在被 `check_reply` 读取时清理。若某个 caller 从不调用 `check_reply`，该 Map 会随时间无限增长。

**建议**：每条 `PendingReply` 已有 `timestamp` 字段，可添加惰性清理（在 `check_reply` 或新请求到达时清理超时项），或定时器清理（如每 10 分钟清理超过 1 小时的条目）。

---

### 3.6 命令解析边缘情况 🟢 低

```typescript
if (trimmed.startsWith("+") || trimmed.startsWith("-")) {
  const op = trimmed[0];
  const delta = trimmed.slice(1).split(",")...
}
```

用户输入 `/role +developer, -tester`（混合增减）无法正确处理。不过此场景概率极低，可暂不处理，但建议文档或帮助文本明确格式。

---

### 3.7 无 API 兼容性检查 🟢 低

扩展加载时没有检查当前 pi 版本是否支持所需 API。若用户 pi 版本过旧，运行时报错体验不佳。

**建议**：添加 Optional 的版本检查，或至少 try-catch 关键 API 调用。

---

### 3.8 `agent_end` 状态恢复不完整 🟢 低

同步和异步的处理路径在 `agent_end` 中混合判断。当 agent 同时有同步和异步的待处理（虽然当前设计不允许多个并发），状态恢复逻辑可能出错。

**建议**：将 sync/async 的回复发送拆为独立函数，各管各的状态恢复。

---

## 四、改进建议汇总

| # | 类别 | 问题 | 优先级 | 影响 |
|---|------|------|--------|------|
| 1 | 设计 | 同步模式死锁风险 | 🔴 高 | 可能导致两个 agent 互相等待 |
| 2 | 设计 | 同步调用无超时 | 🔴 高 | 调用方可能永久挂起 |
| 3 | 实现 | 端口分配 TOCTOU | 🔴 高 | server 启动失败 |
| 4 | 实现 | `agent_end` 响应写入无 writable 检查 | 🔴 高 | 连接断开时抛异常 |
| 5 | 实现 | API 签名需验证 | 🟡 中 | 可能运行时报错 |
| 6 | 设计 | Agent ID 空间过小 | 🟡 中 | 低概率文件覆盖 |
| 7 | 设计 | 注册文件并发竞争 | 🟡 中 | 低概率数据损坏 |
| 8 | 实现 | 路径不一致 | 🟡 中 | 文件找不到 |
| 9 | 实现 | `message_end` 钩子缺失 | 🟡 中 | 状态维护不完整 |
| 10 | 实现 | `extractText` 边界情况 | 🟡 中 | 输出含 "undefined" |
| 11 | 实现 | 异步回复无 TTL 清理 | 🟡 中 | 内存泄漏 |
| 12 | 实现 | 命令解析边缘情况 | 🟢 低 | 用户体验 |
| 13 | 实现 | 无版本兼容性检查 | 🟢 低 | 旧版本报错体验差 |

---

## 五、总结

设计方案的**方向正确**，P2P + 文件注册 + HTTP 通信的组合在单机多 agent 协作场景下是务实且优雅的选择。实现计划任务拆分清晰，代码可执行。

建议**优先修复**以下 4 项后再开始编码：

1. **同步模式加超时**
2. **端口分配改为 listen(0)**
3. **`agent_end` 响应写入加 writable 检查**
4. **对照 pi 文档核实 API 签名**

其余问题可在实现过程中或 v1 之后逐步改进。
