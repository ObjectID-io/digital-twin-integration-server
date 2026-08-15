const TWIN_ID_PATTERN = /^0x[0-9a-f]{64}$/i;

export function isTwinId(value) {
  return TWIN_ID_PATTERN.test(String(value ?? "").trim());
}

export function twinIdFromLocation(location) {
  const pathname = String(location?.pathname ?? "");
  const pathMatch = pathname.match(/^\/twin\/(0x[0-9a-f]{64})\/?$/i);
  if (pathMatch) return pathMatch[1];

  const queryValue = new URLSearchParams(String(location?.search ?? "")).get("twinId");
  return isTwinId(queryValue) ? queryValue : "";
}

export function twinShareUrl(origin, twinId) {
  if (!isTwinId(twinId)) return "";
  return `${String(origin ?? "").replace(/\/$/, "")}/twin/${encodeURIComponent(twinId)}`;
}
