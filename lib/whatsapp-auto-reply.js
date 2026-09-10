export function detectIntent(text = "") {
  const t = text.trim().toLowerCase();
  if (!t) return "greeting";
  if (/(price|料金|cost|how much)/i.test(t)) return "price";
  if (/(electric|e-bike|ebike|電動)/i.test(t)) return "electric";
  if (/(standard|normal|普通)/i.test(t)) return "standard";
  if (/(child|baby|seat|チャイルド|ベビー)/i.test(t)) return "child_seat";
  if (/(helmet|ヘルメット)/i.test(t)) return "helmet";
  if (/(return|返却|返す)/i.test(t)) return "return";
  if (/(rent|rental|bike|bicycle|自転車|借り)/i.test(t)) return "rental";
  return "greeting";
}

export function buildInventorySummary({ inventory = [], accessories = [] }) {
  const inv = Object.fromEntries(
    inventory.map((row) => [row.vehicle_types?.code, Math.max(0, (row.available_quantity || 0) - (row.reserved_quantity || 0))])
  );
  const acc = Object.fromEntries(
    accessories.map((row) => [row.code, {
      enabled: !!row.self_service_enabled,
      qty: Math.max(0, (row.available_quantity || 0) - (row.reserved_quantity || 0))
    }])
  );
  return { inv, acc };
}

export function buildAutoReply({ mode, intent, inventory, accessories }) {
  const { inv, acc } = buildInventorySummary({ inventory, accessories });
  const standard = inv.standard ?? inv.normal ?? 0;
  const electric = inv.electric ?? inv.ebike ?? 0;
  const childSeat = acc.child_seat || acc.childseat || { enabled: false, qty: 0 };
  const helmet = acc.helmet || { enabled: false, qty: 0 };

  if (mode === "open") return null;

  if (mode === "closed") {
    return [
      "Hello, this is CHILL SPOT Kawaguchiko.",
      "The shop is currently closed, but self-service rental may be available depending on stock.",
      `Standard bikes: ${standard}`,
      `Electric bikes: ${electric}`,
      `Child seat: ${childSeat.enabled && childSeat.qty > 0 ? "Available" : "Unavailable"}`,
      `Helmet: ${helmet.enabled && helmet.qty > 0 ? "Available" : "Unavailable"}`,
      "Please reply with the bike type, number of bikes, and how long you would like to rent."
    ].join("\n");
  }

  if (intent === "child_seat") {
    return childSeat.enabled && childSeat.qty > 0
      ? `Child seats are currently available. Quantity: ${childSeat.qty}. Please tell us how many you need.`
      : "Sorry, child seats are not available for self-service rental right now.";
  }

  if (intent === "helmet") {
    return helmet.enabled && helmet.qty > 0
      ? `Helmets are currently available. Quantity: ${helmet.qty}. Please tell us how many you need.`
      : "Sorry, helmets are not available for self-service rental right now.";
  }

  return [
    "Hello! This is CHILL SPOT Kawaguchiko 👋",
    "We are currently handling rentals by self-service.",
    `Standard bikes available: ${standard}`,
    `Electric bikes available: ${electric}`,
    childSeat.enabled && childSeat.qty > 0 ? `Child seats: ${childSeat.qty} available` : "Child seats: unavailable",
    helmet.enabled && helmet.qty > 0 ? `Helmets: ${helmet.qty} available` : "Helmets: unavailable",
    "Please reply with:",
    "1) Standard or Electric",
    "2) Number of bikes",
    "3) Rental time / return time",
    "We will guide you through the next step."
  ].join("\n");
}
