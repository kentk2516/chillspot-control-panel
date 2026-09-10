import { createClient } from "@supabase/supabase-js";
import { buildAutoReply, detectIntent } from "../../../../lib/whatsapp-auto-reply";

function serverSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase server environment variables");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function sendWhatsAppText(to, body) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const version = process.env.WHATSAPP_GRAPH_API_VERSION;
  if (!phoneNumberId || !token || !version) {
    throw new Error("Missing WhatsApp environment variables");
  }

  const res = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WhatsApp send failed: ${res.status} ${text}`);
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge || "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function POST(request) {
  try {
    const payload = await request.json();
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== "text") {
      return Response.json({ ok: true, ignored: true });
    }

    const from = message.from;
    const text = message.text?.body || "";

    const supabase = serverSupabase();
    const [settingsRes, inventoryRes, accessoriesRes] = await Promise.all([
      supabase.from("store_settings").select("operation_mode").limit(1).single(),
      supabase.from("self_service_inventory")
        .select("enabled,available_quantity,reserved_quantity,vehicle_types(code,name_ja,name_en)"),
      supabase.from("rental_accessories")
        .select("code,name_ja,name_en,self_service_enabled,available_quantity,reserved_quantity")
    ]);

    if (settingsRes.error) throw settingsRes.error;
    if (inventoryRes.error) throw inventoryRes.error;
    if (accessoriesRes.error) throw accessoriesRes.error;

    const inventory = (inventoryRes.data || []).filter((row) => row.enabled);
    const accessories = accessoriesRes.data || [];
    const mode = settingsRes.data?.operation_mode || "open";
    const intent = detectIntent(text);
    const reply = buildAutoReply({ mode, intent, inventory, accessories });

    if (reply) await sendWhatsAppText(from, reply);

    return Response.json({ ok: true, replied: !!reply, mode, intent });
  } catch (error) {
    console.error(error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}
