# pi-orca-process-wait

**简体中文** | [English](README.en.md)

一个轻量级 [Pi](https://pi.dev) 扩展，用于将 [`@aliou/pi-processes`](https://github.com/aliou/pi-processes) 的后台命令生命周期桥接到 **Orca** 现有的状态与保活通道。

解决 **Orca Orchestration 派工给 Pi 时，把 Pi 的“当前轮次结束”误判成“派工已停止”** 的问题。

---

## 问题背景

通过 Orca Orchestration 将任务派发给 Pi 后，当 Pi 使用 `process start` 启动一个耗时后台命令（例如测试、构建、训练脚本）并结束当前对话轮次等待回调唤醒时：

- **修复前**：
  1. Orca 看不到 `@aliou/pi-processes` 的后台进程，收到 `agent_end` / `agent_settled` 后立刻将 Pi 标记为 `idle / done`（页面停止转圈）；
  2. Orca 主控会**提前收到一次 `Worker stopped without reporting` 回执**，误以为派工中断；
  3. 等后台命令真正退出并唤醒 Pi 跑完第二轮后，主控才会收到真正的 `worker_done`。
- **修复后**：
  1. 后台命令运行期间，Orca 持续将 Pi 保持在运行态（页面继续转圈，并在子任务列表中展示 `pi-process:<id>` 及进程名）；
  2. 抑制中途误报，**不会**向主控提前发送 `Worker stopped without reporting`；
  3. 等后台进程退出唤醒 Pi、Pi 校验结果后，主控只收到最终的 `worker_done`；
  4. 在 Orca Native Chat（`pi --mode rpc`）模式下，同步注册 `@agegr/pi-web/session-liveness/v1` 保活探针，防止长任务等待期间 Pi 子进程被当作空闲会话回收。

---

## 前置条件

- **Pi** `>= 1.4.0`（已在 Pi `1.6.0` 验证）
- **`@aliou/pi-processes`** `>= 0.13.6`（需暴露 `processes:request:list` 中的 `wake` 字段）
- **Orca**（已内置 `~/.pi/agent/extensions/orca-agent-status.ts` 与 `~/.orca/pi-native-chat/orca-background-work.ts`）
- **无需修改或重新编译 Orca**，同时兼容 **Terminal Pi** 与 **Native Chat Pi** 两种派工模式。

---

## 安装

任选以下**一种**方式即可（请勿同时以包和单文件重复安装，虽然扩展内部已做去重防呆）：

### 方式 1：通过 `pi install` 安装（推荐）

```bash
pi install git:github.com/xing-shuai/pi-orca-process-wait
```

或直接将本仓库加入 `~/.pi/agent/settings.json` 的 `packages` 列表：

```json
{
  "packages": [
    "npm:@aliou/pi-processes@0.13.6",
    "git:github.com/xing-shuai/pi-orca-process-wait"
  ]
}
```

### 方式 2：单文件复制到用户扩展目录

```bash
mkdir -p ~/.pi/agent/extensions
curl -fsSL \
  https://raw.githubusercontent.com/xing-shuai/pi-orca-process-wait/main/extensions/orca-process-wait-bridge.ts \
  -o ~/.pi/agent/extensions/orca-process-wait-bridge.ts
```

安装完成后：
- 新启动的 Pi 会话会自动加载并生效；
- 已经在运行中的 Pi 会话可执行 `/reload` 立即生效。

---

## 使用说明与判定规则

本扩展**零配置**、自动工作：

1. **仅在 Orca 托管的 Pi 会话中激活**
   仅当检测到 Orca 环境变量（`ORCA_PANE_KEY`、`ORCA_STRUCTURED_SESSION`、`ORCA_PI_BACKGROUND_WORK_DIR` 或 `ORCA_AGENT_HOOK_ENDPOINT`）时启用；在普通终端单独使用 Pi、OMP 或 `pi-subagents` 子进程中会自动静默跳过。

2. **哪些后台进程会保持 Orca 运行态？**
   扩展通过 `processes:request:list` 查询 `@aliou/pi-processes` 的 `wake` 配置，只对**正在运行（`running` / `terminating` / `terminate_timeout`）且确实在等待回调**的进程生效：
   - **一次性任务（构建、测试、脚本等）**：`wake.exitAttention.success === "turn"`（`@aliou/pi-processes` 的默认行为）；
   - **等待就绪信号的服务**：存在未触发的一次性日志监听 `wake.watches.some(w => w.on === "turn" && !w.repeat && !w.fired)`（例如等 dev server 打印 `"ready"`，一旦触发 `fired: true` 即自动释放）。

3. **哪些进程不会被误拦（不会导致会话卡住）？**
   - 常驻服务：配置了 `notify.onSuccess: "context"` 或 `"ignore"` 且没有未触发的一次性 `turn` watch（即使设置了 `onFailure: "turn"` 或 `repeat: true` 的错误监听，也不会挂起整个会话）。
   - 进程被手动停止（`process stop`）或外部 kill 且未触发唤醒：经过 500ms 唤醒宽限期后自动释放状态，Orca 正常收敛为 `done`，不会永久卡在运行态。

### 给 Agent / Prompt 的配合建议

使用 `process start` 时遵循 `@aliou/pi-processes` 的常规约定即可：
- **需要等结果的一次性命令**（测试、编译、训练）：保持默认（`notify.onSuccess: "turn"`），启动后直接结束本轮等待唤醒。
- **长期常驻进程**（dev server、watcher）：显式设置 `notify.onSuccess: "context"`，避免常驻服务让 Orca 误以为仍在等待它退出。

---

## 工作原理

```text
@aliou/pi-processes
  ├─ processes:started / changed / ended / notification
  └─ processes:request:list (含 wake.exitAttention & watches)
        │
        ▼
orca-process-wait-bridge.ts
  ├─ 1) 发射 subagent:async-started / subagent:async-complete (id: pi-process:<id>)
  │       └─▶ orca-agent-status.ts
  │             ├─ Terminal Pi: 挂起 agent_end 上报，保持 working，阻止提前回执
  │             └─ Native Chat: 经 orca-subagents 写入 childWork，保持运行态并阻止提前回执
  ├─ 2) 500ms 唤醒宽限期
  │       ├─ 宽限期内收到 agent_start → 无缝交接给新一轮，UI 不闪烁 done
  │       └─ 无后续唤醒（如外部 kill）→ 到期自动释放，防止状态卡死
  └─ 3) 注册 Symbol.for('@agegr/pi-web/session-liveness/v1')
          └─▶ orca-background-work.ts（Native Chat 空闲回收保护）
```

---

## 已知局限与边界

由于本扩展不修改 Orca 源码，而是复用 Orca 已有的子任务生命周期通道，存在两点语义差异：

1. **UI 文案与图标**：在 Orca 页面中显示为运行中（转圈）及子任务条目 `pi-process:<id>`，而非 Orca 原生的“正在监控后台任务（`monitoring`）”标签。
2. **无 20 分钟超时提醒**：Orca 原生 `background-wait` 会在后台任务等待满 20 分钟后主动向主控发一次提醒；本扩展只要受追踪的进程仍存活就会持续保持运行态（进程退出、崩溃或被杀后会立即释放）。

---

## 本地测试

仓库包含 11 项自动化测试，覆盖 Terminal / Native Chat 双模式、竞态处理、常驻服务排除、session 切换与 `/reload` 清理，以及启动真实 `pi --mode rpc` + `@aliou/pi-processes` + Orca 托管扩展的端到端冒烟测试：

```bash
npm test
```

> 注：测试脚本会自动查找本机已安装的 Pi、`@aliou/pi-processes` 与 Orca 托管扩展（也可通过环境变量 `PI_BIN`、`PI_AGENT_DIR`、`PI_CODING_AGENT_DIR`、`ORCA_BACKGROUND_WORK_PATH` 指定路径）。

---

## License

[MIT](LICENSE)
