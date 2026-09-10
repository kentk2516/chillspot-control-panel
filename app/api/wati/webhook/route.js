import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const recentMessages = globalThis.__watiRecentMessages || new Map();
globalThis.__watiRecentMessages = recentMessages;

const PLANS = {
  standard: {
    "1": { code: "1h", label: "1 Hour", price: 500, hours: 1 },
    "2": { code: "3h", label: "3 Hours", price: 1300, hours: 3 },
    "3": { code: "12h", label: "All Day / 12 Hours", price: 2000, hours: 12 },
    "4": { code: "overnight_a", label: "Overnight A", price: 3000 },
    "5": { code: "overnight_b", label: "Overnight B", price: 4000 }
  },
  electric: {
    "1": { code: "1h", label: "1 Hour", price: 600, hours: 1 },
    "2": { code: "3h", label: "3 Hours", price: 1600, hours: 3 },
    "3": { code: "12h", label: "All Day / 12 Hours", price: 2600, hours: 12 },
    "4": { code: "overnight_a", label: "Overnight A", price: 4000 },
    "5": { code: "overnight_b", label: "Overnight B", price: 5000 }
  }
};

function cleanupRecentMessages(now = Date.now()) {
  for (const [key, time] of recentMessages.entries()) {
    if (now - time > 120000) recentMessages.delete(key);
  }
}

function getDedupeKey(payload) {
  const explicitId = payload?.id || payload?.messageId || payload?.whatsappMessageId || payload?.localMessageId || payload?.conversationId;
  if (explicitId) return `id:${explicitId}`;
  const waId = payload?.waId || "unknown";
  const text = typeof payload?.text === "string" ? payload.text.trim() : JSON.stringify(payload?.text || "");
  const created = payload?.created || payload?.timestamp || payload?.time || "";
  return `fallback:${waId}:${created}:${text}`;
}

function isDuplicate(payload) {
  const now = Date.now();
  cleanupRecentMessages(now);
  const key = getDedupeKey(payload);
  const previous = recentMessages.get(key);
  if (previous && now - previous < 120000) return true;
  recentMessages.set(key, now);
  return false;
}

function getSupabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

async function sendWatiMessage(waId, text, channelPhoneNumber) {
  const base = process.env.WATI_API_ENDPOINT?.replace(/\/$/, "");
  const token = (process.env.WATI_ACCESS_TOKEN || "").replace(/^Bearer\s+/i, "").trim();
  if (!base || !token || !waId) return { skipped: true };

  const params = new URLSearchParams({ messageText: text });
  if (channelPhoneNumber) params.set("channelPhoneNumber", channelPhoneNumber);

  const res = await fetch(`${base}/api/v1/sendSessionMessage/${encodeURIComponent(waId)}?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });

  return { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 800) };
}

function detectLanguage(text) {
  return /[ぁ-んァ-ン一-龯]/.test(text || "") ? "ja" : "en";
}

function availabilitySnapshot(inventory) {
  const byCode = Object.fromEntries((inventory || []).map((r) => [r.vehicle_types?.code, r]));
  const standard = byCode.standard || byCode.normal || byCode.city || null;
  const electric = byCode.electric || byCode.ebike || null;
  const count = (r) => r?.enabled ? Math.max(0, (r.available_quantity || 0) - (r.reserved_quantity || 0)) : 0;
  return { standard: count(standard), electric: count(electric) };
}

function parseBikeAndQty(text, current = {}) {
  const raw = (text || "").trim();
  const lower = raw.toLowerCase();
  const next = { ...current };

  if (/電動|electric|e[- ]?bike|ebike/.test(lower)) next.bike_type = "electric";
  else if (/普通|standard|normal|city bike/.test(lower)) next.bike_type = "standard";

  const qty = raw.match(/(\d{1,2})\s*(?:台|bikes?)/i);
  if (qty) next.bike_quantity = Math.max(1, Math.min(20, Number(qty[1])));

  return next;
}

function parseTime(text) {
  const raw = (text || "").trim();
  const m = raw.match(/(?:^|\D)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:$|\D)/i);
  if (!m) return null;

  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = (m[3] || "").toLowerCase();

  if (min > 59 || h > 24) return null;
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h === 24) h = 0;

  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function calculateReturnTime(plan, pickup) {
  if (!plan || !pickup) return null;
  if (plan.code === "overnight_a") return "Next day 12:00";
  if (plan.code === "overnight_b") return "Next day 20:00";

  const [h, m] = pickup.split(":").map(Number);
  const total = h * 60 + m + (plan.hours || 0) * 60;
  const nextDay = total >= 1440;
  const mins = total % 1440;
  const hh = String(Math.floor(mins / 60)).padStart(2, "0");
  const mm = String(mins % 60).padStart(2, "0");

  return `${nextDay ? "Next day " : ""}${hh}:${mm}`;
}

function planMessage(lang, bikeType, qty) {
  const plans = PLANS[bikeType];

  if (lang === "ja") {
    return [
      `${bikeType === "electric" ? "電動自転車" : "普通自転車"} ${qty}台ですね。`,
      "ご希望のプランを番号で選んでください。",
      `1. 1時間 — ¥${plans["1"].price.toLocaleString()}/台`,
      `2. 3時間 — ¥${plans["2"].price.toLocaleString()}/台`,
      `3. 1日 / 最大12時間 — ¥${plans["3"].price.toLocaleString()}/台`,
      `4. Overnight A — 翌日12:00まで — ¥${plans["4"].price.toLocaleString()}/台`,
      `5. Overnight B — 翌日20:00まで — ¥${plans["5"].price.toLocaleString()}/台`,
      "",
      "1〜5で返信してください。"
    ].join("\n");
  }

  return [
    `${qty} ${bikeType === "electric" ? "electric" : "standard"} bike(s) selected.`,
    "Please choose a rental plan:",
    `1. 1 Hour — ¥${plans["1"].price.toLocaleString()}/bike`,
    `2. 3 Hours — ¥${plans["2"].price.toLocaleString()}/bike`,
    `3. All Day / up to 12 hours — ¥${plans["3"].price.toLocaleString()}/bike`,
    `4. Overnight A — Return by 12:00 next day — ¥${plans["4"].price.toLocaleString()}/bike`,
    `5. Overnight B — Return by 20:00 next day — ¥${plans["5"].price.toLocaleString()}/bike`,
    "",
    "Reply with 1–5."
  ].join("\n");
}

function initialMessage(lang, mode, a) {
  if (lang === "ja") {
    return [
      "CHILL SPOT Kawaguchikoです 👋",
      mode === "away" ? "現在スタッフ不在ですが、セルフレンタルをご利用いただけます。" : "現在セルフレンタルで対応しています。",
      "",
      `普通自転車: ${a.standard}台`,
      `電動自転車: ${a.electric}台`,
      "",
      "まず車種と台数を送ってください。",
      "例:『電動2台』"
    ].join("\n");
  }

  return [
    "Hi! Thanks for contacting CHILL SPOT Kawaguchiko 👋",
    mode === "away" ? "Our staff are currently away, but self-service rental is available." : "We are currently operating by self-service rental.",
    "",
    `Standard bikes: ${a.standard}`,
    `Electric bikes: ${a.electric}`,
    "",
    "First, please send the bike type and quantity.",
    'Example: “2 electric bikes”'
  ].join("\n");
}

function confirmationMessage(lang, state) {
  const total = Number(state.total_price || 0);

  if (lang === "ja") {
    return [
      "ありがとうございます。内容はこちらです ✅",
      `・車種: ${state.bike_type === "electric" ? "電動自転車" : "普通自転車"}`,
      `・台数: ${state.bike_quantity}台`,
      `・プラン: ${state.plan_label || state.rental_plan}`,
      `・受取時間: ${state.pickup_time}`,
      `・返却予定: ${state.return_time}`,
      `・合計: ¥${total.toLocaleString()}`,
      "",
      "この内容で仮予約に進めます。次にお支払い方法をご案内します。"
    ].join("\n");
  }

  return [
    "Thanks! Here are your rental details ✅",
    `• Bike: ${state.bike_type === "electric" ? "Electric" : "Standard"}`,
    `• Quantity: ${state.bike_quantity}`,
    `• Plan: ${state.plan_label || state.rental_plan}`,
    `• Pick-up: ${state.pickup_time}`,
    `• Expected return: ${state.return_time}`,
    `• Total: ¥${total.toLocaleString()}`,
    "",
    "We can now proceed to a provisional reservation. Next, we’ll send payment instructions."
  ].join("\n");
}

export async function POST(request) {
  try {
    const payload = await request.json();

    if (!["message", "messageReceived"].includes(payload?.eventType)) {
      return NextResponse.json({ ok: true, ignored: true });
    }
    if (payload?.owner === true) {
      return NextResponse.json({ ok: true, ignored: true, reason: "outbound" });
    }
    if (isDuplicate(payload)) {
      return NextResponse.json({ ok: true, ignored: true, reason: "duplicate" });
    }

    const waId = payload?.waId;
    const channelPhoneNumber = payload?.channelPhoneNumber || undefined;
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";

    if (!waId) {
      return NextResponse.json({ ok: false, error: "Missing waId" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const [settingsRes, inventoryRes, conversationRes] = await Promise.all([
      supabase.from("store_settings").select("operation_mode").limit(1).single(),
      supabase.from("self_service_inventory").select("enabled,available_quantity,reserved_quantity,vehicle_types(code,name_ja,name_en)"),
      supabase.from("wati_conversations").select("*").eq("wa_id", waId).maybeSingle()
    ]);

    for (const r of [settingsRes, inventoryRes, conversationRes]) {
      if (r.error) throw r.error;
    }

    const mode = settingsRes.data?.operation_mode;
    if (mode === "open") {
      return NextResponse.json({ ok: true, ignored: true, reason: "store_open" });
    }

    const a = availabilitySnapshot(inventoryRes.data);
    const previous = conversationRes.data;
    const stale = previous?.updated_at && Date.now() - new Date(previous.updated_at).getTime() > 12 * 60 * 60 * 1000;
    const lang = (!previous || stale) ? detectLanguage(text) : (previous.language || detectLanguage(text));

    let state = (!previous || stale) ? {} : { ...previous };
    let status = (!previous || stale || previous.status === "completed") ? "collecting_bike" : previous.status;
    let reply;

    if (!["collecting_bike", "choose_plan", "pickup_time", "ready_for_confirmation"].includes(status)) {
      status = "collecting_bike";
      state = {};
    }

    if (status === "collecting_bike") {
      state = parseBikeAndQty(text, state);

      if (!state.bike_type || !state.bike_quantity) {
        reply = initialMessage(lang, mode, a);
      } else {
        const available = a[state.bike_type];

        if (state.bike_quantity > available) {
          reply = lang === "ja"
            ? `申し訳ありません。現在${state.bike_type === "electric" ? "電動自転車" : "普通自転車"}は${available}台までです。台数を変更してください。`
            : `Sorry, only ${available} ${state.bike_type} bike(s) are currently available. Please choose a smaller quantity.`;
        } else {
          status = "choose_plan";
          reply = planMessage(lang, state.bike_type, state.bike_quantity);
        }
      }
    } else if (status === "choose_plan") {
      const choice = (text.match(/[1-5]/) || [])[0];
      const plan = choice ? PLANS[state.bike_type]?.[choice] : null;

      if (!plan) {
        reply = planMessage(lang, state.bike_type, state.bike_quantity);
      } else {
        state.rental_plan = plan.code;
        state.plan_label = plan.label;
        state.unit_price = plan.price;
        state.total_price = plan.price * state.bike_quantity;
        status = "pickup_time";
        reply = lang === "ja"
          ? `プラン「${plan.label}」ですね。受取時間を教えてください。例: 10:00`
          : `Great — ${plan.label}. What time would you like to pick up the bike(s)? Example: 10:00`;
      }
    } else if (status === "pickup_time") {
      const pickup = parseTime(text);

      if (!pickup) {
        reply = lang === "ja"
          ? "受取時間を 10:00 のように送ってください。"
          : "Please send the pick-up time like 10:00.";
      } else {
        state.pickup_time = pickup;
        const plan = Object.values(PLANS[state.bike_type] || {}).find((p) => p.code === state.rental_plan);
        state.return_time = calculateReturnTime(plan, pickup);
        status = "ready_for_confirmation";
        reply = confirmationMessage(lang, state);
      }
    } else if (status === "ready_for_confirmation") {
      reply = confirmationMessage(lang, state);
    }

    if (!reply) {
      status = "collecting_bike";
      state = {};
      reply = initialMessage(lang, mode, a);
    }

    const upsertRes = await supabase.from("wati_conversations").upsert({
      wa_id: waId,
      channel_phone_number: channelPhoneNumber || state.channel_phone_number || null,
      language: lang,
      status,
      bike_type: state.bike_type || null,
      bike_quantity: state.bike_quantity || null,
      rental_plan: state.rental_plan || null,
      unit_price: state.unit_price || null,
      total_price: state.total_price || null,
      pickup_time: state.pickup_time || null,
      return_time: state.return_time || null,
      child_seat: null,
      helmet: null,
      last_inbound_text: text,
      updated_at: new Date().toISOString()
    }, { onConflict: "wa_id" });

    if (upsertRes.error) throw upsertRes.error;

    const sent = await sendWatiMessage(waId, reply, channelPhoneNumber);
    return NextResponse.json({ ok: true, status, sent });
  } catch (error) {
    console.error("WATI webhook error", error);
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "wati-webhook", flow: "plan-based-v3-no-accessories" });
}
