// Verbundene Clients: Browser-Kennung (User-Agent) kurz und lesbar machen.

/** „Chrome 156 · Linux“ aus einem User-Agent; unbekannte Kennungen bleiben gekürzt im Klartext. */
export function shortBrowser(ua: string): string {
  if (!ua) return "–";
  // Reihenfolge zählt: Edge/Opera/Headless tragen auch „Chrome“, Chrome trägt „Safari“.
  const rules: [RegExp, string][] = [
    [/Edg\/(\d+)/, "Edge"],
    [/OPR\/(\d+)/, "Opera"],
    [/Firefox\/(\d+)/, "Firefox"],
    [/HeadlessChrome\/(\d+)/, "Chrome (headless)"],
    [/(?:Chrome|Chromium)\/(\d+)/, "Chrome"],
    [/Version\/(\d+)[^]*Safari/, "Safari"],
  ];
  let browser = "";
  for (const [re, name] of rules) {
    const m = ua.match(re);
    if (m) {
      browser = `${name} ${m[1]}`;
      break;
    }
  }
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad|iOS/.test(ua)
    ? "iOS"
    : /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/.test(ua)
    ? "macOS"
    : /CrOS/.test(ua)
    ? "ChromeOS"
    : /Linux|X11/.test(ua)
    ? "Linux"
    : "";
  if (!browser && !os) return ua.length > 40 ? ua.slice(0, 40) + "…" : ua;
  return [browser, os].filter(Boolean).join(" · ");
}

/** Loopback-Adressen als „lokal“ zeigen, alles andere unverändert. */
export function showAddress(ip: string): string {
  return ip === "::1" || ip === "127.0.0.1" ? "localhost" : ip;
}
