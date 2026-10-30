// Notiz zu Marker und Freeze (Kap. 72): was ist passiert, warum wird markiert? Das Backend kürzt auf 200 Zeichen.
export const MAX_NOTE = 200;

/** Getrimmt und auf MAX_NOTE Zeichen (nicht Bytes) begrenzt, damit der Nutzer das Ergebnis vorher sieht. */
export function limitNote(s: string): string {
  return [...s.trim()].slice(0, MAX_NOTE).join("");
}
