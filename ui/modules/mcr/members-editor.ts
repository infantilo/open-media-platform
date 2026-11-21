// Mitglieder und Rollen eines Events (106.14): Person oder Gruppe + Rolle. Nur mit dem Recht „Mitglieder eintragen“ sichtbar.
import { apiFetch, t } from "../host.ts";
import { h, input, note, select } from "./mcr-dom.ts";

export interface Member { subjectType: "user" | "group"; subject: string; role: string }
export const ROLES = ["lead", "engineer", "commentator", "viewer"] as const;

/** Rolle → Kurzbeschreibung-Schlüssel. */
export const roleKey = (r: string) => `mcr.role.${r}`;

/** Doppelte Einträge (gleiche Person/Gruppe) werden zusammengefasst: die stärkere Rolle gewinnt; leere fallen weg. */
export function normalizeMembers(list: Member[]): Member[] {
  const rank: Record<string, number> = { lead: 4, engineer: 3, viewer: 2, commentator: 1 };
  const best = new Map<string, Member>();
  for (const m of list) {
    const subject = m.subject.trim();
    if (!subject) continue;
    const k = `${m.subjectType}\0${subject}`;
    const cur = best.get(k);
    if (!cur || (rank[m.role] ?? 0) > (rank[cur.role] ?? 0)) best.set(k, { ...m, subject });
  }
  return [...best.values()];
}

async function names(url: string, pick: (x: Record<string, unknown>) => string): Promise<string[]> {
  try {
    const r = await apiFetch(url);
    if (!r.ok) return [];
    const d = await r.json();
    const arr = Array.isArray(d) ? d : (d.users ?? d.groups ?? []);
    return (arr as Record<string, unknown>[]).map(pick).filter(Boolean);
  } catch {
    return [];
  }
}

export function membersEditor(initial: Member[]): { el: HTMLElement; read: () => Member[] } {
  let rows: Member[] = initial.map((m) => ({ ...m }));
  const box = h("div", { class: "mcr-chain-params" });
  const users = h("datalist", { id: `mcr-users-${Math.random().toString(36).slice(2, 7)}` });
  const groups = h("datalist", { id: `mcr-groups-${Math.random().toString(36).slice(2, 7)}` });
  void names("/api/v1/auth/users", (u) => String(u.username ?? u.name ?? "")).then((l) => users.replaceChildren(...l.map((n) => h("option", { value: n }))));
  void names("/api/v1/groups", (g) => String(g.id ?? "")).then((l) => groups.replaceChildren(...l.map((n) => h("option", { value: n }))));
  const draw = () => {
    box.replaceChildren(...rows.map((m, i) => {
      const type = select([{ value: "user", label: t("mcr.members.user") }, { value: "group", label: t("mcr.members.group") }], m.subjectType);
      const who = input(m.subject, { placeholder: t("mcr.members.who") });
      who.setAttribute("list", (m.subjectType === "group" ? groups : users).id);
      type.addEventListener("change", () => {
        m.subjectType = type.value as "user" | "group";
        who.setAttribute("list", (m.subjectType === "group" ? groups : users).id);
      });
      who.addEventListener("input", () => (m.subject = who.value));
      const role = select(ROLES.map((r) => ({ value: r, label: t(roleKey(r)) })), m.role);
      role.addEventListener("change", () => (m.role = role.value));
      const del = h("button", { type: "button", class: "mcr-btn mcr-btn-sm mcr-btn-quiet", "aria-label": t("mcr.chain.remove") }, "✕");
      del.addEventListener("click", () => {
        rows.splice(i, 1);
        draw();
      });
      return h("div", { class: "mcr-members-row" }, type, who, role, del);
    }));
    const add = h("button", { type: "button", class: "mcr-btn mcr-btn-sm" }, `+ ${t("mcr.members.add")}`);
    add.addEventListener("click", () => {
      rows.push({ subjectType: "user", subject: "", role: "viewer" });
      draw();
    });
    box.append(h("div", { class: "mcr-quick" }, add));
  };
  draw();
  const el = h("div", { class: "mcr-form" }, note(t("mcr.members.hint")), box, users, groups);
  return { el, read: () => normalizeMembers(rows) };
}
