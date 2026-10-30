// Administration → Plattform → QC-Profile: Profile der Eingangsprüfung anlegen, ändern, kopieren, löschen und zum Standard machen.
// Die Ansicht ändert je Profil (PUT/DELETE /qc-profiles/…) — nicht das ganze Einstellungsdokument.
import { confirmDialog, showToast, t as tt } from "../host.ts";
import { call, errText } from "./api.ts";
import { el } from "./form-kit.ts";
import { buildProfileEditor } from "./qc-profile-form.ts";
import { canSaveProfile, cloneProfile, describeExpect, describeLoudness, newProfileId, type QcProfile } from "./qc-profiles-logic.ts";

interface ProfilesDto {
  default: string;
  profiles: QcProfile[];
  template: QcProfile;
}

const BTN = "padding:3px 10px;cursor:pointer;";

class QcProfilesView extends HTMLElement {
  #data: ProfilesDto | null = null;
  #error = "";

  connectedCallback() {
    this.style.cssText = "display:block;";
    void this.#load();
  }

  async #load() {
    const r = await call<ProfilesDto>("GET", "/qc-profiles");
    if (r.ok) {
      this.#data = r.data;
      this.#error = "";
    } else {
      this.#error = errText(r.data as unknown as Record<string, unknown>) || tt("rv.err.generic");
    }
    this.#render();
  }

  #render() {
    this.replaceChildren();
    const head = el("div", "", tt("rv.qp.title"));
    head.className = "omp-h1";
    this.append(head, el("div", "color:var(--omp-text-dim);margin:6px 0 12px;max-width:900px;", tt("rv.qp.intro")));
    if (this.#error) this.append(el("div", "color:var(--omp-error);margin-bottom:10px;white-space:pre-wrap;", this.#error));
    const d = this.#data;
    if (!d) return;

    const bar = el("div", "display:flex;gap:8px;margin-bottom:10px;");
    const add = el("button", BTN, "+ " + tt("rv.qp.new"));
    add.dataset.role = "qc-profile-new";
    add.title = tt("rv.qp.new.hint");
    add.addEventListener("click", () => {
      const p = cloneProfile(d.template, tt("rv.qp.newname"), d.profiles.map((x) => x.id));
      this.#edit(p, true);
    });
    bar.append(add);
    this.append(bar);

    const list = el("div", "display:flex;flex-direction:column;gap:8px;max-width:1000px;");
    list.dataset.role = "qc-profile-list";
    const words = { tracks: tt("rv.qp.tracks"), none: tt("rv.qp.noexpect"), captions: tt("rv.qp.captions") };
    for (const p of d.profiles) {
      const isDefault = p.id === d.default;
      const card = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:8px 12px;display:grid;grid-template-columns:1fr auto;gap:4px 12px;align-items:center;");
      card.dataset.qcProfile = p.id;
      const title = el("div", "display:flex;align-items:center;gap:8px;flex-wrap:wrap;");
      title.append(el("b", "", p.name || p.id), el("code", "font-size:11px;color:var(--omp-text-dim);", `${p.id}@${p.version}`));
      if (isDefault) {
        const b = el("span", "font-size:10px;padding:1px 6px;border-radius:8px;background:var(--omp-info,#4285f4);color:#fff;", tt("rv.qp.default"));
        b.dataset.role = "qc-profile-default";
        title.append(b);
      }
      const facts = el("div", "grid-column:1;font-size:12px;color:var(--omp-text-dim);");
      const loud = describeLoudness(p);
      facts.textContent = [describeExpect(p, words), loud ? `${tt("rv.qp.loud")}: ${loud}` : tt("rv.qp.noloud")].join("  ·  ");
      const btns = el("div", "display:flex;gap:6px;grid-column:2;grid-row:1 / span 2;align-self:center;flex-wrap:wrap;justify-content:flex-end;");
      const edit = el("button", BTN, tt("rv.qp.edit"));
      edit.dataset.role = "qc-profile-edit";
      edit.addEventListener("click", () => this.#edit(JSON.parse(JSON.stringify(p)) as QcProfile, false));
      const dup = el("button", BTN, tt("rv.cfg.p.dup"));
      dup.dataset.role = "qc-profile-dup";
      dup.addEventListener("click", () => this.#edit(cloneProfile(p, `${p.name || p.id} (${tt("rv.cfg.p.copy")})`, d.profiles.map((x) => x.id)), true));
      const mk = el("button", BTN, tt("rv.qp.makedefault"));
      mk.dataset.role = "qc-profile-makedefault";
      mk.disabled = isDefault;
      mk.addEventListener("click", async () => {
        const r = await call("POST", "/qc-profiles/default", { id: p.id });
        if (!r.ok) showToast(errText(r.data) || tt("rv.err.generic"));
        else showToast(tt("rv.qp.defaultset", { p0: p.name || p.id }));
        await this.#load();
      });
      const del = el("button", BTN, tt("rv.cfg.remove"));
      del.dataset.role = "qc-profile-delete";
      del.disabled = isDefault || d.profiles.length <= 1;
      del.title = isDefault ? tt("rv.qp.del.default") : "";
      del.addEventListener("click", async () => {
        if (!(await confirmDialog(tt("rv.cfg.p.remove.q", { p0: p.name || p.id })))) return;
        const r = await call("DELETE", `/qc-profiles/${encodeURIComponent(p.id)}`);
        if (!r.ok) showToast(errText(r.data) || tt("rv.err.generic"));
        await this.#load();
      });
      btns.append(edit, dup, mk, del);
      card.append(title, btns, facts);
      list.append(card);
    }
    this.append(list);
  }

  /** Editor als Dialog. `isNew`: Kennung wählbar (folgt dem Namen, bis sie von Hand geändert wird). */
  #edit(p: QcProfile, isNew: boolean) {
    const existing = this.#data?.profiles.map((x) => x.id) ?? [];
    const overlay = el("div");
    overlay.className = "omp-modal-overlay";
    overlay.style.zIndex = "3000";
    const m = el("div", "max-width:860px;max-height:92vh;overflow:auto;");
    m.className = "omp-modal";
    m.dataset.role = "qc-profile-editor";
    const h = el("div", "margin-bottom:6px;", isNew ? tt("rv.qp.editor.new") : tt("rv.qp.editor.edit", { p0: p.name || p.id }));
    h.className = "omp-h1";
    const err = el("div", "color:var(--omp-error);font-size:12px;white-space:pre-line;min-height:16px;");

    const idRow = el("div", "display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:12px;");
    idRow.append(el("span", "color:var(--omp-text-dim);", tt("rv.qp.id")));
    const idIn = el("input", "width:260px;font-family:var(--omp-font-mono);") as HTMLInputElement;
    idIn.value = p.id;
    idIn.dataset.role = "qc-profile-id";
    idIn.disabled = !isNew;
    let idTouched = false;
    idIn.addEventListener("input", () => {
      idTouched = true;
      p.id = idIn.value.trim();
    });
    idRow.append(idIn, el("span", "color:var(--omp-text-dim);", isNew ? tt("rv.qp.id.new") : tt("rv.qp.id.fixed")));

    const form = buildProfileEditor(p);
    // Der Name steht als erstes Feld im Formular; die Kennung folgt ihm, solange sie nicht von Hand geändert wurde.
    const nameIn = form.querySelector("input") as HTMLInputElement | null;
    if (isNew && nameIn) {
      nameIn.addEventListener("input", () => {
        if (idTouched) return;
        p.id = newProfileId(nameIn.value, existing);
        idIn.value = p.id;
      });
    }
    if (!isNew) form.prepend(el("div", "font-size:11px;color:var(--omp-text-dim);", tt("rv.qp.versionnote")));

    const row = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:8px;");
    const cancel = el("button", BTN, tt("rv.cancel"));
    const save = el("button", BTN, tt("rv.save"));
    save.className = "omp-btn-primary";
    save.dataset.role = "qc-profile-save";
    cancel.addEventListener("click", () => overlay.remove());
    save.addEventListener("click", async () => {
      const bad = canSaveProfile(String(p.name ?? ""), p.id, isNew);
      if (bad) {
        err.textContent = tt(bad === "name" ? "rv.qp.err.name" : "rv.qp.err.id");
        return;
      }
      if (isNew && existing.includes(p.id)) {
        err.textContent = tt("rv.qp.err.idtaken", { p0: p.id });
        return;
      }
      err.textContent = "";
      save.disabled = true;
      const r = await call<{ profile: QcProfile; created: boolean }>("PUT", `/qc-profiles/${encodeURIComponent(p.id)}`, p);
      save.disabled = false;
      if (!r.ok) {
        err.textContent = errText(r.data as unknown as Record<string, unknown>) || tt("rv.err.generic");
        return;
      }
      const saved = r.data.profile;
      showToast(r.data.created ? tt("rv.qp.created", { p0: saved.name }) : tt("rv.qp.saved", { p0: saved.name, p1: saved.version }));
      overlay.remove();
      await this.#load();
    });
    row.append(cancel, save);
    m.append(h, idRow, form, err, row);
    overlay.addEventListener("keydown", (e) => e.key === "Escape" && overlay.remove());
    overlay.append(m);
    document.body.append(overlay);
    nameIn?.focus();
  }
}

if (!customElements.get("omp-qc-profiles-view")) customElements.define("omp-qc-profiles-view", QcProfilesView);
