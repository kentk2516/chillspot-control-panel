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
  if (!base || !token || !waId || !text) return { skipped: true };
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

function toDisplayTime(value, lang) {
  if (!value) return "";
  const nextDay = /^Next day\s+/i.test(value);
  const clean = value.replace(/^Next day\s+/i, "");
  const m = clean.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return value;
  if (lang === "ja") return `${nextDay ? "翌日 " : ""}${clean}`;
  const h24 = Number(m[1]);
  const minute = m[2];
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${nextDay ? "Next day " : ""}${h12}:${minute} ${suffix}`;
}

function calculateReturnTime(plan, pickup) {
  if (!plan || !pickup) return null;
  if (plan.code === "overnight_a") return "Next day 12:00";
  if (plan.code === "overnight_b") return "Next day 20:00";
  const [h, m] = pickup.split(":").map(Number);
  const total = h * 60 + m + (plan.hours || 0) * 60;
  const nextDay = total >= 1440;
  const mins = total % 1440;
  return `${nextDay ? "Next day " : ""}${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

function wantsStaff(text) {
  const t = (text || "").trim().toLowerCase();
  return /^(staff|human|person|operator|スタッフ|店員|人と話したい|スタッフと話したい)$/.test(t);
}

function wantsCash(text) {
  const t = (text || "").trim().toLowerCase();
  return /^(cash|cash payment|pay cash|cash please|現金|現金払い|現金で|現金希望|現金払い希望)$/.test(t);
}

function wantsAutoResume(text) {
  const t = (text || "").trim().toLowerCase();
  return /^(start|resume|auto|再開|自動再開)$/.test(t);
}

function initialMessage(lang, mode, a) {
  if (lang === "ja") return [
    "CHILL SPOT Kawaguchikoです 👋",
    mode === "away" ? "現在スタッフ不在ですが、セルフレンタルをご利用いただけます。" : "現在セルフレンタルで対応しています。",
    "",
    "ご希望の車種を番号で選んでください。",
    `1. 普通自転車（現在 ${a.standard}台）`,
    `2. 電動自転車（現在 ${a.electric}台）`,
    "",
    "1 または 2 で返信してください。",
    "質問がある、またはスタッフと直接やり取りしたい場合は「スタッフ」と送ってください。"
  ].join("\n");
  return [
    "Hi! Thanks for contacting CHILL SPOT Kawaguchiko 👋",
    mode === "away" ? "Our staff are currently away, but self-service rental is available." : "We are currently operating by self-service rental.",
    "",
    "Please choose your bike type:",
    `1. Standard bike (${a.standard} available)`,
    `2. Electric bike (${a.electric} available)`,
    "",
    "Reply with 1 or 2.",
    "If you have a question or want to speak with a staff member, send STAFF at any time."
  ].join("\n");
}

function quantityMessage(lang, bikeType, available) {
  if (lang === "ja") return [
    `${bikeType === "electric" ? "電動自転車" : "普通自転車"}ですね。`,
    `現在 ${available}台 利用できます。`,
    "必要な台数を数字だけで送ってください。",
    "例: 2"
  ].join("\n");
  return [
    `${bikeType === "electric" ? "Electric" : "Standard"} bike selected.`,
    `${available} bike(s) are currently available.`,
    "How many bikes do you need?",
    "Reply with a number only, for example: 2"
  ].join("\n");
}

function planMessage(lang, bikeType, qty) {
  const plans = PLANS[bikeType];
  if (lang === "ja") return [
    `${bikeType === "electric" ? "電動自転車" : "普通自転車"} ${qty}台ですね。`,
    "ご希望のプランを番号で選んでください。",
    `1. 1時間 — ¥${plans["1"].price.toLocaleString()}/台`,
    `2. 3時間 — ¥${plans["2"].price.toLocaleString()}/台`,
    `3. 1日 / 最大12時間 — ¥${plans["3"].price.toLocaleString()}/台`,
    `4. Overnight A — 翌日12:00まで — ¥${plans["4"].price.toLocaleString()}/台`,
    `5. Overnight B — 翌日20:00まで — ¥${plans["5"].price.toLocaleString()}/台`,
    "",
    "1〜5で返信してください。",
    "スタッフと直接やり取りしたい場合は「スタッフ」と送ってください。"
  ].join("\n");
  return [
    `${qty} ${bikeType === "electric" ? "electric" : "standard"} bike(s) selected.`,
    "Please choose a rental plan:",
    `1. 1 Hour — ¥${plans["1"].price.toLocaleString()}/bike`,
    `2. 3 Hours — ¥${plans["2"].price.toLocaleString()}/bike`,
    `3. All Day / up to 12 hours — ¥${plans["3"].price.toLocaleString()}/bike`,
    `4. Overnight A — Return by 12:00 PM next day — ¥${plans["4"].price.toLocaleString()}/bike`,
    `5. Overnight B — Return by 8:00 PM next day — ¥${plans["5"].price.toLocaleString()}/bike`,
    "",
    "Reply with 1–5.",
    "To speak with a staff member, send STAFF at any time."
  ].join("\n");
}

function confirmationMessage(lang, state) {
  const total = Number(state.total_price || 0);
  if (lang === "ja") return [
    "ありがとうございます。内容はこちらです ✅",
    `・車種: ${state.bike_type === "electric" ? "電動自転車" : "普通自転車"}`,
    `・台数: ${state.bike_quantity}台`,
    `・プラン: ${state.plan_label || state.rental_plan}`,
    `・受取時間: ${toDisplayTime(state.pickup_time, "ja")}`,
    `・返却予定: ${toDisplayTime(state.return_time, "ja")}`,
    `・合計: ¥${total.toLocaleString()}`,
    "",
    "お支払い方法をご案内します。カード決済をご希望の場合はこのままお進みください。現金払いをご希望の場合は「現金」と送ってください。",
    "スタッフと直接やり取りしたい場合は「スタッフ」と送ってください。"
  ].join("\n");
  return [
    "Thanks! Here are your rental details ✅",
    `• Bike: ${state.bike_type === "electric" ? "Electric" : "Standard"}`,
    `• Quantity: ${state.bike_quantity}`,
    `• Plan: ${state.plan_label || state.rental_plan}`,
    `• Pick-up: ${toDisplayTime(state.pickup_time, "en")}`,
    `• Expected return: ${toDisplayTime(state.return_time, "en")}`,
    `• Total: ¥${total.toLocaleString()}`,
    "",
    "Next is payment. If you prefer to pay by cash, send CASH and a staff member will take over from here.",
    "To speak with a staff member for any other reason, send STAFF at any time."
  ].join("\n");
}

async function saveConversation(supabase, waId, channelPhoneNumber, lang, status, state, text) {
  return supabase.from("wati_conversations").upsert({
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
}

export async function POST(request) {
  try {
    const payload = await request.json();
    if (!["message", "messageReceived"].includes(payload?.eventType)) return NextResponse.json({ ok: true, ignored: true });
    if (payload?.owner === true) return NextResponse.json({ ok: true, ignored: true, reason: "outbound" });
    if (isDuplicate(payload)) return NextResponse.json({ ok: true, ignored: true, reason: "duplicate" });

    const waId = payload?.waId;
    const channelPhoneNumber = payload?.channelPhoneNumber || undefined;
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    if (!waId) return NextResponse.json({ ok: false, error: "Missing waId" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const [settingsRes, inventoryRes, conversationRes] = await Promise.all([
      supabase.from("store_settings").select("operation_mode").limit(1).single(),
      supabase.from("self_service_inventory").select("enabled,available_quantity,reserved_quantity,vehicle_types(code,name_ja,name_en)"),
      supabase.from("wati_conversations").select("*").eq("wa_id", waId).maybeSingle()
    ]);
    for (const r of [settingsRes, inventoryRes, conversationRes]) if (r.error) throw r.error;

    const mode = settingsRes.data?.operation_mode;
    if (mode === "open") return NextResponse.json({ ok: true, ignored: true, reason: "store_open" });

    const a = availabilitySnapshot(inventoryRes.data);
    const previous = conversationRes.data;
    const stale = previous?.updated_at && Date.now() - new Date(previous.updated_at).getTime() > 12 * 60 * 60 * 1000;
    const lang = (!previous || stale) ? detectLanguage(text) : (previous.language || detectLanguage(text));

    if (wantsStaff(text) || wantsCash(text)) {
      const state = previous && !stale ? { ...previous } : {};
      const saved = await saveConversation(supabase, waId, channelPhoneNumber, lang, "staff_handoff", state, text);
      if (saved.error) throw saved.error;
      const cash = wantsCash(text);
      const reply = cash
        ? (lang === "ja"
            ? "現金払いをご希望ですね。ここからはスタッフが対応します。少々お待ちください。必要な確認がある場合はスタッフからこのチャットでご連絡します。"
            : "You’d like to pay by cash. A staff member will take over from here. Please wait a moment; staff will reply in this chat if any confirmation is needed.")
        : (lang === "ja"
            ? "スタッフ対応に切り替えました。ご質問やご希望をこのまま送ってください。スタッフが確認後に返信します。自動案内に戻る場合は「再開」と送ってください。"
            : "You’re now connected to staff support. Please send your question or request here and a staff member will reply after checking it. To return to the automated rental guide, send START.");
      const sent = await sendWatiMessage(waId, reply, channelPhoneNumber);
      return NextResponse.json({ ok: true, status: "staff_handoff", reason: cash ? "cash_payment" : "staff_requested", sent });
    }

    if (previous?.status === "staff_handoff" && !wantsAutoResume(text)) {
      return NextResponse.json({ ok: true, ignored: true, reason: "staff_handoff" });
    }

    let state = (!previous || stale || wantsAutoResume(text)) ? {} : { ...previous };
    let status = (!previous || stale || wantsAutoResume(text) || previous?.status === "completed") ? "choose_bike_type" : previous.status;
    let reply;

    if (!["choose_bike_type", "choose_quantity", "choose_plan", "pickup_time", "ready_for_confirmation"].includes(status)) {
      status = "choose_bike_type";
      state = {};
    }

    if (status === "choose_bike_type") {
      const choice = (text.match(/^\s*([12])\s*$/) || [])[1];
      if (!choice) {
        reply = initialMessage(lang, mode, a);
      } else {
        state.bike_type = choice === "1" ? "standard" : "electric";
        const available = a[state.bike_type];
        if (available <= 0) {
          reply = lang === "ja"
            ? "申し訳ありません。現在この車種はセルフレンタル在庫がありません。別の車種をお選びください。\n\n1. 普通自転車\n2. 電動自転車"
            : "Sorry, this bike type is currently unavailable for self-service rental. Please choose another type.\n\n1. Standard bike\n2. Electric bike";
        } else {
          status = "choose_quantity";
          reply = quantityMessage(lang, state.bike_type, available);
        }
      }
    } else if (status === "choose_quantity") {
      const m = text.match(/^\s*(\d{1,2})\s*$/);
      const qty = m ? Number(m[1]) : 0;
      const available = a[state.bike_type];
      if (!qty || qty < 1) {
        reply = quantityMessage(lang, state.bike_type, available);
      } else if (qty > available) {
        reply = lang === "ja"
          ? `現在は最大${available}台まで利用できます。1〜${available}の数字で台数を送ってください。`
          : `Up to ${available} bike(s) are available. Please reply with a number from 1 to ${available}.`;
      } else {
        state.bike_quantity = qty;
        status = "choose_plan";
        reply = planMessage(lang, state.bike_type, qty);
      }
    } else if (status === "choose_plan") {
      const choice = (text.match(/^\s*([1-5])\s*$/) || [])[1];
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
          : `Great — ${plan.label}. What time would you like to pick up the bike(s)? Example: 10:00 AM`;
      }
    } else if (status === "pickup_time") {
      const pickup = parseTime(text);
      if (!pickup) {
        reply = lang === "ja"
          ? "受取時間を 10:00 のように送ってください。"
          : "Please send the pick-up time like 10:00 AM or 2:30 PM.";
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
      status = "choose_bike_type";
      state = {};
      reply = initialMessage(lang, mode, a);
    }

    const saved = await saveConversation(supabase, waId, channelPhoneNumber, lang, status, state, text);
    if (saved.error) throw saved.error;
    const sent = await sendWatiMessage(waId, reply, channelPhoneNumber);
    return NextResponse.json({ ok: true, status, sent });
  } catch (error) {
    console.error("WATI webhook error", error);
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "wati-webhook", flow: "numbered-selection-v6-cash-handoff" });
}
