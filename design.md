# pi-agent-network 设计文档

> 2026-05-05

## 概述

pi-agent-network 是一个纯 P2P 的轻量级多 agent 协作方案。每个 pi 实例通过一个扩展即可加入网络，通过文件系统做服务发现、HTTP 做消息传输，让 agent 之间可以像 function call 一样互相调用。

## 架构拓扑

```
┌──────────────────────────────────────────────────────────────┐
│  ~/.pi/agent/registry/                                       │
│  ├── dev-abc123.json → {roles: ["developer"], port: 19827}    │
│  ├── rev-def456.json → {roles: ["reviewer"], port: 20513}     │
│  └── tst-ghi789.json → {roles: ["tester"], status: "offline"} │
└──────────────────────────────────────────────────────────────┘
         ▲ 读/写              ▲ 读/写              ▲
         │                    │                    │
    ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
    │ dev     │  call()  │ rev     │  call()  │ tst     │
    │ :19827  │◄───────▶│ :20513  │────X────▶│ (下线)  │
    │         │   HTTP   │         │   HTTP   │         │
    └─────────┘          └─────────┘          └─────────┘
```

- 无中心节点，每个 agent 平等
- 注册文件由各 agent 自己维护，启动时写入、正常退出时删除
- 通信全是 P2P HTTP 请求，不经过任何中间人

## 角色管理

### 概念
- 角色是用户自定义的标签，无预定义枚举
- 一个实例可以同时拥有多个角色（如 `developer, tester`）
- 角色决定了其他 agent 能否通过 `list_agents` 发现你、通过 `call` 调用你

### 分配方式
两种等效方式，内部走同一套逻辑：

1. **命令**：`/role developer, tester`
2. **自然语言**：用户说"你是 reviewer"，LLM 理解意图后调用 `set_role` 工具

### 生命周期
- 注册：`/role developer` → 随机选择端口，启动 HTTP server，写入 `~/.pi/agent/registry/<id>.json`
- 注销：`/role --off` → 关闭 HTTP server，删除注册文件
- 正常退出：`session_shutdown` 时自动删除注册文件
- 异常退出：注册文件残留，文件中保留退出前的状态；下次调用方连接失败时将其标记为 `offline`
- 角色中途变化：支持增量添加（`/role +designer`）和移除（`/role -tester`），注册文件实时更新

### 会话恢复
角色分配通过 `pi.appendEntry("role", { roles: [...] })` 持久化到会话中。用户执行 `/resume` 恢复会话时：

1. `session_start` 读取最后一条 `role` entry
2. 若有角色记录，自动重新分配随机端口、启动 HTTP server、写入 registry
3. 新 registry 文件使用新 PID 和新的随机端口
4. 其他 agent 通过 `list_agents` 自然发现新端口

## 服务发现

### 注册文件格式
```json
{
  "id": "dev-abc123",
  "roles": ["developer"],
  "host": "127.0.0.1",
  "port": 19827,
  "status": "idle",
  "startedAt": 1712345678000
}
```

端口由系统随机分配，通过 registry 文件对外公布。

### 发现流程
1. 扫描 `~/.pi/agent/registry/` 下所有 `.json` 文件
2. 按目标角色匹配，过滤掉 `status: offline` 的
3. 优先返回 `status: idle` 的 agent
4. 若多个空闲，随机选一个

### 容错（离线检测）
不主动做 PID 存活检测。状态由实际连接结果驱动：

- 正常退出：agent 自己删除注册文件，不留痕迹
- 异常退出：注册文件残留。下次调用方尝试 HTTP 连接时失败，将目标 registry 文件 `status` 改为 `offline`
- `offline` 状态的文件保留在 registry 目录中，作为"曾经存在过该角色"的历史记录

## 通信协议

### 端点
每个 agent 的 HTTP server 只暴露一个端点：

```
POST /message
Content-Type: application/json

{
  "from": "dev-abc123",
  "to": "reviewer",
  "message": "审查一下 src/main.ts 的改动",
  "synchronous": true
}
```

### 同步模式（synchronous: true）

```
调用方 (developer)                    被调用方 (reviewer)
      │                                      │
      │  POST /message                       │
      │ ───────────────────────────────────▶ │ status: idle → busy
      │                                      │ pi.sendUserMessage(message)
      │  (HTTP 连接保持，阻塞等待)            │ LLM 开始处理...
      │                                      │ agent_end → 捕获回复
      │ ◀─────────────────────────────────── │
      │  HTTP 200 {reply: "第42行..."}        │ status: busy → idle
      │                                      │
  tool result 返回 LLM                        │ 等待下一次调用
```

- reviewer 处理期间 status 设为 `busy`，其他调用方会收到 `{"error": "busy"}`
- **死锁预防**：调用方发起同步 `call` 前先将自身 status 置为 `busy`，阻止被其他 agent 反向调用
- 无人工超时——只要 HTTP 连接未断，说明对方还在工作
- 回复仅包含最终 assistant 消息的纯文本内容，不包含 reasoning 和工具调用过程

### 异步模式（synchronous: false）

```
调用方 (developer)                    被调用方 (reviewer)
      │                                      │
      │  POST /message                       │
      │  {synchronous: false}                │ status: idle → busy
      │ ───────────────────────────────────▶ │ pi.sendUserMessage(message)
      │ ◀─────────────────────────────────── │ LLM 处理（调用方不等待）
      │  HTTP 202 {accepted: true}           │ agent_end → 回复写入
      │                                      │ status: busy → idle
  tool result: "已送达"                       │
```

- 立即返回 202，调用方继续工作
- 被调用方处理完毕后，回复暂存到内存中的待收队列（以调用方 ID 为键）
- 调用方下次通过 `check_reply(from?)` 拉取；不传 `from` 则返回所有待收回复

### 被调用方忙的状态处理

```
调用方 (developer)                    被调用方 (reviewer)
      │                                      │
      │  POST /message                       │ status: busy
      │ ───────────────────────────────────▶ │
      │ ◀─────────────────────────────────── │
      │  HTTP 409 {error: "busy"}            │
      │                                      │
  tool result: "reviewer 正忙，请稍后重试"    │
```

LLM 收到 busy 后自行决定稍后重试。

## 扩展注册的工具

| 工具 | 参数 | 用途 | 主要触发者 |
|------|------|------|-----------|
| `set_role` | `roles: string[]` | 给自己注册角色，启动 server | 用户 |
| `unset_role` | 无 | 注销所有角色，关闭 server | 用户 |
| `list_agents` | `role?: string` | 列出网络中可用的 agent | LLM |
| `call` | `to: string`, `message: string`, `synchronous?: boolean` | 向目标角色发送消息 | LLM |
| `check_reply` | `from?: string` | 拉取异步对话的待收回复 | LLM |

## 扩展的生命周期钩子

```
session_start  → 若已注册角色，启动 HTTP server（实例恢复场景）
session_shutdown → 清理注册文件，关闭 HTTP server
agent_end      → 若正在处理同步请求，捕获回复写入 HTTP response
```

## 状态机

```
                     set_role()
  OFFLINE ──────────────────────▶ IDLE
    ▲                                │
    │ unset_role() / 正常退出        │ call() 到达
    │ (删除 registry 文件)           ▼
    │                              BUSY ──────────▶ IDLE
    │                                │   agent_end   │
    │                                │ call() 到达    │
    │                                ▼                │
    │                              BUSY              │
    │                           (返回 409 busy)       │
    │                                                │
    └── 连接失败（由调用方标记）──────────────────────┘
        IDLE/BUSY ──▶ OFFLINE（registry 文件残留）
```

## 扩展性

添加新类型 agent 的步骤：

1. 启动 pi 实例
2. `/role designer`（或自然语言指定）
3. 完成。其他 agent 自动发现

零配置、零代码改动。

## 文件结构

```
~/.pi/agent-network/
  agent-network.ts          # 扩展主文件

~/.pi/agent/registry/       # 运行时注册目录（所有 agent 自动维护）

~/.pi/agent/extensions/
  agent-network.ts          # symlink → ../../agent-network/agent-network.ts
```

## 待定 / 未来考虑

- [ ] 非 localhost 通信（用于远程 agent）
- [ ] 广播模式（一对多调用）

## 限制

- 仅支持本地回环通信（127.0.0.1）
- 同步模式下调用方完全阻塞，期间不能处理其他 call
- 异步模式下待收回复仅存于内存，调用方退出则丢失（可通过调用方的会话恢复机制弥补）
- 依赖 `~/.pi/agent/registry/` 目录存在且可写
- 注册文件多进程并发读写无锁保护——本地协作场景下碰撞概率极低，但仍属已知限制
