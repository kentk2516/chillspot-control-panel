import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

function buildReply({ mode, inventory, accessories }) {
  const labels = {
    open: "The shop is currently open, so automatic self-service replies are OFF.",
    away: "We are currently away from the shop, but self-service rental is available.",
    closed: "The shop is currently closed. Self-service rental may still be available.",
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

  return {
    autoReplyEnabled: mode !== "open",
    mode,
    reply: [
      "Hello! This is CHILL SPOT Kawaguchiko 👋",
      labels[mode] || "Self-service rental is currently available.",
      "",
      `Standard bikes: ${available(standard)} available`,
      `Electric bikes: ${available(electric)} available`,
      `Child seat: ${optionText(child)}`,
      `Helmet: ${optionText(helmet)}`,
      "",
      "Please reply with:",
      "1) Standard or Electric",
      "2) Number of bikes",
      "3) Rental time / return time"
    ].join("\n")
  };
}

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const [settingsRes, inventoryRes, accessoriesRes] = await Promise.all([
      supabase.from("store_settings").select("operation_mode").limit(1).single(),
      supabase.from("self_service_inventory").select("enabled,available_quantity,reserved_quantity,vehicle_types(code,name_ja,name_en)"),
      supabase.from("rental_accessories").select("code,self_service_enabled,available_quantity,reserved_quantity")
    ]);

    if (settingsRes.error) throw settingsRes.error;
    if (inventoryRes.error) throw inventoryRes.error;
    if (accessoriesRes.error) throw accessoriesRes.error;

    return NextResponse.json(buildReply({
      mode: settingsRes.data?.operation_mode,
      inventory: inventoryRes.data,
      accessories: accessoriesRes.data
    }));
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 500 });
  }
}
