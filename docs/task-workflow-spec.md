# Task Workflow Spec

## 概述

Task Workflow 让 agent 提案多步协作流程，创建者确认后按步骤自动流转。每步可有多个 assignee，支持 reject 回退。

## Lifecycle

```
created → proposing → approved → step1 → step2 → ... → completed
              ↑          │
              └──rejected─┘ (重新提案)
```

## Task Status

| 状态 | 含义 |
|------|------|
| `proposing` | agent 正在提案 workflow |
| `approved` | 创建者已确认 workflow |
| `in_progress` | 正在执行某个 step |
| `completed` | 所有 step 完成 |
| `failed` | 任务失败 |
| `canceled` | 任务取消 |

## 数据模型

### Task

存储在 room_events 的 payload_json 中：

```typescript
interface TaskWorkflow {
  task_id: string
  title: string
  status: TaskStatus
  current_step: number          // 当前执行的 step 序号
  creator_agent_id: string
  workflow: Step[]
}

interface Step {
  step: number                  // 从 1 开始
  title: string
  assignees: string[]           // agent name 或 "role:xxx"
  action: string                // 告诉 assignee 做什么
  completion: "all" | "any"     // all = 全部完成才推进, any = 任一完成即推进
  on_reject?: "revise" | `back:${number}`  // reject 时的行为, 默认 "revise"(回到本步)
  completed_by: string[]        // 已完成的 agent id 列表
}
```

## 事件类型

### 新增事件

| 事件 | 触发者 | Payload | 说明 |
|------|--------|---------|------|
| `task-propose` | 被指派 agent | `{ task_id, workflow: Step[] }` | 提交 workflow 提案 |
| `task-approve` | 创建者 | `{ task_id }` | 批准 workflow，自动开始 step 1 |
| `task-reject` | 创建者或 reviewer | `{ task_id, reason?, step? }` | 打回提案或当前 step |
| `step-start` | 系统自动 | `{ task_id, step, assignees }` | 进入某个 step，通知 assignees |
| `step-complete` | assignee | `{ task_id, step, result? }` | 某 agent 完成当前 step |
| `task-complete` | 系统自动 | `{ task_id }` | 最后一步凑齐后自动触发 |

### 保留的事件

| 事件 | 说明 |
|------|------|
| `task-start` | 创建 task（现有） |
| `task-update` | 进度更新（现有） |
| `task-fail` | 任务失败（现有） |
| `task-cancel` | 取消任务（现有） |

## 流转规则

### 1. 创建

创建者调用 `hive-task`:

```
hive-task({ to: "alice", title: "重构首页 UI" })
```

- 创建 task，status = `proposing`
- 通知 alice

### 2. 提案

被指派 agent 分析任务后提交 workflow:

```
task-propose({
  task_id: "xxx",
  workflow: [
    { step: 1, title: "设计", assignees: ["role:ux"], action: "出首页设计稿", completion: "all" },
    { step: 2, title: "实现", assignees: ["role:frontend"], action: "按设计稿实现", completion: "all" },
    { step: 3, title: "Review", assignees: ["role:ux", "role:frontend"], action: "审查实现", completion: "all", on_reject: "back:2" }
  ]
})
```

### 3. 确认

创建者审查提案：

- `task-approve` → status 变为 `in_progress`，自动触发 `step-start(1)`
- `task-reject({ reason: "需要加测试步骤" })` → status 回到 `proposing`，agent 重新提案

### 4. Step 执行

当 `step-start(N)` 触发时：

1. 解析 assignees（支持 `role:xxx` 匹配）
2. 通知所有 assignees
3. assignees 各自工作

### 5. Step 完成

assignee 调用 `step-complete`:

```
step-complete({ task_id: "xxx", step: 2, result: "代码已提交到 feature/redesign" })
```

Server 检查:

- `completion: "any"` → 任一 agent 完成即推进
- `completion: "all"` → 记录到 `completed_by`，全部凑齐后推进

凑齐后自动 `step-start(N+1)`。最后一步凑齐后自动 `task-complete`。

### 6. Reject 回退

review 步骤的 agent 可以 reject:

```
task-reject({ task_id: "xxx", step: 3, reason: "按钮样式不符合设计稿" })
```

根据 `on_reject` 处理:

- `"revise"` → 清空当前 step 的 `completed_by`，重新 `step-start(当前step)`
- `"back:N"` → 跳回第 N 步，清空第 N 步及之后的 `completed_by`，`step-start(N)`

## 流转示例

```
用户:    hive-task({ to: "alice", title: "重构首页 UI" })
         → task-start, status=proposing

alice:   task-propose({ workflow: [...3 steps...] })
         → 通知用户审查

用户:    task-approve
         → status=in_progress
         → step-start(1), 通知 ux agent

ux:      step-complete(1, result: "设计稿在 /artifacts/xxx/design.png")
         → step-start(2), 通知 frontend agent

frontend: step-complete(2, result: "代码已提交")
         → step-start(3), 通知 ux + frontend

ux:      step-complete(3)  // ux 通过
         → completed_by: [ux], 等待 frontend

frontend: task-reject(step:3, reason: "设计稿标注有歧义")
         → on_reject="back:2", 回到 step 2
         → step-start(2), 通知 frontend

frontend: step-complete(2, result: "已修复")
         → step-start(3), 通知 ux + frontend

ux:      step-complete(3)
frontend: step-complete(3)
         → 全部完成, task-complete
```

## 与现有 FSM 的关系

新 workflow 模式和现有的简单 FSM 共存：

- **无 workflow 的 task** — 走现有 FSM（submitted → working → completed），向后兼容
- **有 workflow 的 task** — 走新流程（proposing → approved → step 流转 → completed）

判断标准：task 的 payload 里有没有 `workflow` 字段。

## 实现计划

### Phase 1: 数据模型

- 扩展 `state-machine.ts` 支持新事件类型和 workflow 状态
- 扩展 `models.ts` 添加 Step 和 TaskWorkflow 类型

### Phase 2: 工具扩展

- `hive.task` 加 `proposing` 状态支持
- 新增 `hive.room.post` 的 `task-propose`、`task-approve`、`step-complete` 事件处理
- Reject 回退逻辑

### Phase 3: 自动流转

- `step-complete` 后自动判定是否推进
- 自动 `step-start` 通知
- 自动 `task-complete`

### Phase 4: Channel plugin

- channel.ts 暴露新工具：`hive-propose`、`hive-approve`、`hive-step-complete`
- 推送 step-start 通知到对话上下文

## 不在范围

- workflow 模板库
- 并行 step（当前只支持顺序）
- step 超时自动处理
- workflow 修改（approve 后不可改）
