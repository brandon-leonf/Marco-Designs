/**
 * US state codes and their full names.
 *
 * `states.code` is what every municipality is filed under, but the code alone
 * is not what anyone calls a state — the admin list, the crumb trail and the
 * state row itself all want "New Jersey". Kept here rather than in a component
 * so the admin screens and the write path agree on the spelling.
 */
export const STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", PR: "Puerto Rico",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/**
 * The full name for a code, falling back to the code itself.
 *
 * The fallback matters: rows created before this table existed were stored with
 * the code as their name, and an unrecognized code must still list as something
 * rather than as a blank row.
 */
export const stateNameFor = (code) => STATE_NAMES[String(code ?? "").toUpperCase()] ?? code ?? "—";
