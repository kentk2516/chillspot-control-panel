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
  const explicitId =
    payload?.id ||
    payload?.messageId ||
    payload?.whatsappMessageId ||
    payload?.localMessageId ||
    payload?.conversationId;

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

  if (previous && now - previous < 120000) {
    return { duplicate: true, key };
  }

  recentMessages.set(key, now);
  return { duplicate: false, key };
}

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

async function sendWatiMessage(waId, text, channelPhoneNumber) {
  const base = process.env.WATI_API_ENDPOINT?.replace(/\/$/, "");
  const rawToken = process.env.WATI_ACCESS_TOKEN || "";
  const token = rawToken.replace(/^Bearer\s+/i, "").trim();

  console.log("WATI send config", {
    hasBase: !!base,
    hasToken: !!token,
    waId,
    channelPhoneNumber: channelPhoneNumber || null
  });

  if (!base || !token || !waId) {
    return { skipped: true, hasBase: !!base, hasToken: !!token, hasWaId: !!waId };
  }

  const params = new URLSearchParams({ messageText: text });
  if (channelPhoneNumber) params.set("channelPhoneNumber", channelPhoneNumber);

  const url = `${base}/api/v1/sendSessionMessage/${encodeURIComponent(waId)}?${params.toString()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });

  const body = await res.text();
  const result = { ok: res.ok, status: res.status, body: body.slice(0, 1000) };
  console.log("WATI send result", result);
  return result;
}

function buildReply({ mode, inventory, accessories }) {
  const labels = {
    away: "Our staff are currently away from the shop, but self-service rental is available.",
    closed: "The shop is currently closed, but self-service rental may still be available.",
    self_service: "We are currently operating by self-service rental."
  };

  const byCode = Object.fromEntries((inventory || []).map((r) => [r.vehicle_types?.code, r]));
  const standard = byCode.standard || byCode.normal || byCode.city || null;
  const electric = byCode.electric || byCode.ebike || null;
  const accessoryMap = Object.fromEntries((accessories || []).map((r) => [r.code, r]));
  const child = accessoryMap.child_seat || accessoryMap.childseat || null;
  const helmet = accessoryMap.helmet || null;

  const available = (r) => r?.enabled ? Math.max(0, (r.available_quantity || 0) - (r.reserved_quantity || 0)) : 0;
  const optionText = (r) => r?.self_service_enabled && (r.available_quantity || 0) > (r.reserved_quantity || 0) ? "Available" : "Unavailable";

  return [
    "Hi! Thanks for contacting CHILL SPOT Kawaguchiko 👋",
    labels[mode] || "Self-service rental is currently available.",
    "",
    "Current availability:",
    `• Standard bikes: ${available(standard)}`,
    `• Electric bikes: ${available(electric)}`,
    `• Child seat: ${optionText(child)}`,
    `• Helmet: ${optionText(helmet)}`,
    "",
    "To arrange your rental, please send:",
    "1. Bike type (Standard / Electric)",
    "2. Number of bikes",
    "3. Pick-up time",
    "4. Expected return time",
    "5. Whether you need a child seat or helmet",
    "",
    "We’ll guide you through the next steps after we receive these details."
  ].join("\n");
}

export async function POST(request) {
  try {
    const payload = await request.json();
    const eventType = payload?.eventType;

    console.log("WATI webhook received", {
      eventType,
      owner: payload?.owner,
      waId: payload?.waId,
      channelPhoneNumber: payload?.channelPhoneNumber,
      type: payload?.type,
      text: payload?.text,
      id: payload?.id || payload?.messageId || payload?.whatsappMessageId || payload?.localMessageId || null
    });

    if (!["message", "messageReceived"].includes(eventType)) {
      return NextResponse.json({ ok: true, ignored: true, eventType });
    }
    if (payload?.owner === true) {
      return NextResponse.json({ ok: true, ignored: true, reason: "outbound" });
    }

    const dedupe = isDuplicate(payload);
    if (dedupe.duplicate) {
      console.log("WATI duplicate webhook ignored", { key: dedupe.key });
      return NextResponse.json({ ok: true, ignored: true, reason: "duplicate" });
    }

    const waId = payload?.waId;
    const channelPhoneNumber = payload?.channelPhoneNumber || undefined;
    if (!waId) return NextResponse.json({ ok: false, error: "Missing waId" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const [settingsRes, inventoryRes, accessoriesRes] = await Promise.all([
      supabase.from("store_settings").select("operation_mode").limit(1).single(),
      supabase.from("self_service_inventory").select("enabled,available_quantity,reserved_quantity,vehicle_types(code,name_ja,name_en)"),
      supabase.from("rental_accessories").select("code,self_service_enabled,available_quantity,reserved_quantity")
    ]);

    if (settingsRes.error) throw settingsRes.error;
    if (inventoryRes.error) throw inventoryRes.error;
    if (accessoriesRes.error) throw accessoriesRes.error;

    const mode = settingsRes.data?.operation_mode;
    console.log("WATI operation mode", mode);
    if (mode === "open") {
      return NextResponse.json({ ok: true, ignored: true, reason: "store_open" });
    }

    const reply = buildReply({ mode, inventory: inventoryRes.data, accessories: accessoriesRes.data });
    const sent = await sendWatiMessage(waId, reply, channelPhoneNumber);

    console.log("WATI webhook complete", { sent });
    return NextResponse.json({ ok: true, sent });
  } catch (error) {
    console.error("WATI webhook error", error);
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "wati-webhook" });
}
