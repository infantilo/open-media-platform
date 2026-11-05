// Dialog „Schnittstelle“ (Kap. 88): legt benannte Ausgänge/Eingänge eines Workflows an und ordnet ihnen Sender/Empfänger
// einzelner Rollen zu. Reine Bearbeitung einer Kopie; der Aufrufer speichert (Entwurf oder PUT).

import { t } from "../shell/i18n.ts";
import {
  addMember, addPort, clearFeed, type InterfaceSide, normalize, problems, removeMember, removePort, renamePort, setLabel, type WorkflowInterface,
} from "./workflow-interface-logic.ts";

export interface InterfaceDialogOptions {
  workflowName: string;
  roles: string[];
  initial: WorkflowInterface | undefined;
  /** Vorschläge für das Port-Feld (Port-Namen der laufenden Rolle); leer = freies Feld. */
  portsOf: (role: string, side: InterfaceSide) => string[];
  /** Anzeigename eines Workflows (für die Zuordnung „gespeist von …“). */
  nameOfWorkflow?: (id: string) => string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const DIM = "color:var(--omp-text-dim);";
const FIELD = "font:inherit;padding:2px 4px;box-sizing:border-box;";

/** Liefert die neue Schnittstelle (undefined = leer, Feld entfällt) oder null bei Abbruch. */
export function openInterfaceDialog(opts: InterfaceDialogOptions): Promise<WorkflowInterface | undefined | null> {
  return new Promise((resolve) => {
    let work: WorkflowInterface | undefined = structuredClone(opts.initial);
    let error = "";

    const overlay = el(
      "div",
      "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1000;display:flex;align-items:center;justify-content:center;",
    );
    overlay.setAttribute("data-role", "workflow-interface-dialog");
    const box = el(
      "div",
      "background:var(--omp-bg);color:var(--omp-text);border:1px solid var(--omp-info);border-radius:6px;padding:14px 16px;" +
        "width:min(720px,94vw);max-height:86vh;overflow:auto;font-size:13px;",
    );
    overlay.append(box);

    const close = (value: WorkflowInterface | undefined | null) => {
      overlay.remove();
      resolve(value);
    };

    const apply = (next: WorkflowInterface | null | undefined, failMsg?: string) => {
      if (next === null) error = failMsg ?? "";
      else {
        error = "";
        work = next;
      }
      render();
    };

    const sideSection = (side: InterfaceSide): HTMLElement => {
      const sec = el("section", "margin:12px 0;");
      sec.append(
        el("h3", "margin:0 0 4px;font-size:13px;", t(side === "outputs" ? "wfi.outputs" : "wfi.inputs")),
        el("div", "font-size:11px;margin-bottom:6px;" + DIM, t(side === "outputs" ? "wfi.outputsHint" : "wfi.inputsHint")),
      );
      for (const port of work?.[side] ?? []) {
        const card = el("div", "border:1px solid var(--omp-border,#444);border-radius:4px;padding:6px 8px;margin:6px 0;");
        card.setAttribute("data-role", "wfi-port");
        card.setAttribute("data-port-name", port.name);

        const head = el("div", "display:flex;gap:6px;align-items:center;flex-wrap:wrap;");
        const name = el("input", FIELD + "width:140px;");
        name.type = "text";
        name.value = port.name;
        name.title = t("wfi.name");
        name.addEventListener("change", () => {
          apply(renamePort(work!, side, port.name, name.value), t("wfi.nameTaken"));
        });
        const label = el("input", FIELD + "width:200px;");
        label.type = "text";
        label.value = port.label ?? "";
        label.placeholder = t("wfi.labelPlaceholder");
        label.addEventListener("change", () => apply(setLabel(work!, side, port.name, label.value)));
        const del = el("button", "cursor:pointer;margin-left:auto;", "×");
        del.type = "button";
        del.title = t("wfi.removePort");
        del.addEventListener("click", () => apply(removePort(work, side, port.name)));
        head.append(name, label, del);
        card.append(head);

        if (side === "inputs" && port.feed) {
          const feedRow = el("div", "margin:4px 0 0 12px;font-size:12px;" + DIM);
          feedRow.setAttribute("data-role", "wfi-feed");
          feedRow.append(
            t("wfi.fedBy", { p0: opts.nameOfWorkflow?.(port.feed.workflowId) ?? port.feed.workflowId, p1: port.feed.output }) + " ",
          );
          const unlink = el("button", "cursor:pointer;font:inherit;", t("wfi.unlink"));
          unlink.type = "button";
          unlink.addEventListener("click", () => apply(clearFeed(work!, port.name)));
          feedRow.append(unlink);
          card.append(feedRow);
        }

        port.members.forEach((m, index) => {
          const row = el("div", "display:flex;gap:6px;align-items:center;margin:4px 0 0 12px;");
          row.setAttribute("data-role", "wfi-member");
          const known = opts.roles.includes(m.role);
          const role = el("select", FIELD);
          if (!known) role.append(new Option(m.role + " ⚠", m.role));
          for (const r of opts.roles) role.append(new Option(r, r));
          role.value = m.role;
          const listId = `wfi-ports-${side}-${port.name}-${index}`;
          const portIn = el("input", FIELD + "width:290px;");
          portIn.type = "text";
          portIn.value = m.port ?? "";
          portIn.placeholder = t("wfi.portPlaceholder");
          portIn.setAttribute("list", listId);
          const dl = el("datalist");
          dl.id = listId;
          const fillSuggestions = () => {
            dl.replaceChildren(...opts.portsOf(role.value, side).map((p) => new Option(p, p)));
          };
          fillSuggestions();
          const update = () => {
            const next = structuredClone(work!);
            const target = next[side]!.find((p) => p.name === port.name)!;
            target.members[index] = portIn.value.trim() ? { role: role.value, port: portIn.value.trim() } : { role: role.value };
            apply(next);
          };
          role.addEventListener("change", update);
          portIn.addEventListener("change", update);
          const rm = el("button", "cursor:pointer;", "−");
          rm.type = "button";
          rm.title = t("wfi.removeMember");
          rm.addEventListener("click", () => apply(removeMember(work!, side, port.name, index)));
          row.append(role, portIn, dl, rm);
          card.append(row);
        });

        const addM = el("button", "cursor:pointer;margin:6px 0 0 12px;font:inherit;", t("wfi.addMember"));
        addM.type = "button";
        addM.addEventListener("click", () => {
          const used = new Set(port.members.map((m) => `${m.role}\u0000${m.port ?? ""}`));
          const role = opts.roles.find((r) => !used.has(`${r}\u0000`)) ?? opts.roles[0];
          if (role !== undefined) apply(addMember(work!, side, port.name, { role }));
        });
        card.append(addM);
        sec.append(card);
      }

      const addRow = el("div", "display:flex;gap:6px;margin-top:6px;");
      const newName = el("input", FIELD + "width:180px;");
      newName.type = "text";
      newName.placeholder = t(side === "outputs" ? "wfi.newOutput" : "wfi.newInput");
      const add = el("button", "cursor:pointer;font:inherit;", t("wfi.add"));
      add.type = "button";
      const doAdd = () => {
        if (!newName.value.trim()) return;
        const first = opts.roles[0];
        apply(addPort(work, side, newName.value, first !== undefined ? [{ role: first }] : []), t("wfi.nameTaken"));
      };
      add.addEventListener("click", doAdd);
      newName.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          doAdd();
        }
      });
      addRow.append(newName, add);
      sec.append(addRow);
      return sec;
    };

    const render = () => {
      box.replaceChildren();
      box.append(el("h2", "margin:0 0 4px;font-size:15px;", t("wfi.title", { p0: opts.workflowName })));
      box.append(el("div", "font-size:12px;" + DIM, t("wfi.intro")));
      box.append(sideSection("outputs"), sideSection("inputs"));
      if (error) box.append(el("div", "color:var(--omp-danger,#e66);margin:6px 0;", error));
      const bad = problems(work, opts.roles);
      if (bad.length > 0) box.append(el("div", "color:var(--omp-warn,#e8b04a);margin:6px 0;", t("wfi.problems")));
      const foot = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:10px;");
      const cancel = el("button", "cursor:pointer;font:inherit;padding:3px 12px;", t("kit.cancel"));
      cancel.type = "button";
      cancel.addEventListener("click", () => close(null));
      const ok = el("button", "cursor:pointer;font:inherit;padding:3px 12px;", t("kit.ok"));
      ok.type = "button";
      ok.className = "omp-btn-primary";
      ok.disabled = bad.length > 0;
      ok.addEventListener("click", () => close(normalize(work)));
      foot.append(cancel, ok);
      box.append(foot);
    };

    overlay.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") close(null);
    });
    overlay.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    render();
    document.body.append(overlay);
  });
}
