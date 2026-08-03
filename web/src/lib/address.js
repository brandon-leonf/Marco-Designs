const titleCaseAddressPart = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (_match, before, letter) => `${before}${letter.toUpperCase()}`)
    .replace(/\b(?:n|s|e|w|ne|nw|se|sw)\b/gi, (direction) => direction.toUpperCase());

/**
 * NJGIN's PROP_LOC contains the recorded street address while the address
 * match supplies its postal ZIP. For New Jersey parcel results, NJGIN's
 * MUN_NAME is authoritative for the municipality — it correctly distinguishes
 * Union City from Union even when a geocoder returns the shorter place name.
 */
export function standardizedPropertyAddress(parcel, parcelPick, muni) {
  const fullMatch = String(
    parcelPick?.matched_address ?? parcelPick?.full_label ?? parcelPick?.address ?? ""
  ).trim();
  const parts = fullMatch.split(",").map((part) => part.trim()).filter(Boolean);
  const street = titleCaseAddressPart(parcel?.address ?? parts[0]);
  const municipality = titleCaseAddressPart(
    parcelPick?.muni_name ?? muni?.name ?? (parts.length > 1 ? parts[1] : null)
  ).replace(/\s+(?:Twp|Township|Boro|Borough|Village)$/i, "");
  const stateZip = fullMatch.match(/\b([a-z]{2})\b[\s,]+(\d{5}(?:-\d{4})?)\b/i);
  const state = String(stateZip?.[1] ?? parcelPick?.state_code ?? muni?.state_code ?? "")
    .trim()
    .toUpperCase();
  const zip = stateZip?.[2] ?? fullMatch.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] ?? "";

  if (!street) {
    return [municipality, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  }
  if (!municipality) return street;
  return `${street}, ${municipality}${state ? `, ${state}${zip ? ` ${zip}` : ""}` : ""}`;
}
