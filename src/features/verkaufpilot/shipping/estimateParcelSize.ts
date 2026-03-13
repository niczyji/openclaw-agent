// src/features/verkaufpilot/shipping/estimateParcelSize.ts
//
// Estimates a Hermes parcel size category (S / M / L) from an item title.
// Pure keyword matching — no LLM needed.
//
// Hermes size reference (myHermes.de, non-business):
//   S  — up to 25×35×5 cm,  max 1 kg   (e.g. small accessories, cables, books)
//   M  — up to 37×37×13 cm, max 5 kg   (e.g. phones, tablets, small devices)
//   L  — up to 60×30×15 cm, max 15 kg  (e.g. laptops, consoles, speakers)

export type ParcelSizeCategory = "S" | "M" | "L";

// Keywords that strongly suggest size S (small accessories)
const SIZE_S_KEYWORDS = [
  "kabel", "cable", "adapter", "ladekabel", "netzteil", "charger",
  "maus", "mouse", "earbuds", "kopfhörer", "headset", "airpods",
  "case", "hülle", "schutzfolie", "screen protector", "stylus",
  "speicherkarte", "sd card", "usb stick", "usb-stick",
  "fernbedienung", "remote", "armband", "wristband", "uhrband",
  "ring", "schlüssel", "key", "dongle", "hub",
];

// Keywords that suggest size L (large / heavy items)
const SIZE_L_KEYWORDS = [
  "laptop", "notebook", "monitor", "bildschirm", "drucker", "printer",
  "konsole", "console", "playstation", "xbox", "nintendo switch oled",
  "lautsprecher", "speaker", "soundbar", "subwoofer",
  "kamera", "camera", "objektiv", "lens",
  "grafikkarte", "gpu", "mainboard", "tower", "desktop",
  "mikrofon", "microphone", "interface", "mixer",
  "stativ", "tripod", "projektor", "beamer",
];

export function estimateParcelSize(itemTitle: string): ParcelSizeCategory {
  const lower = itemTitle.toLowerCase();

  // Check L first (heavier/larger items beat accessories)
  for (const kw of SIZE_L_KEYWORDS) {
    if (lower.includes(kw)) return "L";
  }

  // Check S (small accessories)
  for (const kw of SIZE_S_KEYWORDS) {
    if (lower.includes(kw)) return "S";
  }

  // Default: M covers phones, tablets, headphones, controllers, etc.
  return "M";
}

/** Human-readable description of the size category. */
export function sizeDescription(size: ParcelSizeCategory): string {
  switch (size) {
    case "S": return "S (bis 25×35×5 cm, max 1 kg)";
    case "M": return "M (bis 37×37×13 cm, max 5 kg)";
    case "L": return "L (bis 60×30×15 cm, max 15 kg)";
  }
}
