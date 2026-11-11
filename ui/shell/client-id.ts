// Kennung dieses Browser-Tabs für die Admin-Ansicht „Verbundene Clients“: bleibt beim Neuladen gleich (sessionStorage),
// ist je Tab verschieden und enthält nichts Persönliches.
let cached = "";

export function clientId(): string {
  if (cached) return cached;
  try {
    const saved = sessionStorage.getItem("omp-client-id");
    if (saved) return (cached = saved);
  } catch { /* ohne Speicher: Kennung gilt nur bis zum Neuladen */ }
  const b = crypto.getRandomValues(new Uint8Array(8));
  cached = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  try {
    sessionStorage.setItem("omp-client-id", cached);
  } catch { /* egal */ }
  return cached;
}
