/**
 * wb-scheduler — Cloudflare Worker (Cron Triggers), Service Worker 格式
 *
 * 链路：Cloudflare Cron -> POST api.workbuddy.tencent.com/v2/automation/trigger
 *       -> WorkBuddy 云端中转 -> 推本地 WorkBuddy 实例执行（本地操作能力不丢）
 *
 * 物理边界（务必知悉）：
 *   - 执行端仍是本地 WorkBuddy 实例，需应用在线。应用完全离线时云端也推不动。
 *   - 本 Worker 解决的是「应用开着但内部定时器失效/漏触发」的抖动，作双触发源。
 *   - 根治「应用完全没开就丢跑」= 应用常开 + 失跑自检 banner（已落地）。
 *
 * 部署：deploy.py 走 Cloudflare REST API（单文件 PUT，经典格式）。
 * 绑定变量（vars）：WB_API_BASE / WB_KEEPALIVE_ID / WB_OPS_ID（非密，已注入）
 * 绑定密钥（secret）：WB_TOKEN / ALERT_WEBHOOK（需 `wrangler secret put` 注入）
 */
const TRIGGER_PATH = "/v2/automation/trigger";

// 经典格式下绑定以全局变量形式注入；用 typeof 守卫，未配置不抛错
const BASE  = (typeof WB_API_BASE !== "undefined") ? WB_API_BASE : "https://api.workbuddy.tencent.com";
const TOKEN = (typeof WB_TOKEN !== "undefined") ? WB_TOKEN : undefined;
const ALERT = (typeof ALERT_WEBHOOK !== "undefined") ? ALERT_WEBHOOK : undefined;

async function handleScheduled() {
  const root = BASE.replace(/\/+$/, "");

  const targets = [];
  if (typeof WB_KEEPALIVE_ID !== "undefined") targets.push({ id: WB_KEEPALIVE_ID, name: "cache-keepalive" });
  if (typeof WB_OPS_ID !== "undefined") targets.push({ id: WB_OPS_ID, name: "ops-daily" });

  if (!TOKEN) {
    console.error("WB_TOKEN 未配置，跳过触发");
    return;
  }

  for (const t of targets) {
    let ok = false;
    let lastErr = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        const r = await fetch(`${root}${TRIGGER_PATH}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify({ workflow_id: t.id }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (r.ok) {
          ok = true;
          break;
        }
        lastErr = `HTTP ${r.status} ${await r.text().catch(() => "")}`.slice(0, 200);
      } catch (e) {
        lastErr = String(e).slice(0, 200);
      }
      await new Promise((res) => setTimeout(res, 3000));
    }

    // 失败告警（自建，Cloudflare 无内置 cron 失败告警）
    if (!ok && ALERT) {
      await fetch(ALERT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msgtype: "text",
          text: { content: `[wb-scheduler] 触发失败: ${t.name} (${t.id}) - ${lastErr}` },
        }),
      }).catch(() => {});
    }
    console.log(`trigger ${t.name} (${t.id}): ${ok ? "OK" : "FAIL " + lastErr}`);
  }
}

addEventListener("scheduled", (event) => {
  event.waitUntil(handleScheduled());
});
