import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const recentMessages = globalThis.__watiRecentMessages || new Map();
globalThis.__watiRecentMessages = recentMessages;

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
  if (previous && now - previous < 120000) return { duplicate: true, key };
  recentMessages.set(key, now);
  return { duplicate: false, key };
}

function getSupabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

async function sendWatiMessage(waId, text, channelPhoneNumber) {
  const base = process.env.WATI_API_ENDPOINT?.replace(/\/$/, "");
  const rawToken = process.env.WATI_ACCESS_TOKEN || "";
  const token = rawToken.replace(/^Bearer\s+/i, "").trim();
  if (!base || !token || !waId) return { skipped: true };

  const params = new URLSearchParams({ messageText: text });
  if (channelPhoneNumber) params.set("channelPhoneNumber", channelPhoneNumber);

  const res = await fetch(`${base}/api/v1/sendSessionMessage/${encodeURIComponent(waId)}?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body: body.slice(0, 800) };
}

function detectLanguage(text) {
  return /[ぁ-んァ-ン一-龯]/.test(text || "") ? "ja" : "en";
}

function parseDetails(text, current = {}) {
  const raw = (text || "").trim();
  const lower = raw.toLowerCase();
  const next = { ...current };

  if (/電動|electric|e[- ]?bike|ebike/.test(lower)) next.bike_type = "electric";
  else if (/普通|standard|normal|city bike/.test(lower)) next.bike_type = "standard";

  const qtyMatch = raw.match(/(\d{1,2})\s*(?:台|bikes?)/i);
  if (qtyMatch) next.bike_quantity = Math.max(1, Math.min(20, Number(qtyMatch[1])));
  else if (!next.bike_quantity && /^\s*\d{1,2}\s*$/.test(raw)) next.bike_quantity = Math.max(1, Math.min(20, Number(raw)));

  const pickupLabel = raw.match(/(?:pick[ -]?up|pickup|start|受取|受け取り|開始)[^0-9]{0,12}(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  const returnLabel = raw.match(/(?:return|end|返却)[^0-9]{0,12}(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  if (pickupLabel) next.pickup_time = pickupLabel[1].trim();
  if (returnLabel) next.return_time = returnLabel[1].trim();

  if (!next.pickup_time || !next.return_time) {
    const times = [...raw.matchAll(/\b(\d{1,2}:\d{2}\s*(?:am|pm)?)\b/gi)].map((m) => m[1]);
    if (times.length >= 2) {
      if (!next.pickup_time) next.pickup_time = times[0];
      if (!next.return_time) next.return_time = times[1];
    }
  }

  if (/child\s*seat|baby\s*seat|チャイルドシート|子供.*シート/i.test(raw)) {
    next.child_seat = !/(?:no|not|不要|いらない|なし).{0,10}(?:child|baby|チャイルド)/i.test(raw) && !/(?:child|baby|チャイルド).{0,10}(?:no|not|不要|いらない|なし)/i.test(raw);
  }
  if (/helmet|ヘルメット/i.test(raw)) {
    next.helmet = !/(?:no|not|不要|いらない|なし).{0,10}(?:helmet|ヘルメット)/i.test(raw) && !/(?:helmet|ヘルメット).{0,10}(?:no|not|不要|いらない|なし)/i.test(raw);
  }

  return next;
}

function availabilitySnapshot(inventory, accessories) {
  const byCode = Object.fromEntries((inventory || []).map((r) => [r.vehicle_types?.code, r]));
  const standard = byCode.standard || byCode.normal || byCode.city || null;
  const electric = byCode.electric || byCode.ebike || null;
  const accessoryMap = Object.fromEntries((accessories || []).map((r) => [r.code, r]));
  const child = accessoryMap.child_seat || accessoryMap.childseat || null;
  const helmet = accessoryMap.helmet || null;
  const count = (r) => r?.enabled ? Math.max(0, (r.available_quantity || 0) - (r.reserved_quantity || 0)) : 0;
  const accessoryAvailable = (r) => !!(r?.self_service_enabled && (r.available_quantity || 0) > (r.reserved_quantity || 0));
  return {
    standard: count(standard),
    electric: count(electric),
    childSeat: accessoryAvailable(child),
    helmet: accessoryAvailable(helmet)
  };
}

function missingFields(state) {
  const missing = [];
  if (!state.bike_type) missing.push("bike_type");
  if (!state.bike_quantity) missing.push("bike_quantity");
  if (!state.pickup_time) missing.push("pickup_time");
  if (!state.return_time) missing.push("return_time");
  if (state.child_seat === null || state.child_seat === undefined) missing.push("child_seat");
  if (state.helmet === null || state.helmet === undefined) missing.push("helmet");
  return missing;
}

function initialReply(lang, mode, a) {
  if (lang === "ja") {
    return [
      "CHILL SPOT Kawaguchikoです 👋",
      mode === "away" ? "現在スタッフ不在ですが、セルフレンタルをご利用いただけます。" : "現在セルフレンタルで対応しています。",
      "",
      "現在の在庫:",
      `・普通自転車: ${a.standard}台`,
      `・電動自転車: ${a.electric}台`,
      `・チャイルドシート: ${a.childSeat ? "利用可能" : "利用不可"}`,
      `・ヘルメット: ${a.helmet ? "利用可能" : "利用不可"}`,
      "",
      "ご希望をそのまま文章で送ってください。例:",
      "『電動2台、10:00受取、17:00返却、ヘルメットあり、チャイルドシートなし』"
    ].join("\n");
  }
  return [
    "Hi! Thanks for contacting CHILL SPOT Kawaguchiko 👋",
    mode === "away" ? "Our staff are currently away, but self-service rental is available." : "We are currently operating by self-service rental.",
    "",
    "Current availability:",
    `• Standard bikes: ${a.standard}`,
    `• Electric bikes: ${a.electric}`,
    `• Child seat: ${a.childSeat ? "Available" : "Unavailable"}`,
    `• Helmet: ${a.helmet ? "Available" : "Unavailable"}`,
    "",
    "Please send your request in one message. Example:",
    '“2 electric bikes, pickup 10:00, return 17:00, helmet yes, child seat no”'
  ].join("\n");
}

function followupReply(lang, state, missing, a) {
  const available = state.bike_type ? a[state.bike_type] : null;
  if (state.bike_type && state.bike_quantity && available !== null && state.bike_quantity > available) {
    if (lang === "ja") return `申し訳ありません。現在${state.bike_type === "electric" ? "電動自転車" : "普通自転車"}は${available}台までご利用可能です。台数を変更するか、別の車種をお選びください。`;
    return `Sorry, we currently have only ${available} ${state.bike_type === "electric" ? "electric" : "standard"} bike(s) available. Please choose a smaller quantity or another bike type.`;
  }

  if (missing.length === 0) {
    const child = state.child_seat ? "Yes" : "No";
    const helmet = state.helmet ? "Yes" : "No";
    if (lang === "ja") {
      return [
        "ありがとうございます。内容を確認します ✅",
        `・車種: ${state.bike_type === "electric" ? "電動自転車" : "普通自転車"}`,
        `・台数: ${state.bike_quantity}台`,
        `・受取: ${state.pickup_time}`,
        `・返却: ${state.return_time}`,
        `・チャイルドシート: ${state.child_seat ? "あり" : "なし"}`,
        `・ヘルメット: ${state.helmet ? "あり" : "なし"}`,
        "",
        "この内容で仮予約に進めます。次に料金とお支払い方法をご案内します。"
      ].join("\n");
    }
    return [
      "Thanks! Please confirm these details ✅",
      `• Bike: ${state.bike_type === "electric" ? "Electric" : "Standard"}`,
      `• Quantity: ${state.bike_quantity}`,
      `• Pick-up: ${state.pickup_time}`,
      `• Return: ${state.return_time}`,
      `• Child seat: ${child}`,
      `• Helmet: ${helmet}`,
      "",
      "We can now proceed to a provisional reservation. Next, we’ll send the price and payment instructions."
    ].join("\n");
  }

  const labelsJa = { bike_type: "車種（普通 / 電動）", bike_quantity: "台数", pickup_time: "受取時間", return_time: "返却時間", child_seat: "チャイルドシートの要否", helmet: "ヘルメットの要否" };
  const labelsEn = { bike_type: "bike type (Standard / Electric)", bike_quantity: "number of bikes", pickup_time: "pick-up time", return_time: "return time", child_seat: "whether you need a child seat", helmet: "whether you need a helmet" };
  if (lang === "ja") return `ありがとうございます。あと次の情報をお願いします:\n・${missing.map((x) => labelsJa[x]).join("\n・")}`;
  return `Thanks! I just need the following information:\n• ${missing.map((x) => labelsEn[x]).join("\n• ")}`;
}

export async function POST(request) {
  try {
    const payload = await request.json();
    const eventType = payload?.eventType;
    if (!["message", "messageReceived"].includes(eventType)) return NextResponse.json({ ok: true, ignored: true, eventType });
    if (payload?.owner === true) return NextResponse.json({ ok: true, ignored: true, reason: "outbound" });

    const dedupe = isDuplicate(payload);
    if (dedupe.duplicate) return NextResponse.json({ ok: true, ignored: true, reason: "duplicate" });

    const waId = payload?.waId;
    const channelPhoneNumber = payload?.channelPhoneNumber || undefined;
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    if (!waId) return NextResponse.json({ ok: false, error: "Missing waId" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const [settingsRes, inventoryRes, accessoriesRes, conversationRes] = await Promise.all([
      supabase.from("store_settings").select("operation_mode").limit(1).single(),
      supabase.from("self_service_inventory").select("enabled,available_quantity,reserved_quantity,vehicle_types(code,name_ja,name_en)"),
      supabase.from("rental_accessories").select("code,self_service_enabled,available_quantity,reserved_quantity"),
      supabase.from("wati_conversations").select("*").eq("wa_id", waId).maybeSingle()
    ]);

    if (settingsRes.error) throw settingsRes.error;
    if (inventoryRes.error) throw inventoryRes.error;
    if (accessoriesRes.error) throw accessoriesRes.error;
    if (conversationRes.error) throw conversationRes.error;

    const mode = settingsRes.data?.operation_mode;
    if (mode === "open") return NextResponse.json({ ok: true, ignored: true, reason: "store_open" });

    const availability = availabilitySnapshot(inventoryRes.data, accessoriesRes.data);
    const previous = conversationRes.data;
    const stale = previous?.updated_at && Date.now() - new Date(previous.updated_at).getTime() > 12 * 60 * 60 * 1000;
    const lang = stale || !previous ? detectLanguage(text) : (previous.language || detectLanguage(text));

    let reply;
    let state;

    if (!previous || stale || previous.status === "completed") {
      state = parseDetails(text, {});
      const missing = missingFields(state);
      reply = Object.keys(state).length === 0 || missing.length >= 5
        ? initialReply(lang, mode, availability)
        : followupReply(lang, state, missing, availability);
    } else {
      state = parseDetails(text, previous);
      const missing = missingFields(state);
      reply = followupReply(lang, state, missing, availability);
    }

    const missing = missingFields(state);
    const status = missing.length === 0 ? "ready_for_confirmation" : "collecting";

    const upsertRes = await supabase.from("wati_conversations").upsert({
      wa_id: waId,
      channel_phone_number: channelPhoneNumber || previous?.channel_phone_number || null,
      language: lang,
      status,
      bike_type: state.bike_type || null,
      bike_quantity: state.bike_quantity || null,
      pickup_time: state.pickup_time || null,
      return_time: state.return_time || null,
      child_seat: state.child_seat ?? null,
      helmet: state.helmet ?? null,
      last_inbound_text: text,
      updated_at: new Date().toISOString()
    }, { onConflict: "wa_id" });
    if (upsertRes.error) throw upsertRes.error;

    const sent = await sendWatiMessage(waId, reply, channelPhoneNumber);
    return NextResponse.json({ ok: true, status, missing, sent });
  } catch (error) {
    console.error("WATI webhook error", error);
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "wati-webhook", flow: "stateful-v1" });
}
