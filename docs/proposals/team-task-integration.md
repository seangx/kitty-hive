# Proposal: v0.6.5 — Task 工作流硬伤 + 自主路由可用性

**状态**: Final draft（已经历 codex 两轮 + 用户三轮约束修正）
**目标版本**: v0.6.5
**单一目标**: 让"agent 自主把活派给合适的人"这条路径**真正可用**，同时堵住 task 工作流的两个硬伤。

---

## 1. 起点：诚实承认数据

最近 30 天 hive 实际数据：

| 现象 | 数字 |
|---|---|
| `tasks` 总数 | 19 |
| 其中 `source_team_id` 非 NULL | **0** |
| `team_events` 中 `message` 类型 | **2** |
| 完成态 task 平均 `task_events` 数 | 13.9（最大 19）|
| `agents.roles` 字段实际值 | **几乎全是 'channel'**（被 channel.ts 硬塞）|
| `agents.expertise` 字段 | 几乎为空 |

**两件结论**：
1. team primitive 当前**事实上未被使用**。原因不是它没价值，而是用户（人类）一直在当 router——直接说"让 X agent 做 Y"，agent 没机会自主选人。
2. 用户**期望**未来 agent 能自主路由（"遇到 xxx 就主动找 xx"），但当前的 routing 基础设施有 bug：`role:xxx` 全库扫的是 `roles='channel'` 这种垃圾数据。

---

## 2. 核心判断

> **不要为没人要的功能造生态位**。但**要为用户**已经表达**的方向**铺路。

用户的方向：从"人类驱动的派活"切换到"agent 自主路由"。

铺路要做的事：
- 让 `role:xxx` 路由的数据不再是垃圾（roles 字段重新有意义）
- 让 routing 在有 team 上下文时优先 team 内（确定性）
- 让 agent **看得到**团队当前在做什么（避免重复工作）
- 让上述行为引导对**所有** MCP 客户端生效（不只 Claude Code）

**砍掉**任何"为了让 team 显得有用"而造的功能（task 看板、推送扩散、closed team 行为预占等）。

---

## 3. v0.6.5 落地清单

### 3.1 修 task 工作流的两个硬伤

#### 3.1.1 `step.action.maxLength(400)` — 防 spec 复述

**痛点**：completed task 的 `step.action` 普遍 200-1500 字符，内含 spec 应在的位置（文件路径、命令行、验收分支清单）。task 在复述 spec 系统应有的内容。

**修法**：`hive_workflow_propose` schema 给 `action` 加 `maxLength(400)`。400 能容一个 URL + 一句说明，逼 agent 写"做什么 + 引用上游 spec"，而不是把 spec 内联进 task。

**约束语义**（在 instructions 和 SKILL.md 写明）：
> `step.action` 应**指向**而不是**复述**：openspec change tasks.md §X、Linear LIN-N、doc URL、上一条 DM message_id，都比贴一段验收清单好。
> 没有 spec 系统就一句话说清楚。
> 验收细节、边界分支列表留在它们原本该在的地方。

#### 3.1.2 `source_team_id` immutable

**痛点**：当前 `source_team_id` 字段创建时可设、之后可改（无 API 设防，理论上 SQL 可改）。中途变 team 会让"谁能看见 task"突变，混乱。

**修法**：`hive_task` 创建时若带 `source_team_id` 则落库；之后**没有任何 MCP tool 暴露修改**能力。CLI 也不提供 `task set-team`（避免造 set-team 工具又给一类难追溯的状态变化）。想换 team 就新建 task。

#### 3.1.3 列表接口字段约束

**痛点**：当前 `hive-tasks` 输出每条 task 含若干字段，未来易被人加字段（workflow_json、task_events 摘要等），导致列表响应膨胀，吃 token。

**修法**：
- `TaskListRow` 类型独立（id/title/status/step/creator/assignee/created_at），与 `TaskDetail`（含 workflow/events/input）分离
- `hive_tasks` handler 在返回前走显式白名单投影函数 `projectTaskListRow(t)`，**任何不在白名单的字段会被抹掉**
- 这是**预防性纪律约束**，防止后续维护时不小心把 detail 字段塞进 list

**不**做：
- 不改字段名（避免破坏性变更）
- 不换文本格式（同上）
- 不引入 `format` 参数

### 3.2 让 agent 自主路由真正可用

#### 3.2.1 `findAgentByRole` 双层匹配

**当前**：`SELECT * FROM agents WHERE roles LIKE '%r%' AND status='active'`——但 roles 字段几乎全是 'channel'，几乎查不到任何东西。

**修法**：

```sql
-- 1. 先精确匹配 roles
SELECT ... WHERE roles LIKE '%r%' AND origin_peer='' AND status='active'
ORDER BY last_seen DESC LIMIT 1
-- 没命中再 fallback display_name 子串
SELECT ... WHERE display_name LIKE '%r%' AND origin_peer='' AND status='active'
ORDER BY last_seen DESC LIMIT 1
```

**好处**：
- **bootstrap 零成本**：用户现有的 display_name 约定（`tester / web-master / codex-reviewer`）立刻可用，不需要任何 agent 重新填字段
- **精准化路径开放**：想要更精准的用户可设 `HIVE_AGENT_ROLES` env，或调 `hive_update_role` 主动维护，会走高优先级路径
- **不破坏现有调用**：`role:xxx` 行为对调用方完全透明

#### 3.2.2 `role:xxx` 在有 `source_team_id` 时 team 内优先

**修法**：handler 把 task 的 `source_team_id` 透传给 `findAgentByRole`：

```ts
findAgentByRole(role: string, opts?: { teamId?: string }): Agent | undefined
// 1. 如果 teamId 给了，先在 team_members ∩ matching agents 里找
// 2. 没命中再走全局（§3.2.1 的双层匹配）
```

**效果**：当 task 挂了 team 时，`role:tester` 路由的结果**确定性变高**——会优先选 team 内的 tester，不会因为某个其他项目的 tester 最近活跃就被错误命中。

#### 3.2.3 `channel.ts` 停止硬塞 `roles='channel'`

**当前**（channel.ts:93）：
```ts
const args: any = { tool: 'claude', roles: 'channel' }
```

**修法**：
```ts
const args: any = { tool: 'claude' }
// 只有 HIVE_AGENT_ROLES env 存在才加 roles
if (HIVE_AGENT_ROLES) args.roles = HIVE_AGENT_ROLES
```

新 agent 注册后 `roles` 默认空——靠 §3.2.1 的 display_name fallback 兜底。

#### 3.2.4 一次性数据清理

```sql
UPDATE agents SET roles='' WHERE roles='channel';
```

把所有被污染的老数据洗回空值，让 fallback 路径接管。

### 3.3 让 agent 自维护 roles

#### 3.3.1 新工具 `hive_update_role`

```ts
hive_update_role({
  as?: string,
  add?: string[],     // 添加这些 role
  remove?: string[],  // 移除这些 role
})
→ { agent_id, old_roles, new_roles }
```

实现：
- 解析当前 `roles`（comma-separated → Set）
- 应用 add/remove
- 写回（保持 comma-separated 格式，去重，trim）
- **不**写 audit log（太吵；agent 自管）
- **不**预定义合法 role 集合（freeform tag）

DB helper：
```ts
updateAgentRoles(agentId: string, add?: string[], remove?: string[]): { old: string; new: string }
```

#### 3.3.2 引导规则放协议层 instructions（不是 SKILL.md）

**为什么不放 SKILL.md**：SKILL.md 只对 Claude Code plugin 用户生效。其他客户端（Cursor、VSCode、Gemini CLI、Claude Desktop、HTTP 直连 MCP）看不到。

**放哪**：MCP `Server` 的 `instructions` 字段（`src/mcp/server.ts:19` 和 `channel.ts:127`）。所有 MCP 客户端在 initialize 时拿到，是**唯一权威**位置。

新增 instructions 段：

```markdown
## Roles

`roles` 是你能胜任的工作类型（comma-separated），影响 `role:xxx` 路由能否找到你。

自维护规则：
- 完成一类**之前没做过**的工作后，调 hive_update_role(add=['<domain>']) 注册它。
- 被 `role:X` 错误路由（你不是合适人选）时，调 hive_update_role(remove=['X'])。
- 不要预占——只为做过、能 demonstrably 完成的工作加 role。

常见 role：tester, reviewer, frontend, backend, db, devops, ux, design, docs, codex-review。
也可用项目特定标签：skillsmgr-frontend, hive-maintainer。

如果你 roles 是空的，路由会 fallback 到 display_name 子串匹配——
display_name 里带工作身份（如 "tester"）也能被找到。设 roles 后路由更精准。
```

`hive_update_role` 工具自己的 description 也写一句精简版引导（对不读 instructions 的 client 兜底）。

### 3.4 团队上下文：拉取版

#### 3.4.1 `hive-tasks` 加 `team` filter

**Schema**：
```ts
hive_tasks({
  as?: string,
  status?: TaskStatus,
  team?: string,   // NEW: team id or name; 过滤 source_team_id
})
```

**两套权限语义**（必须显式区分）：

| 分支 | 返回集 | 权限 |
|---|---|---|
| 无 `team` 参数 | creator OR assignee = 调用方（现有） | 无需额外校验 |
| 有 `team` 参数 | `source_team_id = <resolved>` | 调用方必须是该 team 当前成员，否则 403 |

**team 解析**：先 id 精确，没命中再 name 精确。

**离队后可见性**：调用方一旦不在 `team_members` 中，立刻失去对 `hive-tasks(team=X)` 的访问。但通过**不带 team 参数**的 `hive-tasks` 仍能查到自己作为 creator/assignee/workflow 参与者的所有 task——退出 team 不会隐藏"我做过的事"。

#### 3.4.2 instructions 加 Team 协作段

```markdown
## Team 协作

如果你的当前 task 有 source_team_id，或你属于某个 team：

- **创建新 task 前**：调 hive-tasks(team=<team>) 看是否已有相似任务在跑（避免重复）
- **派活时**：优先用 role:xxx，路由会在 team 成员里先匹配
- **不确定派给谁**：调 hive-team-info(team=<team>) 看成员的 roles 和 expertise
```

**注意**：上述是引导，不强制。`hive-tasks(team=X)` 的代码不会在 agent 不调时主动推送任何东西——保持 pull 模式，保护 token 预算。

### 3.5 e2e 测试（协议层 + 行为层）

**强制约束**：所有测试必须**用独立干净 DB**（`/tmp/hive-test-<uuid>.db`）+ **非默认端口**（4999），**绝不**碰 `~/.kitty-hive/hive.db` 或默认 4123 端口。每条用例 setUp 时新建 DB，tearDown 时删除。

#### 3.5.1 协议层（扩 `test-e2e.mjs`，~80 行）

新增 case，确定性 100%：

1. **`hive_update_role` 增量**：register agent → add ['tester', 'reviewer'] → 断言 roles='tester,reviewer' → add ['tester'] 不重复 → remove ['tester'] → 断言 roles='reviewer'
2. **`findAgentByRole` 双层 fallback**：register agent A roles='', display_name='alpha-tester' → role:tester 应返回 A（display_name fallback 命中）
3. **`role:xxx` team-scoped**：team T 含 agent A（display_name='alpha-tester'），全局还有 agent B（display_name='beta-tester'）→ 创建 task 带 source_team_id=T，workflow 指 role:tester → 应路由到 A 不是 B
4. **`hive_tasks(team=X)` 权限**：A 是 team T 成员 → 调 hive_tasks(team=T) 返回该 team 全部 task（不限 creator/assignee）；B 不是成员 → 返回 403
5. **`step.action.maxLength(400)`**：`hive_workflow_propose` 用 401 字符 action → 拒绝；400 字符 → 通过

#### 3.5.2 行为层（新建 `scripts/test-behavior-claude.mjs`，~120 行）

用 `claude --print --mcp-config` 起 headless 进程，验证 instructions 引导是否被 LLM 真正执行。

**不进 CI**——LLM 抖动会让结果不稳，且每次跑有 API 成本。当成发版前手动 smoke：

```bash
HIVE_TEST_PORT=4999 HIVE_TEST_DB=/tmp/hive-test-behavior.db \
  node scripts/test-behavior-claude.mjs
```

挑 2 条最关键的场景：

1. **`hive_update_role` 自维护是否被读到**：spawn 一个 claude 进程，注册为 agent，喂场景"你刚做了一个 e2e 测试任务（详情 ...）"。等完成后查 DB：该 agent 的 roles 字段是否含 'tester'？
2. **`step.action` 引用而不复述**：spawn 一个 claude 进程作为 task 接收方，喂"为这个 task 提一个 workflow"。检查生成的 workflow 中 `step.action` 的平均长度，是否 < 200 字符（即遵守了"指向不复述"的规则）。

每个场景跑 3 次，3/3 通过算稳。1/3 通过算不稳，需调整 instructions 措辞。

#### 3.5.3 测试工具脚本

新增 helper（在 `scripts/test-helpers.mjs` 或合并进 test-e2e.mjs）：

```ts
// 启动隔离 hive server
async function startTestHive(port = 4999): Promise<{ pid, dbPath, url, kill }> {
  const dbPath = `/tmp/hive-test-${randomUUID()}.db`
  const child = spawn('node', ['dist/index.js', 'serve', '--port', port, '--db', dbPath])
  await waitForHttp(`http://localhost:${port}/health`)
  return {
    pid: child.pid,
    dbPath,
    url: `http://localhost:${port}/mcp`,
    kill: () => { child.kill(); fs.unlinkSync(dbPath) }
  }
}
```

每条测试 case 自己起一个 hive server + 自己拆。慢但隔离干净。如果觉得太慢，可以 file-scope 共享 server（一次启动跑完所有协议层 case，最后拆）。

### 3.6 SKILL.md 镜像

`skills/hive/SKILL.md` 是 Claude Code plugin 用户的入口。本次更新它**镜像**协议层 instructions 的 Roles 段和 Team 协作段，但**不**作为权威来源。改协议层 instructions 时手动同步 SKILL.md。

未来可考虑用脚本从 server.ts 提取 instructions 自动生成 SKILL.md，本次不做。

---

## 4. 显式不做

| 项 | 不做的理由 |
|---|---|
| `hive-team-info` 加 task 看板 | 给所有 hive-team-info 调用都付 600-800 token 太重；team-info 是身份信息入口，不该塞动态状态 |
| task 事件汇入 `team_events` | schema 扩面太大，需新事件类型 + federation 同步；本次先做拉取版，观察是否真有"看板"需求再做推送 |
| `kitty-hive task set-team` CLI | 与 §3.1.2 的 immutable 冲突；想换 team 新建 task |
| closed team 行为分支 | close team feature 本身没实装，不会触发，写了是死代码 |
| multi-team task / federated team 归属 | 当前 0 条 task 设了 source_team_id，是理论问题不是实际问题 |
| 列表输出格式从 JSON 换 text / 字段重命名 | 破坏性变更换来的 token 节省不够大 |
| 服务端推送 role 建议给 agent | nlp 提取关键词易错；agent 自我判断更准；让 instructions 引导即可 |

---

## 5. 落地清单与代码量估计

| 项 | 文件 | 行数估 |
|---|---|---|
| `step.action.maxLength(400)` | `src/mcp/task-tools.ts` | ~3 |
| `source_team_id` immutable（核实 schema 不暴露 mutate）| `src/mcp/task-tools.ts` | ~5（验证 + 注释）|
| `findAgentByRole` 双层匹配 + teamId 参数 | `src/db.ts` | ~15 |
| `role:xxx` 调用点透传 source_team_id | `src/sessions.ts` (notifyTaskParticipants 等)、`src/tools/task.ts` | ~10 |
| `channel.ts` 不硬塞 roles | `channel.ts` | ~3 |
| `hive_update_role` 工具 + DB helper | `src/mcp/agent-tools.ts` + `src/db.ts` | ~25 |
| `hive_tasks` 加 team filter + 成员校验 | `src/mcp/task-tools.ts` | ~20 |
| `TaskListRow` 类型 + `projectTaskListRow` 投影 | `src/models.ts` + `src/mcp/task-tools.ts` | ~15 |
| `instructions` 加 Roles + Team 协作段 | `src/mcp/server.ts` + `channel.ts` | ~20（合计两处）|
| `SKILL.md` 镜像更新 | `skills/hive/SKILL.md` | ~30 |
| 数据清理 SQL（一次性，启动 migration 中执行）| `src/db.ts`（initDB）| ~5 |
| **e2e 协议层 case 扩展**（隔离 DB + 端口）| `test-e2e.mjs` + `scripts/test-helpers.mjs` | ~80 |
| **e2e 行为层脚本**（claude headless，非 CI）| `scripts/test-behavior-claude.mjs` | ~120 |
| CHANGELOG | README | ~10 |

**总计约 360 行**（含 e2e ~200 行）。比起原 v1 提案的 ~240 行多一些，但 e2e 是必须的——不然 §3.2/3.3 的引导是否真生效全凭手感。一个发布周期内仍可完成。

---

## 6. 实装时的注意点（给实装者的 checklist）

1. **maxLength(400) 上线前先跑分布统计**：`SELECT length(json_extract(value, '$.action')) FROM tasks, json_each(workflow_json) GROUP BY length / 100`。如果 >400 字符的 action 占比 >15%，把上限调到 500 再发。
2. **数据清理 SQL 写进启动 migration**：在 initDB 里加幂等检查（`IF EXISTS WHERE roles='channel'`），跑完日志一行 "[db] cleared N polluted roles"。新装 DB 不会触发，老 DB 启动时一次性洗。
3. **`role:xxx` 的 teamId 透传**要找全调用点：
   - workflow `assignees` 解析（`role:xxx` → 解析 agent）
   - 检查 `notifyTaskParticipants` 等也用了 `findAgentByRole` 的地方
   - 没 `source_team_id` 的 task 走 `teamId=undefined`，等同于纯全局查（向后兼容）
4. **`projectTaskListRow` 的字段白名单常量** 用 `as const` 锁死，类型层从这个常量推导：`type TaskListRow = Pick<Task, typeof TASK_LIST_FIELDS[number]>`。新增字段必须显式加常量才能出现在响应。
5. **`instructions` 同步**：server.ts 和 channel.ts 两份内容**应该一致**（除了"hive-channel"特定的 push 通知格式说明）。改一处务必检查另一处。考虑提取共享常量。
6. **CHANGELOG breaking changes 段**：本次没有真正 breaking（`hive_tasks` 新增 `team` 参数是可选的，老调用不变；`hive_update_role` 是新工具）。但 SQL migration 会改 agents.roles 字段，需要在 CHANGELOG 写明。
7. **测试覆盖**：
   - `hive_tasks(team=X)` 非成员调用 → 403
   - `hive_tasks(team=X)` 成员调用 → 返回该 team 所有 task（不限 creator/assignee）
   - `findAgentByRole('tester')` 在 roles='' 时回退到 display_name 含 'tester' 的 agent
   - `findAgentByRole('tester', {teamId: X})` 优先返回 team X 成员
   - `hive_update_role(add=['x'])` 后再 `add=['x']` 不重复
   - `step.action` 长度 = 401 时 propose 返回 schema error

---

## 7. 验收标准

v0.6.5 发布后，以下指标应能观察到（统计窗口 1-2 周）：

| 指标 | 当前 | 目标 |
|---|---|---|
| `agents.roles` 非空率 | ~0%（"channel" 不算）| > 30% |
| `tasks.source_team_id` 非空数 | 0 | > 0（有 agent 主动设了）|
| `step.action` 平均长度 | ~250 字符 | < 200 |
| `step.action` >400 字符的占比 | ~25% | 0%（schema 拒绝）|
| `role:xxx` 在 workflow assignees 中的使用 | 罕见 | 提升 |

**不达标也不算失败**——这些是行为指标，受用户使用习惯影响很大。但如果完全没动静（roles 还是全空、source_team_id 还是 0），说明 instructions 引导没被读到/没被遵守，需要复盘是否引导写得不够明确，或者使用模式还没切到自主路由。

---

## 8. 历史决策记录

本提案经过的方向修正（按时间）：

1. **v1**：完整的 team-task 集成（filter + board + 事件汇入 + role 路由）→ 240 行
2. **codex 第一轮 review**：补 closed team 边界、权限语义、白名单投影等
3. **用户反馈"现阶段不实装的不该写"**：删 closed team、CLI set-team、未来版本预告
4. **用户反馈"hive-tasks(team=X) agent 不会主动查"**：质疑可见性类功能 ROI
5. **方案大缩水**：仅留 maxLength + immutable + 类型分离
6. **用户反馈"我希望未来 agent 自主路由"**：方向重新校准——不是"救 team"而是"铺自主路由的路"
7. **方向校准产物**：加回 role:xxx team-scoped + display_name fallback + hive_update_role
8. **用户反馈"很难给每个 agent 填 env"**：display_name fallback 成为 bootstrap 兜底，self-update 成为精准化路径
9. **用户反馈"agent 应主动维护 role"**：明确 self-update 是正路，不做服务端自动推断
10. **用户反馈"SKILL.md 只对 Claude Code 生效"**：引导从 SKILL.md 升级到 MCP `instructions` 协议层
11. **用户反馈"为什么放弃 team-task"**：澄清——保留路由 + 拉取，砍掉看板 + 推送扩散

最终提案（本文）反映的是**第 11 步之后的共识**。
