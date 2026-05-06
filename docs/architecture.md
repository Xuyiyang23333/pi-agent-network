# pi-agent-network 架构设计

## 拓扑

纯 P2P，无中心节点。每个 pi 实例通过 `~/.pi/agent/registry/` 目录下的 JSON 文件做服务发现，HTTP 做消息传输。

```
~/.pi/agent/registry/
├── abc123.json → {roles: ["developer"], port: 19827, status: "idle"}
├── def456.json → {roles: ["reviewer"], port: 20513, status: "busy"}
└── ghi789.json → {roles: ["tester"], port: 21004, status: "idle"}

developer :19827 ◄──── HTTP ────► reviewer :20513
     ▲                                ▲
     └──── HTTP ────► tester :21004 ──┘
```

agent 自行维护自己的注册文件——启动时写入、正常退出时删除。异常退出后文件残留，其他 agent 连接失败时调用 `markOffline` 直接删除。

## 注册文件格式

```json
{
  "id": "uuid",
  "roles": ["developer"],
  "host": "127.0.0.1",
  "port": 19827,
  "status": "idle",
  "startedAt": 1712345678000
}
```

写入采用原子策略：先写 `.tmp` 再 `rename`，避免读取方拿到半截 JSON。

## 通信协议

单一端点 `POST /message`：

```json
{
  "from": "agent-uuid",
  "to": "developer",
  "message": "审查 src/main.ts",
  "synchronous": true,
  "isReply": false,
  "fromRoles": ["reviewer"]
}
```

### 同步模式

```
调用方                        被调用方
  │  POST /message              │
  │ ──────────────────────────► │ status: idle → busy
  │  (HTTP 连接保持，阻塞等待)    │ LLM 处理请求
  │ ◄────────────────────────── │ agent_end 写回 HTTP 响应
  │  HTTP 200 {reply: "..."}    │ status: busy → idle
```

调用方发起同步 call 前将自身标记为 busy（防死锁）。

### 异步模式

```
调用方                        被调用方
  │  POST /message              │
  │  {synchronous: false}       │ status: idle → busy
  │ ──────────────────────────► │ LLM 处理请求
  │ ◄────────────────────────── │ HTTP 202 {accepted: true}
  │  (立即返回)                  │ agent_end 回推 isReply
  │                             │ status: busy → idle
  │ ◄──── isReply 回传 ──────── │
```

异步回复投递采用三层降级：

```
接收方 idle → 直接注入对话（[异步回复] 前缀）
接收方 busy → 存入信箱 → busy→idle 时自动提醒
投递失败    → 回退本地信箱兜底
```

LLM 通过 `call` 工具主动回复后，`agent_end` 检测 `callerRepliedViaCall` 标志并跳过 `isReply` 回传，避免重复投递。

## 状态机

```
              set_role()
OFFLINE ──────────────────► IDLE
  ▲                           │
  │ unset_role() / 正常退出    │ 收到 call
  │ (删除 registry 文件)       ▼
  │                         BUSY ──────────► IDLE
  │                           │  agent_end    │
  │                           │ 收到 call      │
  │                           ▼               │
  │                         BUSY              │
  │                      (返回 409 busy)       │
  │                                           │
  └─── 连接失败（删除文件）─────────────────────┘
```

## Footer 集成

通过 `ctx.ui.setStatus("agent-roles", ...)` 在 pi footer 栏显示当前角色。pi 将所有扩展状态按 key 字母序空格拼接为一行，与其他扩展（如 DeepSeek 余额）自然共存：

```
🎭 developer, reviewer 💰 7.21 CNY
```

## 多目标 call

`call` 工具 `to` 参数支持逗号分隔多角色（仅异步模式），通过 `Promise.all` 并行发送到各目标，不引入新的竞态问题。

## 扩展注册的工具

| 工具 | 用途 |
|------|------|
| `set_role` | 注册角色，启动 HTTP server |
| `unset_role` | 注销所有角色，关闭 server |
| `list_agents` | 列出网络中的 agent（支持按角色过滤） |
| `call` | 向目标角色发送消息（同步/异步，单/多目标） |
| `check_reply` | 拉取异步对话的待收回复 |

## 生命周期

```
session_start   → 若有持久化角色记录，自动启动 network
session_shutdown → 清理注册文件 + footer，关闭 HTTP server
agent_end       → 同步请求写回 HTTP 响应 / 异步请求回推回复
```

## 限制

- 仅支持本地回环通信（127.0.0.1）
- 同步模式下调用方完全阻塞
- 异步回复死信仅存内存，agent 重启丢失（可通过调用方重试弥补）
- 注册文件多进程无锁——本地场景碰撞概率极低
