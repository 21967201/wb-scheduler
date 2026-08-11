# wb-scheduler — Cloudflare Workers Cron 触发 WorkBuddy 自动化

> 状态：**代码已落地，待用户部署（需 Cloudflare + WorkBuddy API 凭证，不代填 Key）**
> 关联根因：`automation-outputs/diagnose_0808_missing.md` / `cloud_schedule_migration_plan.md`

---

## 一、架构真相（先读，避免误判）

```
Cloudflare Cron (云端，7x24 独立)
   │  UTC 0 * * * * / 0 6 * * *
   ▼
POST https://api.workbuddy.tencent.com/v2/automation/trigger
   │  Header: Authorization: Bearer <WB_TOKEN>
   │  Body:   { "workflow_id": "<自动化ID>" }
   ▼
WorkBuddy 云端中转 → 推本地 WorkBuddy 实例执行
   │  （本地实例在线时，才能跑；可访问 localhost:8099、可拉起本地进程）
   ▼
原 automation prompt 逻辑执行（与本地调度完全一致，幂等）
```

**物理边界（实事求是）：**
- ✅ 云端只做「定时点火」，不重复实现业务逻辑，维护成本低。
- ✅ 触发后的自动化在**本地实例**执行 → 缓存保活这类本地进程操作能力**不丢**。
- ⚠️ 执行端仍是本地实例，**应用必须在线**。应用完全离线时云端也推不动。
- ⚠️ 本方案解决「应用开着但内部定时器失效/抖动」漏跑，作**双触发源**；
  不解决「应用完全没开」——那只能靠**应用常开** + **失跑自检 banner**（已落地）。

**结论：** 云端迁移 = 给关键任务加一个独立于桌面应用内部定时器的外部点火源。
根治「静默丢跑」= 三层叠加：① 应用常开 + 本地 rrule 真每小时（已做）
② 云端 Cron 双触发（本包）③ 失跑自检 banner（已做，应用开时可见缺口）。

---

## 二、灰度计划（用户拍板：首站 = 缓存保活）

| 阶段 | 任务 | 验证 |
|---|---|---|
| 1（本包） | 缓存保活 `#1784789189509` 每小时双触发 + 运维每日 `#1783736219300` 北京14:00 | 观察 1 周失跑率、对比本地运行时序 |
| 2 | 全量迁移（备份/1688监控等 P1） | 结合失跑自检 banner 互验 |
| 3 | 保留本地自动化 ACTIVE 作 fallback | 云端异常即停、本地照跑 |

---

## 三、部署步骤（用户执行，我不代填 Key）

### 1. 获取 WorkBuddy API Token
- 打开 WorkBuddy 管理后台 → 开启「API 访问权限」→ 获取 Bearer Token 及对应 workflow_id
- 记录：缓存保活 / 运维每日 两个自动化的 **API workflow_id**（注意：可能与 `automation-xxx` 不同，以后台显示为准）

### 2. 安装并登录 wrangler（用户本地一次性）
```bash
npm i -g wrangler        # 或 npx wrangler
wrangler login           # 浏览器授权 Cloudflare 账号（零绑卡）
```

### 3. 注入 secret（云端托管，不落本地文件）
```bash
cd D:/WorkBuddyX/cloud-scheduler/cloudflare/wb-scheduler
wrangler secret put WB_TOKEN          # 粘贴 WorkBuddy API Token
wrangler secret put WB_KEEPALIVE_ID   # 粘贴缓存保活 workflow_id
wrangler secret put WB_OPS_ID         # 粘贴运维每日 workflow_id
wrangler secret put ALERT_WEBHOOK     # 可选：钉钉/企微机器人 webhook
```

### 4. 部署
```bash
wrangler deploy
```

### 5. 验证
- `wrangler tail` 看 Cron 触发日志（每小时 / 每日 14:00 北京）
- 观察 `automation_runs` 是否出现云端触发来源；对比本地 `last_run_at` 时间戳

---

## 四、失败告警（Cloudflare 无内置 cron 失败告警，已自建）

Worker 内 `try/catch`：trigger 返回非 2xx 或超时 → POST `ALERT_WEBHOOK`（钉钉/企微机器人）。
触发 2 次重试后仍失败才告警，避免抖动误报。

---

## 五、回滚

本地自动化全程保留 ACTIVE。云端异常时：
```bash
wrangler delete        # 或控制台停用 Cron
```
本地照常运行，零数据丢失。

---

## 六、红线合规自检

- ✅ 全程云端（Cloudflare Workers），无本地部署调度服务
- ✅ secret 存 Cloudflare 环境变量，不写本地文件、不进仓库
- ✅ 未要求填 AI 大模型 Key（WB_TOKEN 是 WorkBuddy 应用 API 凭证，非模型 Key）
- ✅ 不绑卡假免费（Cloudflare Free 档 cron 可用）
