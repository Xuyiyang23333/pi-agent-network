# pi-agent-network

pi 的 P2P 多 agent 网络扩展。让多个 pi 实例通过 HTTP 互相调用，像 function call 一样协作。

## 安装

```bash
# 将扩展复制到 pi 的 extensions 目录
cp agent-network.ts ~/.pi/agent/extensions/agent-network.ts

# 在 pi 中重载
/reload
```

或使用项目自带的同步脚本：

```bash
./sync.sh
```

## 快速开始

```bash
# 1. 加入网络，声明角色
/role developer

# 2. 查看网络中的其他 agent
#    （让 LLM 调用 list_agents 工具，或直接对话"看看有哪些 agent 在线"）

# 3. 调用其他 agent（LLM 自动使用 call 工具）
#    例如："让 reviewer 审查一下 src/main.ts 的改动"

# 4. 查看异步回复
#    LLM 会在空闲时自动收到提醒，或主动调用 check_reply

# 5. 退出网络
/role --off
```

## 核心功能

### 角色管理

`/role <name,...>` 声明角色，支持增量加减：

```bash
/role developer              # 注册角色
/role +tester                # 追加角色
/role -tester                # 移除角色
/role --off                  # 退出网络
```

角色会持久化到会话中，`/resume` 恢复会话时自动重新加入网络。

### 同步调用

调用方等待被调用方处理完毕后返回结果，期间双方均标记为 busy，防止死锁。

### 异步通信

异步消息发送后不等待，被调用方处理完毕后自动回传结果。回复投递采用三层降级策略：

```
接收方 idle → 直接注入对话（[异步回复] 前缀）
接收方 busy → 存入信箱 → idle 时提醒 LLM 取阅
投递失败    → 回退本地信箱兜底
```

LLM 通过 `call` 工具主动回复后，系统自动跳过回传，避免重复投递。

### Footer 状态

当前角色显示在 pi footer 栏中，与其他扩展状态（如余额）同行，按 key 字母序排列。

### 多目标异步 call

`call` 工具的 `to` 参数支持逗号分隔多角色，仅限异步模式：

```
call(to: "reviewer, tester", message: "状态同步", synchronous: false)
```

### 服务发现

agent 通过 `~/.pi/agent/registry/` 目录下的 JSON 文件自动发现彼此，无需中心节点。写入采用先 tmp 后 rename 的原子策略，避免读到半截数据。

## 项目结构

```
pi-agent-network/
├── agent-network.ts    # 扩展主文件（单文件，~1000 行）
├── sync.sh             # 快速同步到 extensions 目录
└── LICENSE             # MPL 2.0
```

## 许可证

MPL 2.0 — 详见 [LICENSE](LICENSE)
