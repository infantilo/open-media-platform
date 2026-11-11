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

export interface ClientDevice {
  name: string;
  simulated?: boolean;
}

export interface ClientLike {
  user: string;
  remoteIp: string;
  userAgent: string;
  devices?: { midi?: ClientDevice[]; streamDeck?: ClientDevice[] };
}

/** Geräte einer Zeile als Anzeigetexte, z. B. „MIDI: iCON (Simulator)“. */
export function deviceLabels(c: ClientLike, tr: { midi: string; deck: string; sim: string }): string[] {
  const out: string[] = [];
  for (const d of c.devices?.midi ?? []) out.push(`${tr.midi}: ${d.name}${d.simulated ? ` (${tr.sim})` : ""}`);
  for (const d of c.devices?.streamDeck ?? []) out.push(`${tr.deck}: ${d.name}${d.simulated ? ` (${tr.sim})` : ""}`);
  return out;
}

/**
 * Suche in der Clientliste: Leerzeichen trennen Begriffe, alle müssen vorkommen (Groß/Klein egal) — in Benutzer,
 * Adresse, Browser und Gerätenamen. „midi“ und „streamdeck“/„stream deck“ finden Clients, die so ein Gerät melden,
 * „simulator“ solche mit Simulator.
 */
export function matchesClient(c: ClientLike, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const midi = c.devices?.midi ?? [];
  const deck = c.devices?.streamDeck ?? [];
  const hay = [
    c.user,
    c.remoteIp,
    showAddress(c.remoteIp),
    shortBrowser(c.userAgent),
    c.userAgent,
    ...midi.map((d) => d.name),
    ...deck.map((d) => d.name),
    midi.length ? "midi" : "",
    deck.length ? "streamdeck stream deck" : "",
    [...midi, ...deck].some((d) => d.simulated) ? "simulator" : "",
  ].join("\n").toLowerCase();
  // „stream deck“ als zwei Begriffe ergäbe zwei Treffer auf demselben Text — reicht, da beide enthalten sind
  return terms.every((t) => hay.includes(t));
}
