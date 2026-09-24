// <omp-asset-view> — Kapitel 21 Phase 6 Teil 3: UI für die Asset/
// Content-Domäne (Assets/Lifecycle/Metadaten/Versionen/Representations).
// Konsumiert ausschließlich die in Kapitel 21 Phase 5 Teil 3 gebaute
// HTTP-API (/api/v1/assets, /api/v1/asset-versions, /api/v1/
// representations) plus GET /api/v1/asset-lifecycle (erlaubte
// Übergänge direkt aus dem Backend-Zustandsgraphen — die UI bietet nur
// an, was asset.LifecycleTransitions/VersionTransitions auch erlauben,
// ohne den Graphen hier zu duplizieren).
//
// Master-Detail wie process-view.ts, aber mit einem Unterschied im
// Render-Modell: Filterleiste und Modals sind persistent, der 15s-Poll
// rendert nur Liste und Detailbereich neu — sonst verlöre ein Nutzer
// mitten im Tippen (Suche, Metadaten-Formular) Fokus und Eingaben.
import { apiFetch } from "./connection.ts";
import { showToast } from "../kit/omp-toast.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";
import {
  type Asset,
  ASSET_TYPE_SUGGESTIONS,
  type AssetFilter,
  type AssetMetadata,
  type AssetVersion,
  filterAssets,
  type LifecycleGraph,
  METADATA_CATEGORIES,
  type MetadataRows,
  metadataToRows,
  parseOptionalNumber,
  type Representation,
  REPRESENTATION_TYPE_SUGGESTIONS,
  representationSummary,
  rowsToMetadata,
  statusLabel,
  STORAGE_PROVIDER_SUGGESTIONS,
} from "./asset-view-logic.ts";

const POLL_INTERVAL_MS = 15000;

// Collection/AssetRelationship/AssetLink — Wire-Formate identisch zu
// internal/asset.Collection/AssetRelationship bzw. internal/
// assetlinks.Link (Kapitel 21 B12/B10 UI-Anbindung, Nachtrag 284).
// Lokale Deklaration statt eines Imports aus asset-view-logic.ts —
// diese drei brauchen (anders als Asset/AssetVersion/Representation)
// keine geteilte Filter-/Formular-Logik, gleiches Muster wie
// process-view.ts' AssetLink-Deklaration.
interface Collection {
  id: string;
  title: string;
  description?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface AssetRelationship {
  id: string;
  fromAssetId: string;
  toAssetId: string;
  type: string;
  createdBy: string;
  createdAt: string;
}

interface AssetLink {
  id: string;
  processExecutionId: string;
  assetVersionId: string;
  role: string;
  createdAt: string;
}

const RELATIONSHIP_TYPE_SUGGESTIONS = ["derived_from", "version_of", "part_of", "references"];

const STATUS_BADGE: Record<string, string> = {
  ingesting: "omp-badge-cue",
  registered: "omp-badge-cue",
  processing: "omp-badge-cue",
  ready: "omp-badge-info",
  in_review: "omp-badge-info",
  approved: "omp-badge-running",
  published: "omp-badge-running",
  archived: "",
  expired: "omp-badge-error",
  deleted: "omp-badge-error",
};

const VERSION_BADGE: Record<string, string> = {
  draft: "omp-badge-cue",
  published: "omp-badge-running",
  archived: "",
};

const VERSION_ACTION_LABEL: Record<string, { label: string; path: string }> = {
  published: { label: "Veröffentlichen", path: "publish" },
  archived: { label: "Archivieren", path: "archive" },
};

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function fmtTime(iso: string | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString();
}

function badge(text: string, cls: string): string {
  return `<span class="omp-badge ${cls}">${escapeHtml(text)}</span>`;
}

function fmtValue(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

// Einmalig je Dokument angelegte <datalist>-Vorschläge für die freien
// Typ-Felder (Backend: TEXT ohne Enum) — ids sind dokumentweit.
function ensureDatalist(id: string, values: string[]) {
  if (document.getElementById(id)) return;
  const dl = document.createElement("datalist");
  dl.id = id;
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    dl.appendChild(opt);
  }
  document.body.appendChild(dl);
}

class AssetView extends HTMLElement {
  #assets: Asset[] = [];
  #lifecycle: LifecycleGraph = { asset: {}, version: {} };
  #selectedId: string | null = null;
  #versions: AssetVersion[] = [];
  #selectedVersionId: string | null = null;
  #reps: Representation[] = [];
  #relationships: AssetRelationship[] = [];
  #versionLinks: AssetLink[] = [];
  #filter: AssetFilter = { query: "", type: "", status: "", showDeleted: false };
  // Volltextsuche (B11, Kapitel 21 Teil B, Nachtrag 284) — null = keine
  // Suche aktiv (Liste zeigt #assets client-gefiltert wie bisher,
  // unverändertes Verhalten). Nicht-null = Ergebnis von GET /api/v1/
  // assets/search, bereits nach Relevanz sortiert; #filter.query wird
  // dann NICHT mehr zusätzlich client-seitig angewendet (s. #renderList),
  // Typ/Status/"Gelöschte anzeigen" bleiben on top wirksam.
  #searchResults: Asset[] | null = null;
  #searchDebounce: number | undefined;

  // Collections (Kapitel 21 B12 UI-Anbindung, Nachtrag 284) — geteilte
  // Ansicht mit Assets statt eines eigenen Tabs: #viewMode schaltet
  // Liste UND Detailbereich um, #listEl/#detailEl bleiben dieselben
  // Container (kein zweiter #build()-Zweig nötig).
  #viewMode: "assets" | "collections" = "assets";
  #collections: Collection[] = [];
  #selectedCollectionId: string | null = null;
  #collectionMembers: Asset[] = [];
  #showCollectionForm = false;
  #editingCollection: Collection | null = null;

  #listEl!: HTMLElement;
  #detailEl!: HTMLElement;
  #countEl!: HTMLElement;
  #typeSelect!: HTMLSelectElement;
  #statusSelect!: HTMLSelectElement;
  #filterBarEl!: HTMLElement;
  #assetsModeBtn!: HTMLButtonElement;
  #collectionsModeBtn!: HTMLButtonElement;
  #newBtn!: HTMLButtonElement;
  #modal: HTMLElement | null = null;
  #pollHandle: number | undefined;
  #built = false;

  connectedCallback() {
    this.style.cssText =
      "display:block;background:var(--omp-bg);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow:hidden;";
    if (!this.#built) this.#build();
    void this.#loadLifecycle().then(() => this.#refresh());
    this.#pollHandle = window.setInterval(() => void this.#refresh(), POLL_INTERVAL_MS);
  }

  disconnectedCallback() {
    if (this.#pollHandle !== undefined) window.clearInterval(this.#pollHandle);
  }

  // ---- Laden -----------------------------------------------------------------------------------

  async #loadLifecycle() {
    try {
      const res = await apiFetch("/api/v1/asset-lifecycle");
      if (res.ok) this.#lifecycle = await res.json();
    } catch {
      // ohne Graph werden schlicht keine Übergangs-Buttons angeboten
    }
  }

  async #refresh() {
    try {
      const res = await apiFetch("/api/v1/assets");
      if (res.ok) this.#assets = (await res.json()) ?? [];
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll holt es auf.
    }
    try {
      const res = await apiFetch("/api/v1/collections");
      if (res.ok) this.#collections = (await res.json()) ?? [];
    } catch {
      // s.o.
    }
    if (this.#selectedId) await this.#loadDetail(this.#selectedId);
    if (this.#selectedCollectionId) await this.#loadCollectionMembers(this.#selectedCollectionId);
    this.#renderList();
    this.#renderDetail();
  }

  // B11 — echte Postgres-Volltextsuche statt reinem Client-Substring
  // (asset-view-logic.ts filterAssets bleibt als Vorfilter/Typ-Status-
  // Filter bestehen, s. #renderList). Verwirft ein verspätet
  // eintreffendes Ergebnis, falls der Suchtext sich zwischenzeitlich
  // schon wieder geändert hat (kein Aufblitzen veralteter Treffer).
  async #runSearch(q: string) {
    try {
      const res = await apiFetch(`/api/v1/assets/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) return;
      const results: Asset[] = (await res.json()) ?? [];
      if (this.#filter.query.trim() !== q) return;
      this.#searchResults = results;
      this.#renderList();
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — der Client-Substring-
      // Vorfilter bleibt sichtbar, nächste Eingabe versucht es erneut.
    }
  }

  async #loadDetail(assetId: string) {
    try {
      const res = await apiFetch(`/api/v1/assets/${assetId}/versions`);
      this.#versions = res.ok ? (await res.json()) ?? [] : [];
    } catch {
      return;
    }
    try {
      const res = await apiFetch(`/api/v1/assets/${assetId}/relationships`);
      this.#relationships = res.ok ? (await res.json()) ?? [] : [];
    } catch {
      // s.o.
    }
    // Ausgewählte Version halten, sonst aktuelle (veröffentlichte),
    // sonst neueste — damit Representations sofort sichtbar sind.
    if (!this.#versions.some((v) => v.id === this.#selectedVersionId)) {
      const asset = this.#assets.find((a) => a.id === assetId);
      const newest = [...this.#versions].sort((a, b) => b.versionNumber - a.versionNumber)[0];
      this.#selectedVersionId = asset?.currentVersionId ?? newest?.id ?? null;
    }
    if (this.#selectedVersionId) {
      try {
        const res = await apiFetch(`/api/v1/asset-versions/${this.#selectedVersionId}/representations`);
        this.#reps = res.ok ? (await res.json()) ?? [] : [];
      } catch {
        // s.o.
      }
      try {
        const res = await apiFetch(`/api/v1/asset-versions/${this.#selectedVersionId}/links`);
        this.#versionLinks = res.ok ? (await res.json()) ?? [] : [];
      } catch {
        // s.o.
      }
    } else {
      this.#reps = [];
      this.#versionLinks = [];
    }
  }

  async #loadCollections() {
    try {
      const res = await apiFetch("/api/v1/collections");
      if (res.ok) this.#collections = (await res.json()) ?? [];
      this.#renderList();
    } catch {
      // s.o.
    }
  }

  // Mitglieder als volle Asset-Objekte statt nur IDs (Backend liefert
  // bewusst nur IDs, s. handleListCollectionMembers-Doku) — #assets ist
  // bereits vollständig geladen (kein Filter server-seitig), ein Lookup
  // reicht, kein zweiter Roundtrip pro Mitglied nötig.
  async #loadCollectionMembers(collectionId: string) {
    try {
      const res = await apiFetch(`/api/v1/collections/${collectionId}/members`);
      const ids: string[] = res.ok ? ((await res.json()) ?? []) : [];
      this.#collectionMembers = ids.map((id) => this.#assets.find((a) => a.id === id)).filter((a): a is Asset => !!a);
    } catch {
      // s.o.
    }
  }

  async #select(id: string) {
    this.#selectedId = id;
    this.#selectedVersionId = null;
    this.#versions = [];
    this.#reps = [];
    this.#relationships = [];
    this.#versionLinks = [];
    this.#renderList();
    this.#renderDetail();
    // Volle Aktualisierung statt nur Detail: die Liste liefert auch die
    // rowVersion für CAS — sonst arbeitete ein Klick bis zum nächsten
    // Poll mit einem evtl. veralteten Stand.
    await this.#refresh();
  }

  async #selectVersion(id: string) {
    this.#selectedVersionId = id;
    if (this.#selectedId) await this.#loadDetail(this.#selectedId);
    this.#renderDetail();
  }

  // Fehlertext einer API-Antwort nutzerlesbar machen — 409 heißt hier
  // fast immer "jemand anderes war schneller" (CAS über rowVersion) oder
  // "Übergang/Änderung nicht erlaubt" (Zustandsgraph/B3).
  // Liefert true bei einem CAS-Konflikt (Aufrufer mit offenem Formular
  // schließt es dann: dessen rowVersion ist veraltet, ein erneutes
  // Speichern daraus scheiterte endlos bzw. dürfte fremde Änderungen
  // nicht überschreiben — der Nutzer öffnet es mit frischen Daten neu).
  async #reportError(what: string, res: Response): Promise<boolean> {
    const text = (await res.text()).trim();
    const conflict = res.status === 409 && text.includes("concurrent modification");
    if (conflict) {
      showToast(`${what}: das Asset wurde zwischenzeitlich geändert — Ansicht neu geladen, bitte erneut versuchen.`, {
        variant: "error",
      });
    } else if (res.status === 409 && text.includes("not a draft")) {
      showToast(`${what}: diese Version ist nicht mehr im Entwurf und damit unveränderlich — bitte eine neue Version anlegen.`, {
        variant: "error",
      });
    } else if (res.status === 403) {
      showToast(`${what}: keine Berechtigung.`, { variant: "error" });
    } else {
      showToast(`${what} fehlgeschlagen: ${text || res.status}`, { variant: "error" });
    }
    await this.#refresh();
    return conflict;
  }

  // ---- Mutationen ------------------------------------------------------------------------------

  async #createAsset(type: string, title: string, description: string): Promise<boolean> {
    const res = await apiFetch("/api/v1/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, title, description }),
    });
    if (!res.ok) {
      await this.#reportError("Anlegen", res);
      return false;
    }
    const created = (await res.json()) as Asset;
    showToast(`Asset „${created.title}“ angelegt.`, { variant: "info" });
    await this.#refresh();
    await this.#select(created.id);
    return true;
  }

  async #changeStatus(asset: Asset, to: string) {
    if (to === "deleted") {
      const ok = await confirmDialog(
        `Asset „${asset.title}“ als gelöscht markieren? Das ist ein Endzustand — er lässt sich nicht rückgängig machen.`,
        { confirmLabel: "Löschen" },
      );
      if (!ok) return;
    }
    const res = await apiFetch(`/api/v1/assets/${asset.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRowVersion: asset.rowVersion, status: to }),
    });
    if (!res.ok) {
      await this.#reportError("Statuswechsel", res);
      return;
    }
    showToast(`Status: ${statusLabel(to)}`, { variant: "info" });
    await this.#refresh();
  }

  async #saveMetadata(asset: Asset, metadata: AssetMetadata): Promise<boolean> {
    const res = await apiFetch(`/api/v1/assets/${asset.id}/metadata`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRowVersion: asset.rowVersion, metadata }),
    });
    if (!res.ok) return await this.#reportError("Metadaten speichern", res);
    showToast("Metadaten gespeichert.", { variant: "info" });
    await this.#refresh();
    return true;
  }

  async #createVersion(assetId: string, parentVersionId: string, changeReason: string): Promise<boolean> {
    const res = await apiFetch(`/api/v1/assets/${assetId}/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentVersionId, changeReason }),
    });
    if (!res.ok) {
      await this.#reportError("Version anlegen", res);
      return false;
    }
    const v = (await res.json()) as AssetVersion;
    this.#selectedVersionId = v.id;
    showToast(`Version v${v.versionNumber} angelegt (Entwurf).`, { variant: "info" });
    await this.#refresh();
    return true;
  }

  async #versionAction(v: AssetVersion, to: string) {
    const action = VERSION_ACTION_LABEL[to];
    if (!action) return;
    if (to === "published") {
      const ok = await confirmDialog(
        `v${v.versionNumber} veröffentlichen? Danach ist die Version unveränderlich und wird zur aktuellen Version des Assets.`,
        { confirmLabel: "Veröffentlichen" },
      );
      if (!ok) return;
    }
    const res = await apiFetch(`/api/v1/asset-versions/${v.id}/${action.path}`, { method: "POST" });
    if (!res.ok) {
      await this.#reportError(action.label, res);
      return;
    }
    showToast(`v${v.versionNumber}: ${action.label} erledigt.`, { variant: "info" });
    await this.#refresh();
  }

  async #createRepresentation(versionId: string, rep: Partial<Representation>): Promise<boolean> {
    const res = await apiFetch(`/api/v1/asset-versions/${versionId}/representations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rep),
    });
    if (!res.ok) {
      await this.#reportError("Representation anlegen", res);
      return false;
    }
    showToast("Representation angelegt.", { variant: "info" });
    await this.#refresh();
    return true;
  }

  async #deleteRepresentation(rep: Representation) {
    const ok = await confirmDialog(`Representation „${rep.type}“ (${rep.storage.uri}) entfernen?`, {
      confirmLabel: "Entfernen",
    });
    if (!ok) return;
    const res = await apiFetch(`/api/v1/representations/${rep.id}`, { method: "DELETE" });
    if (!res.ok) {
      await this.#reportError("Representation entfernen", res);
      return;
    }
    await this.#refresh();
  }

  // ---- Collections (B12) ------------------------------------------------------------------------

  async #selectCollection(id: string) {
    this.#selectedCollectionId = id;
    this.#collectionMembers = [];
    this.#renderList();
    this.#renderDetail();
    await this.#loadCollectionMembers(id);
    this.#renderDetail();
  }

  async #createCollection(title: string, description: string): Promise<boolean> {
    const res = await apiFetch("/api/v1/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description }),
    });
    if (!res.ok) {
      showToast(`Collection anlegen fehlgeschlagen: ${await res.text()}`, { variant: "error" });
      return false;
    }
    const created = (await res.json()) as Collection;
    await this.#loadCollections();
    this.#selectedCollectionId = created.id;
    this.#renderList();
    this.#renderDetail();
    showToast(`Collection „${created.title}“ angelegt.`, { variant: "info" });
    return true;
  }

  async #updateCollection(collection: Collection, title: string, description: string): Promise<boolean> {
    const res = await apiFetch(`/api/v1/collections/${collection.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description }),
    });
    if (!res.ok) {
      showToast(`Speichern fehlgeschlagen: ${await res.text()}`, { variant: "error" });
      return false;
    }
    await this.#loadCollections();
    this.#renderList();
    this.#renderDetail();
    showToast("Collection aktualisiert.", { variant: "info" });
    return true;
  }

  async #deleteCollection(collection: Collection) {
    const ok = await confirmDialog(`Collection „${collection.title}“ löschen? Die enthaltenen Assets bleiben unverändert erhalten.`, {
      confirmLabel: "Löschen",
    });
    if (!ok) return;
    const res = await apiFetch(`/api/v1/collections/${collection.id}`, { method: "DELETE" });
    if (!res.ok) {
      showToast(`Löschen fehlgeschlagen: ${await res.text()}`, { variant: "error" });
      return;
    }
    if (this.#selectedCollectionId === collection.id) this.#selectedCollectionId = null;
    await this.#loadCollections();
    this.#renderList();
    this.#renderDetail();
  }

  async #addCollectionMember(collectionId: string, assetId: string) {
    const res = await apiFetch(`/api/v1/collections/${collectionId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetId }),
    });
    if (!res.ok) {
      showToast(`Hinzufügen fehlgeschlagen: ${await res.text()}`, { variant: "error" });
      return;
    }
    await this.#loadCollectionMembers(collectionId);
    this.#renderDetail();
  }

  async #removeCollectionMember(collectionId: string, assetId: string) {
    const res = await apiFetch(`/api/v1/collections/${collectionId}/members/${assetId}`, { method: "DELETE" });
    if (!res.ok) {
      showToast(`Entfernen fehlgeschlagen: ${await res.text()}`, { variant: "error" });
      return;
    }
    await this.#loadCollectionMembers(collectionId);
    this.#renderDetail();
  }

  // ---- Beziehungen (B12) ------------------------------------------------------------------------

  async #createRelationship(fromAssetId: string, toAssetId: string, type: string): Promise<boolean> {
    const res = await apiFetch("/api/v1/asset-relationships", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromAssetId, toAssetId, type }),
    });
    if (!res.ok) {
      showToast(`Beziehung anlegen fehlgeschlagen: ${await res.text()}`, { variant: "error" });
      return false;
    }
    showToast("Beziehung angelegt.", { variant: "info" });
    await this.#refresh();
    return true;
  }

  async #deleteRelationship(rel: AssetRelationship) {
    const ok = await confirmDialog("Diese Beziehung entfernen?", { confirmLabel: "Entfernen" });
    if (!ok) return;
    const res = await apiFetch(`/api/v1/asset-relationships/${rel.id}`, { method: "DELETE" });
    if (!res.ok) {
      showToast(`Entfernen fehlgeschlagen: ${await res.text()}`, { variant: "error" });
      return;
    }
    await this.#refresh();
  }

  // ---- Asset-Links / verknüpfte Prozessläufe (B10) -----------------------------------------------
  // Anlegen passiert bewusst NICHT hier — process-view.ts' Execution-
  // Detail ist der natürliche Ort dafür (dort ist die Execution bereits
  // ausgewählt, hier müsste man sie erst suchen), s. dortige
  // #renderAssetLinksSection-Doku. Diese Ansicht zeigt nur, entfernt
  // aber auch (harmlos, DELETE ist idempotent/eigenständig).
  async #deleteAssetLink(link: AssetLink) {
    const res = await apiFetch(`/api/v1/asset-links/${link.id}`, { method: "DELETE" });
    if (!res.ok) {
      showToast(`Entfernen fehlgeschlagen: ${await res.text()}`, { variant: "error" });
      return;
    }
    await this.#refresh();
  }

  // ---- Grundgerüst (einmalig) ------------------------------------------------------------------

  #build() {
    this.#built = true;
    const layout = document.createElement("div");
    layout.style.cssText = "display:grid;grid-template-columns:300px 1fr;gap:var(--omp-space-3);height:100%;";

    const left = document.createElement("div");
    left.style.cssText = "display:flex;flex-direction:column;gap:var(--omp-space-2);min-height:0;";

    left.appendChild(this.#buildModeToggle());

    const heading = document.createElement("div");
    heading.style.cssText = "display:flex;justify-content:space-between;align-items:center;";
    this.#countEl = document.createElement("span");
    this.#countEl.className = "omp-h1";
    this.#newBtn = document.createElement("button");
    this.#newBtn.className = "omp-btn-primary";
    this.#newBtn.textContent = "+ Neu";
    this.#newBtn.setAttribute("data-role", "asset-new");
    this.#newBtn.addEventListener("click", () => {
      if (this.#viewMode === "assets") this.#openCreateModal();
      else this.#openCollectionModal(null);
    });
    heading.append(this.#countEl, this.#newBtn);
    left.appendChild(heading);
    this.#filterBarEl = this.#buildFilterBar();
    left.appendChild(this.#filterBarEl);

    this.#listEl = document.createElement("div");
    this.#listEl.style.cssText = "display:flex;flex-direction:column;gap:var(--omp-space-2);min-height:0;overflow-y:auto;";
    left.appendChild(this.#listEl);

    this.#detailEl = document.createElement("div");
    this.#detailEl.style.cssText = "display:flex;flex-direction:column;gap:var(--omp-space-3);min-height:0;overflow-y:auto;";

    layout.append(left, this.#detailEl);
    this.appendChild(layout);
    this.#applyViewModeStyles();
  }

  // Umschalter Assets/Collections — zwei persistente Buttons (kein
  // Rebuild bei jedem Klick, gleiches Rechtfertigungs-Muster wie
  // #listEl/#detailEl: nur Textfelder brauchen Fokus-Stabilität, Buttons
  // nicht, aber eine feste Referenz hält den Code hier einfacher als ein
  // vollständiger Sub-Tab-Bar-Rebuild wie in admin-view.ts).
  #buildModeToggle(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;border:1px solid var(--omp-border);border-radius:var(--omp-radius);overflow:hidden;";
    this.#assetsModeBtn = document.createElement("button");
    this.#assetsModeBtn.type = "button";
    this.#assetsModeBtn.textContent = "Assets";
    this.#collectionsModeBtn = document.createElement("button");
    this.#collectionsModeBtn.type = "button";
    this.#collectionsModeBtn.textContent = "Collections";
    this.#assetsModeBtn.addEventListener("click", () => this.#setViewMode("assets"));
    this.#collectionsModeBtn.addEventListener("click", () => this.#setViewMode("collections"));
    wrap.append(this.#assetsModeBtn, this.#collectionsModeBtn);
    // #applyViewModeStyles() NICHT hier aufrufen — sie liest #filterBarEl/
    // #newBtn, die erst später in #build() zugewiesen werden (echter
    // Bug live gefunden: "Cannot read properties of undefined" beim
    // ersten Öffnen des Assets-Tabs). #build() ruft sie stattdessen
    // einmal ganz am Ende auf, wenn alle Felder gesetzt sind.
    return wrap;
  }

  #applyViewModeStyles() {
    const base = "flex:1;border:none;padding:6px 8px;font-family:var(--omp-font);font-size:var(--omp-font-size-sm);cursor:pointer;";
    const active = "background:var(--omp-surface-raised);color:var(--omp-text);font-weight:600;";
    const inactive = "background:transparent;color:var(--omp-text-dim);";
    this.#assetsModeBtn.style.cssText = base + (this.#viewMode === "assets" ? active : inactive);
    this.#collectionsModeBtn.style.cssText = base + (this.#viewMode === "collections" ? active : inactive);
    this.#filterBarEl.style.display = this.#viewMode === "assets" ? "" : "none";
    this.#newBtn.textContent = this.#viewMode === "assets" ? "+ Neu" : "+ Neue Collection";
  }

  #setViewMode(mode: "assets" | "collections") {
    if (this.#viewMode === mode) return;
    this.#viewMode = mode;
    this.#selectedId = null;
    this.#selectedCollectionId = null;
    this.#applyViewModeStyles();
    if (mode === "collections" && this.#collections.length === 0) void this.#loadCollections();
    this.#renderList();
    this.#renderDetail();
  }

  #buildFilterBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;flex-direction:column;gap:4px;";

    const searchWrap = document.createElement("span");
    searchWrap.className = "omp-search-wrap";
    searchWrap.style.cssText = "display:block;";
    const search = document.createElement("input");
    search.className = "omp-search-input";
    search.type = "search";
    search.placeholder = "Suche (Titel, Beschreibung, Typ, Metadaten) …";
    search.style.cssText = "width:100%;box-sizing:border-box;";
    search.addEventListener("input", () => {
      this.#filter.query = search.value;
      // Sofortiges Feedback aus dem bereits geladenen #assets (client-
      // seitiger Substring-Vorfilter, wie bisher), dann — nach kurzer
      // Verzögerung gegen einen Request pro Tastendruck — die echte
      // Volltextsuche (B11), die deren Ergebnis ersetzt (Relevanz-
      // Ranking + Metadaten-Treffer, die die reine Substring-Suche nie
      // finden konnte).
      this.#searchResults = null;
      this.#renderList();
      if (this.#searchDebounce !== undefined) window.clearTimeout(this.#searchDebounce);
      const q = search.value.trim();
      if (!q) return;
      this.#searchDebounce = window.setTimeout(() => void this.#runSearch(q), 250);
    });
    searchWrap.appendChild(search);
    bar.appendChild(searchWrap);

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:4px;";
    this.#typeSelect = document.createElement("select");
    this.#typeSelect.style.cssText = "flex:1;min-width:0;";
    this.#typeSelect.addEventListener("change", () => {
      this.#filter.type = this.#typeSelect.value;
      this.#renderList();
    });
    this.#statusSelect = document.createElement("select");
    this.#statusSelect.style.cssText = "flex:1;min-width:0;";
    this.#statusSelect.addEventListener("change", () => {
      this.#filter.status = this.#statusSelect.value;
      this.#renderList();
    });
    row.append(this.#typeSelect, this.#statusSelect);
    bar.appendChild(row);

    const delLabel = document.createElement("label");
    delLabel.style.cssText = "display:flex;align-items:center;gap:4px;color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";
    const delCb = document.createElement("input");
    delCb.type = "checkbox";
    delCb.addEventListener("change", () => {
      this.#filter.showDeleted = delCb.checked;
      this.#renderList();
    });
    delLabel.append(delCb, document.createTextNode("Gelöschte anzeigen"));
    bar.appendChild(delLabel);
    return bar;
  }

  // Optionen der Typ-/Status-Auswahl aus den geladenen Daten bzw. dem
  // Zustandsgraphen ableiten — ein gewählter Wert bleibt erhalten, auch
  // wenn er gerade in keinem Asset mehr vorkommt.
  #syncFilterOptions() {
    const fill = (sel: HTMLSelectElement, allLabel: string, values: [string, string][]) => {
      const current = sel.value;
      sel.replaceChildren();
      const all = document.createElement("option");
      all.value = "";
      all.textContent = allLabel;
      sel.appendChild(all);
      for (const [value, label] of values) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        sel.appendChild(opt);
      }
      sel.value = values.some(([v]) => v === current) ? current : "";
    };
    const types = new Set(this.#assets.map((a) => a.type));
    if (this.#filter.type) types.add(this.#filter.type);
    fill(this.#typeSelect, "Alle Typen", [...types].sort().map((t) => [t, t]));

    const statuses = new Set<string>(Object.keys(this.#lifecycle.asset));
    for (const tos of Object.values(this.#lifecycle.asset)) for (const s of tos) statuses.add(s);
    for (const a of this.#assets) statuses.add(a.status);
    const order = ["ingesting", "registered", "processing", "ready", "in_review", "approved", "published", "archived", "expired", "deleted"];
    const sorted = [...statuses].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    fill(this.#statusSelect, "Alle Status", sorted.map((s) => [s, statusLabel(s)]));
  }

  // ---- Liste -----------------------------------------------------------------------------------

  #renderList() {
    if (this.#viewMode === "collections") {
      this.#renderCollectionList();
      return;
    }
    this.#syncFilterOptions();
    // #searchResults != null: die echte Volltextsuche (B11) hat bereits
    // nach Relevanz gefiltert/sortiert — #filter.query hier NICHT noch
    // einmal per Substring anwenden (Ranking-Reihenfolge bliebe erhalten,
    // Typ/Status/showDeleted bleiben als zusätzliche UND-Kriterien aktiv).
    const source = this.#searchResults ?? this.#assets;
    const visible = filterAssets(source, this.#searchResults ? { ...this.#filter, query: "" } : this.#filter);
    this.#countEl.textContent = visible.length === this.#assets.length
      ? `Assets (${this.#assets.length})`
      : `Assets (${visible.length} von ${this.#assets.length})`;
    this.#listEl.replaceChildren();

    if (this.#assets.length === 0) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Noch kein Asset angelegt.";
      this.#listEl.appendChild(empty);
      return;
    }
    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Kein Asset passt zum Filter.";
      this.#listEl.appendChild(empty);
      return;
    }

    for (const a of visible) {
      const card = document.createElement("div");
      card.className = "omp-card-compact";
      card.setAttribute("data-asset-id", a.id);
      card.style.cssText = "cursor:pointer;" + (a.id === this.#selectedId ? "border-color:var(--omp-info);" : "");
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:6px;align-items:baseline;">
          <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(a.title)}</span>
          ${badge(statusLabel(a.status), STATUS_BADGE[a.status] ?? "")}
        </div>
        <div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);">${escapeHtml(a.type)} · ${fmtTime(a.updatedAt)}</div>
      `;
      card.addEventListener("click", () => void this.#select(a.id));
      this.#listEl.appendChild(card);
    }
  }

  #renderCollectionList() {
    this.#countEl.textContent = `Collections (${this.#collections.length})`;
    this.#listEl.replaceChildren();

    if (this.#collections.length === 0) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = 'Noch keine Collection angelegt — mit „+ Neue Collection" die erste anlegen.';
      this.#listEl.appendChild(empty);
      return;
    }

    for (const c of this.#collections) {
      const card = document.createElement("div");
      card.className = "omp-card-compact";
      card.style.cssText = "cursor:pointer;" + (c.id === this.#selectedCollectionId ? "border-color:var(--omp-info);" : "");
      card.innerHTML = `
        <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(c.title)}</div>
        ${c.description ? `<div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-top:2px;">${escapeHtml(c.description)}</div>` : ""}
      `;
      card.addEventListener("click", () => void this.#selectCollection(c.id));
      this.#listEl.appendChild(card);
    }
  }

  // ---- Detail ----------------------------------------------------------------------------------

  #renderDetail() {
    if (this.#viewMode === "collections") {
      this.#renderCollectionDetail();
      return;
    }
    this.#detailEl.replaceChildren();
    const asset = this.#assets.find((a) => a.id === this.#selectedId);
    if (!asset) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Links ein Asset auswählen oder mit „+ Neu“ anlegen.";
      this.#detailEl.appendChild(empty);
      return;
    }
    this.#detailEl.append(
      this.#renderHeader(asset),
      this.#renderMetadata(asset),
      this.#renderVersions(asset),
      this.#renderRepresentations(),
      this.#renderVersionLinks(),
      this.#renderRelationships(asset),
    );
  }

  #renderCollectionDetail() {
    this.#detailEl.replaceChildren();
    const collection = this.#collections.find((c) => c.id === this.#selectedCollectionId);
    if (!collection) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = 'Links eine Collection auswählen oder mit „+ Neue Collection" anlegen.';
      this.#detailEl.appendChild(empty);
      return;
    }

    const header = document.createElement("div");
    header.className = "omp-card";
    header.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">
        <div class="omp-h1">${escapeHtml(collection.title)}</div>
      </div>
      <div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-top:4px;">
        Angelegt von ${escapeHtml(collection.createdBy)} am ${fmtTime(collection.createdAt)}
      </div>
      ${collection.description ? `<div style="margin-top:var(--omp-space-2);">${escapeHtml(collection.description)}</div>` : ""}
    `;
    const actionsRow = document.createElement("div");
    actionsRow.style.cssText = "display:flex;gap:8px;margin-top:var(--omp-space-2);";
    const editBtn = document.createElement("button");
    editBtn.textContent = "Bearbeiten";
    editBtn.addEventListener("click", () => this.#openCollectionModal(collection));
    const delBtn = document.createElement("button");
    delBtn.textContent = "Löschen";
    delBtn.className = "omp-btn-danger";
    delBtn.addEventListener("click", () => void this.#deleteCollection(collection));
    actionsRow.append(editBtn, delBtn);
    header.appendChild(actionsRow);
    this.#detailEl.appendChild(header);

    const membersCard = document.createElement("div");
    membersCard.className = "omp-card";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--omp-space-2);";
    head.innerHTML = `<span style="font-weight:600;">Mitglieder (${this.#collectionMembers.length})</span>`;
    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Asset hinzufügen";
    addBtn.addEventListener("click", () => this.#openAddMemberModal(collection));
    head.appendChild(addBtn);
    membersCard.appendChild(head);

    if (this.#collectionMembers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Noch kein Asset in dieser Collection.";
      membersCard.appendChild(empty);
    } else {
      for (const a of this.#collectionMembers) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:4px;border-bottom:1px solid var(--omp-border);gap:8px;";
        const left = document.createElement("span");
        left.innerHTML = `${escapeHtml(a.title)} <span style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);">(${escapeHtml(a.type)})</span>`;
        const removeBtn = document.createElement("button");
        removeBtn.textContent = "Entfernen";
        removeBtn.addEventListener("click", () => void this.#removeCollectionMember(collection.id, a.id));
        row.append(left, removeBtn);
        membersCard.appendChild(row);
      }
    }
    this.#detailEl.appendChild(membersCard);
  }

  // Beziehungen (B12) — beide Richtungen (fromAssetId/toAssetId können
  // dieses Asset sein, s. handleListAssetRelationships-Doku), Pfeil zeigt
  // die tatsächliche Richtung statt sie zu verschleiern.
  #renderRelationships(asset: Asset): HTMLElement {
    const card = document.createElement("div");
    card.className = "omp-card";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--omp-space-2);";
    head.innerHTML = `<span style="font-weight:600;">Beziehungen (${this.#relationships.length})</span>`;
    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Beziehung";
    addBtn.addEventListener("click", () => this.#openCreateRelationshipModal(asset));
    head.appendChild(addBtn);
    card.appendChild(head);

    if (this.#relationships.length === 0) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Keine Beziehung zu anderen Assets (z. B. „abgeleitet von“, „Teil von“).";
      card.appendChild(empty);
      return card;
    }

    for (const rel of this.#relationships) {
      const outgoing = rel.fromAssetId === asset.id;
      const otherId = outgoing ? rel.toAssetId : rel.fromAssetId;
      const other = this.#assets.find((a) => a.id === otherId);
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:4px;border-bottom:1px solid var(--omp-border);gap:8px;";
      const left = document.createElement("span");
      left.innerHTML = `${outgoing ? "→" : "←"} <span style="color:var(--omp-text-dim);">${escapeHtml(rel.type)}</span> ${escapeHtml(other?.title ?? otherId)}`;
      const delBtn = document.createElement("button");
      delBtn.textContent = "Entfernen";
      delBtn.addEventListener("click", () => void this.#deleteRelationship(rel));
      row.append(left, delBtn);
      card.appendChild(row);
    }
    return card;
  }

  // Verknüpfte Prozessläufe (B10) — read-only bis auf "Entfernen":
  // Anlegen passiert in process-view.ts' Execution-Detail (s. dortige
  // Doku), hier nur Sichtbarkeit + Aufräumen.
  #renderVersionLinks(): HTMLElement {
    const card = document.createElement("div");
    card.className = "omp-card";
    const version = this.#versions.find((v) => v.id === this.#selectedVersionId);
    card.innerHTML = `<div style="font-weight:600;margin-bottom:var(--omp-space-2);">Verknüpfte Prozessläufe${version ? ` von v${version.versionNumber}` : ""} (${this.#versionLinks.length})</div>`;
    if (!version) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Zuerst eine Version auswählen.";
      card.appendChild(empty);
      return card;
    }
    if (this.#versionLinks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Kein Prozesslauf verknüpft. Verknüpfen geschieht im Prozesse-Tab an der jeweiligen Execution.";
      card.appendChild(empty);
      return card;
    }
    for (const link of this.#versionLinks) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:4px;border-bottom:1px solid var(--omp-border);gap:8px;";
      const left = document.createElement("span");
      left.innerHTML = `${badge(link.role, link.role === "input" ? "omp-badge-info" : "omp-badge-running")} <span style="font-family:ui-monospace,monospace;font-size:var(--omp-font-size-xs);" title="${escapeHtml(link.processExecutionId)}">${escapeHtml(link.processExecutionId.slice(0, 8))}…</span>`;
      const delBtn = document.createElement("button");
      delBtn.textContent = "Entfernen";
      delBtn.addEventListener("click", () => void this.#deleteAssetLink(link));
      row.append(left, delBtn);
      card.appendChild(row);
    }
    return card;
  }

  #renderHeader(asset: Asset): HTMLElement {
    const card = document.createElement("div");
    card.className = "omp-card";
    const current = this.#versions.find((v) => v.id === asset.currentVersionId);
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">
        <div class="omp-h1">${escapeHtml(asset.title)}</div>
        ${badge(statusLabel(asset.status), STATUS_BADGE[asset.status] ?? "")}
      </div>
      <div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-top:4px;">
        Typ ${escapeHtml(asset.type)} · aktuelle Version ${current ? `v${current.versionNumber}` : "–"} ·
        angelegt von ${escapeHtml(asset.createdBy)} am ${fmtTime(asset.createdAt)} ·
        zuletzt geändert von ${escapeHtml(asset.updatedBy || asset.createdBy)} am ${fmtTime(asset.updatedAt)}
      </div>
      ${asset.description ? `<div style="margin-top:var(--omp-space-2);">${escapeHtml(asset.description)}</div>` : ""}
    `;

    const targets = this.#lifecycle.asset[asset.status] ?? [];
    const row = document.createElement("div");
    row.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:var(--omp-space-2);";
    const lbl = document.createElement("span");
    lbl.style.cssText = "color:var(--omp-text-dim);margin-right:4px;";
    lbl.textContent = targets.length ? "Status ändern:" : "Endzustand — keine weiteren Statuswechsel.";
    row.appendChild(lbl);
    // "Gelöscht" bewusst ans Ende und als Gefahr markiert.
    for (const to of [...targets].sort((a, b) => Number(a === "deleted") - Number(b === "deleted"))) {
      const btn = document.createElement("button");
      btn.textContent = `→ ${statusLabel(to)}`;
      btn.setAttribute("data-status-target", to);
      if (to === "deleted") btn.className = "omp-btn-danger";
      btn.addEventListener("click", () => void this.#changeStatus(asset, to));
      row.appendChild(btn);
    }
    card.appendChild(row);
    return card;
  }

  #renderMetadata(asset: Asset): HTMLElement {
    const card = document.createElement("div");
    card.className = "omp-card";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--omp-space-2);";
    head.innerHTML = `<span style="font-weight:600;">Metadaten</span>`;
    const editBtn = document.createElement("button");
    editBtn.textContent = "Bearbeiten";
    editBtn.setAttribute("data-role", "metadata-edit");
    editBtn.addEventListener("click", () => this.#openMetadataModal(asset));
    head.appendChild(editBtn);
    card.appendChild(head);

    let any = false;
    for (const { key, label } of METADATA_CATEGORIES) {
      const entries = Object.entries(asset.metadata?.[key] ?? {});
      if (entries.length === 0) continue;
      any = true;
      const sec = document.createElement("div");
      sec.style.cssText = "margin-bottom:var(--omp-space-2);";
      sec.innerHTML = `
        <div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);text-transform:uppercase;letter-spacing:0.04em;">${label}</div>
        <table style="border-collapse:collapse;width:100%;">
          ${
        entries.map(([k, v]) => `
            <tr><td style="padding:2px 8px 2px 0;width:30%;color:var(--omp-text-dim);vertical-align:top;">${escapeHtml(k)}</td>
            <td style="padding:2px 0;word-break:break-word;">${escapeHtml(fmtValue(v))}</td></tr>`).join("")
      }
        </table>`;
      card.appendChild(sec);
    }
    if (!any) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Noch keine Metadaten.";
      card.appendChild(empty);
    }
    return card;
  }

  #renderVersions(asset: Asset): HTMLElement {
    const card = document.createElement("div");
    card.className = "omp-card";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--omp-space-2);";
    head.innerHTML = `<span style="font-weight:600;">Versionen (${this.#versions.length})</span>`;
    const newBtn = document.createElement("button");
    newBtn.textContent = "+ Neue Version";
    newBtn.setAttribute("data-role", "version-new");
    newBtn.addEventListener("click", () => this.#openVersionModal(asset));
    head.appendChild(newBtn);
    card.appendChild(head);

    if (this.#versions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Noch keine Version — eine Version bündelt die technischen Dateien (Representations) eines Standes.";
      card.appendChild(empty);
      return card;
    }

    const byId = new Map(this.#versions.map((v) => [v.id, v]));
    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;width:100%;";
    table.innerHTML = `<thead><tr style="color:var(--omp-text-dim);text-align:left;">
      <th style="padding:2px 8px;">#</th><th style="padding:2px 8px;">Status</th><th style="padding:2px 8px;">Basis</th>
      <th style="padding:2px 8px;">Änderungsgrund</th><th style="padding:2px 8px;">Angelegt</th><th style="padding:2px 8px;"></th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const v of [...this.#versions].sort((a, b) => b.versionNumber - a.versionNumber)) {
      const tr = document.createElement("tr");
      tr.setAttribute("data-version-id", v.id);
      const selected = v.id === this.#selectedVersionId;
      tr.style.cssText = "cursor:pointer;" + (selected ? "background:var(--omp-surface-raised);" : "");
      const parent = v.parentVersionId ? byId.get(v.parentVersionId) : undefined;
      tr.innerHTML = `
        <td style="padding:2px 8px;font-weight:${selected ? 600 : 400};">v${v.versionNumber}${v.id === asset.currentVersionId ? " ★" : ""}</td>
        <td style="padding:2px 8px;">${badge(v.status === "draft" ? "Entwurf" : v.status === "published" ? "veröffentlicht" : "archiviert", VERSION_BADGE[v.status] ?? "")}</td>
        <td style="padding:2px 8px;color:var(--omp-text-dim);">${parent ? `v${parent.versionNumber}` : "–"}</td>
        <td style="padding:2px 8px;">${escapeHtml(v.changeReason ?? "")}</td>
        <td style="padding:2px 8px;color:var(--omp-text-dim);">${escapeHtml(v.createdBy)}, ${fmtTime(v.createdAt)}</td>`;
      tr.addEventListener("click", () => void this.#selectVersion(v.id));
      const actions = document.createElement("td");
      actions.style.cssText = "padding:2px 8px;display:flex;gap:4px;justify-content:flex-end;";
      for (const to of this.#lifecycle.version[v.status] ?? []) {
        const act = VERSION_ACTION_LABEL[to];
        if (!act) continue;
        const btn = document.createElement("button");
        btn.textContent = act.label;
        if (to === "published") btn.className = "omp-btn-primary";
        btn.setAttribute("data-version-action", to);
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void this.#versionAction(v, to);
        });
        actions.appendChild(btn);
      }
      tr.appendChild(actions);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    card.appendChild(table);
    const hint = document.createElement("div");
    hint.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-top:4px;";
    hint.textContent = "★ = aktuelle Version. Zeile anklicken, um deren Representations zu sehen.";
    card.appendChild(hint);
    return card;
  }

  #renderRepresentations(): HTMLElement {
    const card = document.createElement("div");
    card.className = "omp-card";
    const version = this.#versions.find((v) => v.id === this.#selectedVersionId);
    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--omp-space-2);";
    head.innerHTML = `<span style="font-weight:600;">Representations${version ? ` von v${version.versionNumber}` : ""} (${this.#reps.length})</span>`;
    card.appendChild(head);

    if (!version) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Zuerst eine Version anlegen.";
      card.appendChild(empty);
      return card;
    }

    const editable = version.status === "draft";
    if (editable) {
      const addBtn = document.createElement("button");
      addBtn.textContent = "+ Representation";
      addBtn.setAttribute("data-role", "rep-new");
      addBtn.addEventListener("click", () => this.#openRepresentationModal(version));
      head.appendChild(addBtn);
    } else {
      const note = document.createElement("div");
      note.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-bottom:var(--omp-space-2);";
      note.setAttribute("data-role", "rep-immutable-note");
      note.textContent = `v${version.versionNumber} ist ${version.status === "published" ? "veröffentlicht" : "archiviert"} und damit unveränderlich — für andere Dateien eine neue Version anlegen.`;
      card.appendChild(note);
    }

    if (this.#reps.length === 0) {
      const empty = document.createElement("div");
      empty.className = "omp-empty";
      empty.textContent = "Keine Representations (z. B. Master, Proxy, Thumbnail).";
      card.appendChild(empty);
      return card;
    }

    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;width:100%;";
    table.innerHTML = `<thead><tr style="color:var(--omp-text-dim);text-align:left;">
      <th style="padding:2px 8px;">Typ</th><th style="padding:2px 8px;">Speicherort</th>
      <th style="padding:2px 8px;">Technik</th><th style="padding:2px 8px;"></th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const r of this.#reps) {
      const tr = document.createElement("tr");
      tr.setAttribute("data-rep-id", r.id);
      tr.innerHTML = `
        <td style="padding:2px 8px;font-weight:600;">${escapeHtml(r.type)}</td>
        <td style="padding:2px 8px;word-break:break-all;"><span style="color:var(--omp-text-dim);">${escapeHtml(r.storage.provider)}:</span> ${escapeHtml(r.storage.uri)}</td>
        <td style="padding:2px 8px;">${escapeHtml(representationSummary(r))}${r.checksum ? `<div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);word-break:break-all;">${escapeHtml(r.checksum)}</div>` : ""}</td>`;
      const td = document.createElement("td");
      td.style.cssText = "padding:2px 8px;text-align:right;";
      if (editable) {
        const del = document.createElement("button");
        del.textContent = "Entfernen";
        del.setAttribute("data-role", "rep-delete");
        del.addEventListener("click", () => void this.#deleteRepresentation(r));
        td.appendChild(del);
      }
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    card.appendChild(table);
    return card;
  }

  // ---- Modals (persistent, vom Poll-Rerender unberührt) ----------------------------------------

  #openModal(title: string, build: (modal: HTMLElement, close: () => void) => void, maxWidth = "520px") {
    this.#closeModal();
    const overlay = document.createElement("div");
    overlay.className = "omp-modal-overlay";
    const modal = document.createElement("div");
    modal.className = "omp-modal";
    modal.style.maxWidth = maxWidth;
    modal.style.maxHeight = "85vh";
    modal.style.overflowY = "auto";
    const h = document.createElement("div");
    h.className = "omp-h1";
    h.textContent = title;
    modal.appendChild(h);
    const close = () => this.#closeModal();
    build(modal, close);
    overlay.appendChild(modal);
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close();
    });
    overlay.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") close();
    });
    this.#modal = overlay;
    this.appendChild(overlay);
  }

  #closeModal() {
    this.#modal?.remove();
    this.#modal = null;
  }

  #field(labelText: string, input: HTMLElement, hint?: string): HTMLElement {
    const wrap = document.createElement("label");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:2px;margin-top:var(--omp-space-2);";
    const l = document.createElement("span");
    l.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";
    l.textContent = labelText;
    wrap.append(l, input);
    if (hint) {
      const h = document.createElement("span");
      h.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";
      h.textContent = hint;
      wrap.appendChild(h);
    }
    return wrap;
  }

  #input(name: string, opts: { placeholder?: string; list?: string; value?: string } = {}): HTMLInputElement {
    const i = document.createElement("input");
    i.name = name;
    i.style.cssText = "width:100%;box-sizing:border-box;";
    if (opts.placeholder) i.placeholder = opts.placeholder;
    if (opts.list) i.setAttribute("list", opts.list);
    if (opts.value) i.value = opts.value;
    return i;
  }

  #actions(modal: HTMLElement, close: () => void, saveLabel: string, onSave: (btn: HTMLButtonElement) => void) {
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:var(--omp-space-3);";
    const cancel = document.createElement("button");
    cancel.textContent = "Abbrechen";
    cancel.addEventListener("click", close);
    const save = document.createElement("button");
    save.className = "omp-btn-primary";
    save.textContent = saveLabel;
    save.setAttribute("data-role", "modal-save");
    save.addEventListener("click", () => onSave(save));
    actions.append(cancel, save);
    modal.appendChild(actions);
  }

  // Doppelklick-Schutz: Button während des Requests sperren, bei
  // Misserfolg wieder freigeben (Modal bleibt mit Eingaben offen).
  async #guard(btn: HTMLButtonElement, fn: () => Promise<boolean>, close: () => void) {
    btn.disabled = true;
    try {
      if (await fn()) close();
    } finally {
      btn.disabled = false;
    }
  }

  #openCreateModal() {
    ensureDatalist("omp-asset-type-suggestions", ASSET_TYPE_SUGGESTIONS);
    this.#openModal("Neues Asset", (modal, close) => {
      const type = this.#input("type", { placeholder: "z. B. video", list: "omp-asset-type-suggestions" });
      const title = this.#input("title", { placeholder: "Titel" });
      const desc = document.createElement("textarea");
      desc.name = "description";
      desc.rows = 3;
      desc.style.cssText = "width:100%;box-sizing:border-box;resize:vertical;font-family:inherit;";
      modal.append(
        this.#field("Titel *", title),
        this.#field("Typ *", type, "Freier Wert — Vorschläge per Pfeiltaste."),
        this.#field("Beschreibung", desc),
      );
      this.#actions(modal, close, "Anlegen", (btn) => {
        if (!title.value.trim() || !type.value.trim()) {
          showToast("Titel und Typ sind erforderlich.", { variant: "error" });
          return;
        }
        void this.#guard(btn, () => this.#createAsset(type.value.trim(), title.value.trim(), desc.value.trim()), close);
      });
      queueMicrotask(() => title.focus());
    });
  }

  // collection == null: anlegen; sonst: bestehende Collection bearbeiten
  // (Titel/Beschreibung — Mitgliederliste läuft über die Members-
  // Endpunkte, s. #openAddMemberModal).
  #openCollectionModal(collection: Collection | null) {
    this.#openModal(collection ? "Collection bearbeiten" : "Neue Collection", (modal, close) => {
      const title = this.#input("title", { placeholder: "Titel", value: collection?.title });
      const desc = document.createElement("textarea");
      desc.name = "description";
      desc.rows = 3;
      desc.value = collection?.description ?? "";
      desc.style.cssText = "width:100%;box-sizing:border-box;resize:vertical;font-family:inherit;";
      modal.append(this.#field("Titel *", title), this.#field("Beschreibung", desc));
      this.#actions(modal, close, collection ? "Speichern" : "Anlegen", (btn) => {
        if (!title.value.trim()) {
          showToast("Titel ist erforderlich.", { variant: "error" });
          return;
        }
        void this.#guard(
          btn,
          () =>
            collection
              ? this.#updateCollection(collection, title.value.trim(), desc.value.trim())
              : this.#createCollection(title.value.trim(), desc.value.trim()),
          close,
        );
      });
      queueMicrotask(() => title.focus());
    });
  }

  #openAddMemberModal(collection: Collection) {
    this.#openModal(`Asset zu „${collection.title}“ hinzufügen`, (modal, close) => {
      const memberIds = new Set(this.#collectionMembers.map((a) => a.id));
      const select = document.createElement("select");
      select.style.cssText = "width:100%;";
      const candidates = this.#assets.filter((a) => !memberIds.has(a.id));
      if (candidates.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "– kein weiteres Asset verfügbar –";
        select.appendChild(opt);
      } else {
        for (const a of candidates) {
          const opt = document.createElement("option");
          opt.value = a.id;
          opt.textContent = `${a.title} (${a.type})`;
          select.appendChild(opt);
        }
      }
      modal.append(this.#field("Asset", select));
      this.#actions(modal, close, "Hinzufügen", (btn) => {
        if (!select.value) {
          showToast("Kein Asset ausgewählt.", { variant: "error" });
          return;
        }
        void this.#guard(
          btn,
          async () => {
            await this.#addCollectionMember(collection.id, select.value);
            return true;
          },
          close,
        );
      });
    });
  }

  #openCreateRelationshipModal(asset: Asset) {
    ensureDatalist("omp-relationship-type-suggestions", RELATIONSHIP_TYPE_SUGGESTIONS);
    this.#openModal(`Beziehung von „${asset.title}“`, (modal, close) => {
      const direction = document.createElement("select");
      direction.style.cssText = "width:100%;";
      const outOpt = document.createElement("option");
      outOpt.value = "out";
      outOpt.textContent = `${asset.title} → …`;
      const inOpt = document.createElement("option");
      inOpt.value = "in";
      inOpt.textContent = `… → ${asset.title}`;
      direction.append(outOpt, inOpt);

      const targetSelect = document.createElement("select");
      targetSelect.style.cssText = "width:100%;";
      for (const a of this.#assets.filter((a) => a.id !== asset.id)) {
        const opt = document.createElement("option");
        opt.value = a.id;
        opt.textContent = `${a.title} (${a.type})`;
        targetSelect.appendChild(opt);
      }

      const type = this.#input("type", { placeholder: "z. B. derived_from", list: "omp-relationship-type-suggestions" });

      modal.append(
        this.#field("Richtung", direction),
        this.#field("Anderes Asset *", targetSelect),
        this.#field("Art der Beziehung *", type, "Freier Wert — Vorschläge per Pfeiltaste."),
      );
      this.#actions(modal, close, "Anlegen", (btn) => {
        if (!targetSelect.value || !type.value.trim()) {
          showToast("Anderes Asset und Art der Beziehung sind erforderlich.", { variant: "error" });
          return;
        }
        const fromId = direction.value === "out" ? asset.id : targetSelect.value;
        const toId = direction.value === "out" ? targetSelect.value : asset.id;
        void this.#guard(btn, () => this.#createRelationship(fromId, toId, type.value.trim()), close);
      });
    });
  }

  #openVersionModal(asset: Asset) {
    this.#openModal("Neue Version", (modal, close) => {
      const parent = document.createElement("select");
      parent.name = "parent";
      parent.style.cssText = "width:100%;";
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "– keine (unabhängiger Stand) –";
      parent.appendChild(none);
      const sorted = [...this.#versions].sort((a, b) => b.versionNumber - a.versionNumber);
      for (const v of sorted) {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = `v${v.versionNumber}${v.id === asset.currentVersionId ? " (aktuell)" : ""}`;
        parent.appendChild(opt);
      }
      parent.value = asset.currentVersionId ?? sorted[0]?.id ?? "";
      const reason = this.#input("changeReason", { placeholder: "z. B. neuer Farbabgleich" });
      modal.append(
        this.#field("Basiert auf", parent),
        this.#field("Änderungsgrund", reason, "Die neue Version startet als Entwurf; Representations werden an ihr ergänzt, dann veröffentlicht."),
      );
      this.#actions(modal, close, "Anlegen", (btn) => {
        void this.#guard(btn, () => this.#createVersion(asset.id, parent.value, reason.value.trim()), close);
      });
      queueMicrotask(() => reason.focus());
    });
  }

  #openRepresentationModal(version: AssetVersion) {
    ensureDatalist("omp-rep-type-suggestions", REPRESENTATION_TYPE_SUGGESTIONS);
    ensureDatalist("omp-storage-provider-suggestions", STORAGE_PROVIDER_SUGGESTIONS);
    this.#openModal(`Representation zu v${version.versionNumber}`, (modal, close) => {
      const type = this.#input("type", { placeholder: "z. B. master", list: "omp-rep-type-suggestions" });
      const provider = this.#input("provider", { list: "omp-storage-provider-suggestions", value: "filesystem" });
      const uri = this.#input("uri", { placeholder: "/media/clip.mov oder s3://bucket/key" });
      modal.append(this.#field("Typ *", type), this.#field("Speicher *", provider), this.#field("Pfad/URI *", uri));

      const tech = document.createElement("details");
      tech.style.cssText = "margin-top:var(--omp-space-3);";
      const summary = document.createElement("summary");
      summary.style.cssText = "cursor:pointer;color:var(--omp-text-dim);";
      summary.textContent = "Technische Angaben (optional)";
      tech.appendChild(summary);
      const grid = document.createElement("div");
      grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 8px;";
      const text: Record<string, HTMLInputElement> = {};
      for (const [k, label, ph] of [["format", "Format", "mxf"], ["codec", "Codec", "prores"], ["container", "Container", "mov"]]) {
        text[k] = this.#input(k, { placeholder: ph });
        grid.appendChild(this.#field(label, text[k]));
      }
      const numeric: [keyof Representation, string, boolean, string][] = [
        ["width", "Breite (px)", true, "1920"],
        ["height", "Höhe (px)", true, "1080"],
        ["frameRate", "Bildrate (fps)", false, "25"],
        ["sampleRate", "Abtastrate (Hz)", true, "48000"],
        ["channels", "Kanäle", true, "2"],
        ["bitrate", "Bitrate (bit/s)", true, "8000000"],
        ["sizeBytes", "Größe (Bytes)", true, ""],
      ];
      const num: Record<string, HTMLInputElement> = {};
      for (const [k, label, , ph] of numeric) {
        num[k] = this.#input(k, { placeholder: ph });
        num[k].inputMode = "decimal";
        grid.appendChild(this.#field(label, num[k]));
      }
      const checksum = this.#input("checksum", { placeholder: "sha256:…" });
      tech.append(grid, this.#field("Prüfsumme", checksum));
      modal.appendChild(tech);

      this.#actions(modal, close, "Anlegen", (btn) => {
        if (!type.value.trim() || !provider.value.trim() || !uri.value.trim()) {
          showToast("Typ, Speicher und Pfad/URI sind erforderlich.", { variant: "error" });
          return;
        }
        const rep: Record<string, unknown> = {
          type: type.value.trim(),
          storage: { provider: provider.value.trim(), uri: uri.value.trim() },
          checksum: checksum.value.trim() || undefined,
        };
        for (const k of Object.keys(text)) rep[k] = text[k].value.trim() || undefined;
        for (const [k, label, integer] of numeric) {
          const parsed = parseOptionalNumber(num[k].value, { integer });
          if (!parsed.ok) {
            tech.open = true;
            num[k].focus();
            showToast(`${label}: keine gültige ${integer ? "ganze " : ""}Zahl.`, { variant: "error" });
            return;
          }
          rep[k] = parsed.value;
        }
        void this.#guard(btn, () => this.#createRepresentation(version.id, rep as Partial<Representation>), close);
      });
      queueMicrotask(() => type.focus());
    }, "640px");
  }

  // Schlüssel/Wert-Editor je Kategorie statt eines rohen JSON-Felds —
  // Zielgruppe laut Aufgabenstellung auch Nicht-Techniker. Werte, die
  // im Original kein String waren, bleiben als JSON bearbeitbar (s.
  // asset-view-logic.ts MetadataRow.json).
  #openMetadataModal(asset: Asset) {
    const rows: MetadataRows = metadataToRows(asset.metadata);
    this.#openModal(`Metadaten: ${asset.title}`, (modal, close) => {
      const body = document.createElement("div");
      modal.appendChild(body);

      const renderCategory = (cat: keyof AssetMetadata, label: string, sec: HTMLElement) => {
        sec.replaceChildren();
        const head = document.createElement("div");
        head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-top:var(--omp-space-3);";
        head.innerHTML = `<span style="font-weight:600;">${label}</span>`;
        const add = document.createElement("button");
        add.textContent = "+ Feld";
        add.setAttribute("data-add-field", cat);
        add.addEventListener("click", () => {
          rows[cat].push({ key: "", value: "", json: false });
          renderCategory(cat, label, sec);
          (sec.querySelectorAll("input[data-meta-key]")[rows[cat].length - 1] as HTMLInputElement | undefined)?.focus();
        });
        head.appendChild(add);
        sec.appendChild(head);
        rows[cat].forEach((row, idx) => {
          const line = document.createElement("div");
          line.style.cssText = "display:grid;grid-template-columns:1fr 2fr auto;gap:4px;margin-top:4px;";
          const k = document.createElement("input");
          k.placeholder = "Feldname";
          k.value = row.key;
          k.setAttribute("data-meta-key", cat);
          k.addEventListener("input", () => (row.key = k.value));
          const v = document.createElement("input");
          v.placeholder = row.json ? "JSON-Wert" : "Wert";
          v.value = row.value;
          v.setAttribute("data-meta-value", cat);
          if (row.json) {
            v.style.fontFamily = "ui-monospace,monospace";
            v.title = "Strukturierter Wert (Zahl/Ja-Nein/Liste) — als JSON bearbeiten";
          }
          v.addEventListener("input", () => (row.value = v.value));
          const rm = document.createElement("button");
          rm.textContent = "✕";
          rm.title = "Feld entfernen";
          rm.addEventListener("click", () => {
            rows[cat].splice(idx, 1);
            renderCategory(cat, label, sec);
          });
          line.append(k, v, rm);
          sec.appendChild(line);
        });
      };
      for (const { key, label } of METADATA_CATEGORIES) {
        const sec = document.createElement("div");
        body.appendChild(sec);
        renderCategory(key, label, sec);
      }

      this.#actions(modal, close, "Speichern", (btn) => {
        const result = rowsToMetadata(rows);
        if (!result.ok) {
          showToast(result.error, { variant: "error" });
          return;
        }
        // Mit der zum Öffnen-Zeitpunkt gelesenen rowVersion speichern —
        // hat jemand anderes inzwischen geändert, lehnt das Backend (CAS)
        // mit 409 ab, statt fremde Änderungen still zu überschreiben.
        void this.#guard(btn, () => this.#saveMetadata(asset, result.metadata), close);
      });
    }, "680px");
  }
}

customElements.define("omp-asset-view", AssetView);
