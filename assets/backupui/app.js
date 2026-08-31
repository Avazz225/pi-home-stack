/* Backup interface.

   A static page against the backup service's REST API — no build step, no
   framework, same chrome as the home interface (see ../common.js). Four tabs:
   what the backup is doing, which folders it covers, where copies go, and the
   credentials it uses. */

const { t, el, clear, bytes, num, when, requestJson } = PiHome;

const API = "/backup-api";
const SECRET_MASK = "********";

PiHome.addTranslations({
    de: {
        "Backup": "Backup",
        "Status": "Status",
        "Folders": "Ordner",
        "Targets": "Ziele",
        "Settings": "Einstellungen",
        "Backup service unreachable: %s": "Backup-Dienst nicht erreichbar: %s",
        "Could not save: %s": "Konnte nicht gespeichert werden: %s",

        // Status
        "Selected folders": "Ausgewählte Ordner",
        "Files in selection": "Dateien in Auswahl",
        "Data volume": "Datenmenge",
        "On every target": "Auf allen Zielen",
        "Deletion markers": "Löschmarker offen",
        "Last run": "Letzter Lauf",
        "%s active target": "%s aktives Ziel",
        "%s active targets": "%s aktive Ziele",
        "removed after %s days": "werden nach %s Tagen gelöscht",
        "The backup is switched off - the nightly job starts and aborts immediately.":
            "Die Sicherung ist deaktiviert — der nächtliche Lauf bricht sofort ab.",
        "Configuration incomplete:": "Konfiguration unvollständig:",
        "No target configured - add one under Targets.":
            "Kein Ziel angelegt — unter „Ziele“ eines hinzufügen.",
        "Back up now": "Jetzt sichern",
        "Backup running ...": "Sicherung läuft …",
        "Dry run": "Probelauf",
        "Shows what would happen without uploading or deleting anything.":
            "Zeigt, was passieren würde, ohne etwas hochzuladen oder zu löschen.",
        "Runs": "Läufe",
        "No run recorded yet.": "Noch kein Lauf aufgezeichnet.",
        "Successful": "Erfolgreich",
        "Error": "Fehler",
        "Running": "Läuft",
        "manual": "manuell",
        "cron": "Cron",
        "%s stored": "%s gesichert",
        "%s markers": "%s Marker",
        "%s deleted": "%s gelöscht",
        "No log recorded.": "Kein Log vorhanden.",
        "Open deletion markers": "Offene Löschmarker",
        "Files deleted or deselected on the NAS. They stay in the targets for %s more days from the date they were marked.":
            "Auf dem NAS gelöschte oder abgewählte Dateien. Sie bleiben ab Markierungsdatum noch %s Tage in den Zielen.",
        "Load list (%s)": "Liste laden (%s)",
        "marked %s": "markiert %s",
        "inactive": "inaktiv",
        "complete (%s)": "vollständig (%s)",
        "%s of %s outstanding": "%s von %s offen",

        // Folders
        "Default is no backup. A folder set to \"Back up\" includes every subfolder and file below it - until a subfolder is explicitly set to \"Do not back up\".":
            "Standard ist keine Sicherung. Ein auf „Sichern“ gesetzter Ordner schließt alle Unterordner und Dateien ein — bis ein Unterordner ausdrücklich auf „Nicht sichern“ gesetzt wird.",
        "Loading folder structure ...": "Ordnerstruktur wird geladen …",
        "No folder selected yet - nothing will be backed up.":
            "Noch kein Ordner ausgewählt — es wird nichts gesichert.",
        "backed up": "gesichert",
        "not backed up": "nicht gesichert",
        "inherited": "geerbt",
        "Back up": "Sichern",
        "Do not back up": "Nicht sichern",
        "Remove the setting and inherit from the parent folder again":
            "Einstellung entfernen, wieder vom übergeordneten Ordner erben",
        "Back up this folder and everything below it": "Diesen Ordner samt Unterordnern sichern",
        "Do not back up this folder or anything below it": "Diesen Ordner samt Unterordnern nicht sichern",
        "Rules set (%s)": "Gesetzte Regeln (%s)",
        "Remove rule": "Regel entfernen",
        "No subfolders": "Keine Unterordner",
        "Folder too large - the list is incomplete.": "Ordner zu groß — die Liste ist unvollständig.",
        "(everything)": "(alles)",

        // Targets
        "A target is either a bucket (Amazon S3 or an S3-compatible service) or a directory - a mounted NFS or SMB share, or a USB disk. Every file is written to every active target; encryption happens once, writing happens per target.":
            "Ein Ziel ist entweder ein Bucket (Amazon S3 oder ein S3-kompatibler Dienst) oder ein Verzeichnis — eine eingebundene NFS-/SMB-Freigabe oder eine USB-Platte. Jede Datei wird in jedes aktive Ziel geschrieben; verschlüsselt wird einmal, geschrieben pro Ziel.",
        "No active target - nothing is being backed up.": "Kein aktives Ziel — es wird nichts gesichert.",
        "Only one active target. For geo-redundancy add a second one somewhere else.":
            "Nur ein aktives Ziel. Für Georedundanz ein zweites an einem anderen Ort anlegen.",
        "Add target": "Ziel hinzufügen",
        "Directory": "Verzeichnis",
        "only when mounted": "nur wenn eingehängt",
        "%s current": "%s aktuell",
        "%s outdated": "%s veraltet",
        "%s missing": "%s fehlen",
        "of %s files": "von %s Dateien",
        "Enable": "Aktivieren",
        "Disable": "Deaktivieren",
        "Really remove": "Wirklich entfernen",
        "Removing only stops managing this target. The objects stay where they are and no run will clean them up afterwards.":
            "Entfernt nur die Verwaltung dieses Ziels. Die Objekte bleiben liegen und werden von keinem Lauf mehr aufgeräumt.",
        "Kind": "Art",
        "Object storage (S3 or S3-compatible)": "Objektspeicher (S3 oder S3-kompatibel)",
        "Directory (NFS, SMB, USB, second disk)": "Verzeichnis (NFS, SMB, USB, zweite Platte)",
        "Target directory": "Zielverzeichnis",
        "Abort when the directory is not a mount point":
            "Abbrechen, wenn das Verzeichnis kein Einhängepunkt ist",
        "Service": "Dienst",
        "Endpoint": "Endpunkt",
        "Addressing": "Adressierung",
        "Automatic": "Automatisch",
        "Path style (many self-hosted services)": "Pfad-Stil (viele selbst gehostete Dienste)",
        "Virtual-host style": "Virtual-Host-Stil",
        "Region": "Region",
        "Bucket": "Bucket",
        "Prefix": "Präfix",
        "Storage class": "Speicherklasse",
        "Another S3-compatible service": "Anderer S3-kompatibler Dienst",
        "The directory must exist and be writable by the backup service. For network shares, \"only when mounted\" is worth enabling: otherwise a share that failed to come up looks like an empty directory on the local disk.":
            "Das Verzeichnis muss existieren und für den Backup-Dienst beschreibbar sein. Bei Netzwerkfreigaben lohnt sich „nur wenn eingehängt“: sonst schreibt der Lauf in das leere Mount-Verzeichnis der lokalen Platte.",
        "The bucket must exist and the configured credentials need read, write and delete rights on it.":
            "Der Bucket muss existieren und den Zugangsdaten Lese-, Schreib- und Löschrechte geben.",
        "A new target catches up on everything already backed up during the next run.":
            "Ein neues Ziel holt beim nächsten Lauf alles bereits Gesicherte nach.",

        // Settings
        "Backup active": "Sicherung aktiv",
        "Without this the nightly job starts and aborts immediately.":
            "Ohne diesen Haken bricht der nächtliche Lauf sofort ab.",
        "Source": "Quelle",
        "NAS root directory": "NAS-Wurzelverzeichnis",
        "Nothing above this path is ever read.": "Oberhalb dieses Pfades wird nichts gelesen.",
        "Credentials": "Zugangsdaten",
        "Used for every S3 target. Leave empty to use the default boto3 credential chain (~/.aws or an instance profile). Directory targets need none.":
            "Gelten für alle S3-Ziele. Leer lassen nutzt die Standard-Credential-Kette von boto3 (~/.aws oder Instance-Profile). Verzeichnis-Ziele brauchen keine.",
        "Access Key ID": "Access Key ID",
        "Secret Access Key": "Secret Access Key",
        "Stored. Clear the field and type a new one to replace it.":
            "Gespeichert. Feld leeren und neu ausfüllen, um ihn zu ersetzen.",
        "Not stored yet.": "Noch nicht hinterlegt.",
        "Encryption": "Verschlüsselung",
        "Files are encrypted before they leave the Pi. The key was generated during installation and is kept in your credential store; this file is the copy the service reads.":
            "Dateien werden verschlüsselt, bevor sie den Pi verlassen. Der Schlüssel wurde bei der Installation erzeugt und liegt in deinem Tresor; diese Datei ist die Kopie für den Dienst.",
        "Key file": "Schlüsseldatei",
        "Must be chmod 600, otherwise the job refuses to start.":
            "Muss chmod 600 sein, sonst verweigert der Job den Start.",
        "Retention": "Aufbewahrung",
        "Keep deleted files (days)": "Gelöschte Dateien aufbewahren (Tage)",
        "Files that vanished or were deselected get a marker and are only removed from the targets after this period.":
            "Verschwundene oder abgewählte Dateien bekommen einen Löschmarker und werden erst nach dieser Frist aus den Zielen entfernt.",
        "Staging directory for encrypted files": "Zwischenspeicher für verschlüsselte Dateien",
        "Empty = system temp. Needs room for the largest single file.":
            "Leer = System-Temp. Muss Platz für die größte Einzeldatei haben.",
        "Saved.": "Gespeichert.",
        "Check connection": "Verbindung prüfen",
        "Checking ...": "Prüft …",
        "Every target is reachable and the backup key is readable.":
            "Alle Ziele sind erreichbar und der Backup-Schlüssel ist lesbar.",
        "Check failed:": "Prüfung fehlgeschlagen:",
        "Still open:": "Noch offen:",
    },
});

/* ── API ────────────────────────────────────────────────────────────────── */

const api = {
    status: () => requestJson(`${API}/status`),
    config: () => requestJson(`${API}/config`),
    saveConfig: (body) => requestJson(`${API}/config`, { method: "PUT", body }),
    check: () => requestJson(`${API}/config/check`, { method: "POST" }),
    targets: () => requestJson(`${API}/targets`),
    createTarget: (body) => requestJson(`${API}/targets`, { method: "POST", body }),
    updateTarget: (id, body) => requestJson(`${API}/targets/${id}`, { method: "PUT", body }),
    deleteTarget: (id) => requestJson(`${API}/targets/${id}`, { method: "DELETE" }),
    tree: (path) => requestJson(`${API}/tree?path=${encodeURIComponent(path)}`),
    rules: () => requestJson(`${API}/rules`),
    setRule: (path, mode) => requestJson(`${API}/rules`, { method: "PUT", body: { path, mode } }),
    runs: (limit) => requestJson(`${API}/runs?limit=${limit}`),
    run: (id) => requestJson(`${API}/runs/${id}`),
    startRun: (dryRun) => requestJson(`${API}/runs`, { method: "POST", body: { dryRun } }),
    objects: (params) => requestJson(`${API}/objects?${new URLSearchParams(params)}`),
};

/* ── Shared building blocks ─────────────────────────────────────────────── */

function banner(kind, text, listItems) {
    const box = el("div", `notice ${kind}`);
    if (text) box.appendChild(el("strong", null, text));
    if (listItems && listItems.length) {
        const list = el("ul");
        listItems.forEach((item) => list.appendChild(el("li", null, item)));
        box.appendChild(list);
    }
    return box;
}

function showBanner(kind, text, listItems) {
    const holder = document.getElementById("banner");
    clear(holder);
    if (text || (listItems && listItems.length)) holder.appendChild(banner(kind, text, listItems));
}

function card() { return el("section", "card"); }

function field(labelText, control, hint) {
    const wrapper = el("div", "field");
    wrapper.appendChild(el("label", null, labelText));
    wrapper.appendChild(control);
    if (hint) wrapper.appendChild(el("span", "hint", hint));
    return wrapper;
}

function input(value, onInput, attrs) {
    const node = el("input");
    node.value = value ?? "";
    Object.assign(node, attrs || {});
    node.addEventListener("input", (event) => onInput(event.target.value));
    return node;
}

function select(value, options, onChange) {
    const node = el("select");
    options.forEach(([key, label]) => {
        const option = el("option", null, label);
        option.value = key;
        node.appendChild(option);
    });
    node.value = value;
    node.addEventListener("change", (event) => onChange(event.target.value));
    return node;
}

function button(label, onClick, className) {
    const node = el("button", className, label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
}

function row(parent, label, value) {
    const line = el("div", "row");
    line.appendChild(el("span", null, label));
    line.appendChild(el("span", null, value));
    parent.appendChild(line);
}

/* ── Tabs ───────────────────────────────────────────────────────────────── */

const TABS = [
    ["status", "Status", renderStatus],
    ["folders", "Folders", renderFolders],
    ["targets", "Targets", renderTargets],
    ["settings", "Settings", renderSettings],
];

let activeTab = (location.hash || "#status").slice(1);
if (!TABS.some(([id]) => id === activeTab)) activeTab = "status";

function renderTabs() {
    const nav = document.getElementById("tabs");
    clear(nav);
    TABS.forEach(([id, label]) => {
        const node = button(t(label), () => selectTab(id), id === activeTab ? "active" : "");
        node.setAttribute("role", "tab");
        node.setAttribute("aria-selected", String(id === activeTab));
        nav.appendChild(node);
    });
}

function selectTab(id) {
    activeTab = id;
    history.replaceState(null, "", `#${id}`);
    renderTabs();
    renderActive();
}

function renderActive() {
    showBanner("", "");
    const view = document.getElementById("view");
    clear(view);
    view.appendChild(el("p", "loading", t("Loading ...")));
    const entry = TABS.find(([id]) => id === activeTab);
    entry[2](view).catch((error) => {
        clear(view);
        view.appendChild(banner("error", t("Backup service unreachable: %s", error.message)));
    });
}

/* ── Status ─────────────────────────────────────────────────────────────── */

let pollTimer = null;

async function renderStatus(view) {
    const [status, runs] = await Promise.all([api.status(), api.runs(15)]);
    clear(view);

    document.getElementById("subtitle").textContent =
        status.enabled ? "" : t("inactive");

    if (!status.enabled) {
        view.appendChild(banner("warn",
            t("The backup is switched off - the nightly job starts and aborts immediately.")));
    }
    if (status.problems && status.problems.length) {
        view.appendChild(banner("warn", t("Configuration incomplete:"), status.problems));
    }

    const activeTargets = status.activeTargets ?? 0;
    const tiles = el("div", "tiles");
    [
        [t("Selected folders"), num(status.includedFolders)],
        [t("Files in selection"), num(status.liveObjects)],
        [t("Data volume"), bytes(status.liveBytes)],
        [t("On every target"), num(status.fullyReplicated),
            activeTargets === 1 ? t("%s active target", 1) : t("%s active targets", activeTargets)],
        [t("Deletion markers"), num(status.markedObjects),
            t("removed after %s days", status.retentionDays)],
        [t("Last run"), when(status.lastRun && status.lastRun.started_at)],
    ].forEach(([label, value, hint]) => {
        const tile = el("div", "tile");
        tile.appendChild(el("span", "tile-value", value));
        tile.appendChild(el("span", "tile-label", label));
        if (hint) tile.appendChild(el("span", "tile-hint", hint));
        tiles.appendChild(tile);
    });
    view.appendChild(tiles);

    // Per-target coverage, the number that answers "am I actually redundant".
    if (!status.targets || !status.targets.length) {
        view.appendChild(banner("warn", t("No target configured - add one under Targets.")));
    } else {
        const list = el("div", "target-summary");
        status.targets.forEach((target) => {
            const pending = target.coverage.outdated + target.coverage.missing;
            const line = el("div", `summary-row ${target.enabled ? "" : "disabled"}`);
            line.appendChild(el("span",
                `dot ${target.enabled ? (pending ? "warn" : "ok") : ""}`));
            line.appendChild(el("span", "summary-name", target.name));
            line.appendChild(el("span", "meta", target.kind === "fs" ? t("Directory") : "S3"));
            line.appendChild(el("span", "meta", bytes(target.coverage.bytes)));
            line.appendChild(el("span", "summary-state", !target.enabled
                ? t("inactive")
                : pending
                    ? t("%s of %s outstanding", pending, target.coverage.liveObjects)
                    : t("complete (%s)", target.coverage.current)));
            list.appendChild(line);
        });
        view.appendChild(list);
    }

    const actions = el("div", "actions");
    const running = !!status.runningRun;
    const start = button(running ? t("Backup running ...") : t("Back up now"),
        () => trigger(false), "primary");
    start.disabled = running;
    const dry = button(t("Dry run"), () => trigger(true));
    dry.disabled = running;
    dry.title = t("Shows what would happen without uploading or deleting anything.");
    actions.appendChild(start);
    actions.appendChild(dry);
    view.appendChild(actions);

    view.appendChild(el("h2", null, t("Runs")));
    if (!runs.length) {
        view.appendChild(banner("", t("No run recorded yet.")));
    } else {
        const list = el("div", "run-list");
        runs.forEach((entry) => list.appendChild(runRow(entry)));
        view.appendChild(list);
    }

    view.appendChild(el("h2", null, t("Open deletion markers")));
    view.appendChild(el("p", "hint",
        t("Files deleted or deselected on the NAS. They stay in the targets for %s more days from the date they were marked.",
            status.retentionDays)));
    const markedHolder = el("div");
    view.appendChild(button(t("Load list (%s)", status.markedObjects), async () => {
        const objects = await api.objects({ state: "deleted", limit: 200 });
        clear(markedHolder);
        const list = el("div", "marked-list");
        objects.forEach((object) => {
            const line = el("div", "marked-row");
            line.appendChild(el("span", "marked-path", `/${object.rel_path}`));
            line.appendChild(el("span", "meta", t("marked %s", when(object.deleted_at))));
            line.appendChild(el("span", "meta", bytes(object.size)));
            list.appendChild(line);
        });
        markedHolder.appendChild(list);
    }));
    view.appendChild(markedHolder);

    // While a run is active the page follows it, so the user sees it finish.
    clearInterval(pollTimer);
    if (running && activeTab === "status") {
        pollTimer = setInterval(() => { if (activeTab === "status") renderActive(); }, 5000);
    }
}

const RUN_STATUS = { ok: "Successful", error: "Error", running: "Running" };

function runRow(run) {
    const item = el("div", `run ${run.status}`);
    const head = el("div", "run-head");
    head.appendChild(el("span", `dot ${run.status === "ok" ? "ok" : run.status === "error" ? "bad" : "warn"}`));
    head.appendChild(el("span", "run-time", when(run.started_at)));
    head.appendChild(el("span", "meta", t(RUN_STATUS[run.status] || run.status)));
    head.appendChild(el("span", "meta", t(run.trigger === "manual" ? "manual" : "cron")));
    const numbers = [t("%s stored", run.files_uploaded), bytes(run.bytes_uploaded)];
    if (run.files_marked) numbers.push(t("%s markers", run.files_marked));
    if (run.files_purged) numbers.push(t("%s deleted", run.files_purged));
    head.appendChild(el("span", "run-numbers", numbers.join(" · ")));
    item.appendChild(head);

    if (run.error) item.appendChild(el("div", "run-error", run.error));

    const logHolder = el("div");
    head.addEventListener("click", async () => {
        if (logHolder.firstChild) { clear(logHolder); return; }
        const detail = await api.run(run.id);
        logHolder.appendChild(el("pre", "run-log", detail.log || t("No log recorded.")));
    });
    item.appendChild(logHolder);
    return item;
}

async function trigger(dryRun) {
    try {
        await api.startRun(dryRun);
        setTimeout(renderActive, 800);
    } catch (error) {
        showBanner("error", error.message);
    }
}

/* ── Folders ────────────────────────────────────────────────────────────── */

/* Mirrors RuleSet in the backend: the nearest ancestor with an explicit rule
   wins, and without one nothing is backed up. Resolving locally lets a toggle
   update the whole visible tree without refetching it. */
function effectiveMode(rules, path) {
    let current = path;
    for (;;) {
        if (rules[current] !== undefined) return rules[current];
        if (current === "") return "exclude";
        const cut = current.lastIndexOf("/");
        current = cut === -1 ? "" : current.slice(0, cut);
    }
}

const folderState = { rules: {}, nodes: {}, expanded: { "": true }, root: null };

async function renderFolders(view) {
    const list = await api.rules();
    folderState.rules = Object.fromEntries(list.map((rule) => [rule.path, rule.mode]));
    folderState.root = await api.tree("");
    folderState.nodes = { "": folderState.root };
    drawFolders(view);
}

function drawFolders(view) {
    clear(view);
    view.appendChild(el("p", "hint", t("Default is no backup. A folder set to \"Back up\" includes every subfolder and file below it - until a subfolder is explicitly set to \"Do not back up\".")));

    const tree = el("div", "tree");
    tree.appendChild(folderRow({
        name: `${folderState.root.name} ${t("(everything)")}`,
        path: "", hasChildren: true,
    }, 0, view));
    appendChildren(tree, "", 1, view);
    view.appendChild(tree);

    view.appendChild(ruleSummary(view));
}

function appendChildren(tree, path, depth, view) {
    if (!folderState.expanded[path]) return;
    const node = folderState.nodes[path];
    if (!node) {
        tree.appendChild(indented(el("div", "tree-note", t("Loading ...")), depth));
        return;
    }
    if (node.error) {
        tree.appendChild(indented(el("div", "tree-note bad", node.error), depth));
        return;
    }
    if (!node.entries.length) {
        tree.appendChild(indented(el("div", "tree-note", t("No subfolders")), depth));
        return;
    }
    node.entries.forEach((entry) => {
        tree.appendChild(folderRow(entry, depth, view));
        if (entry.hasChildren) appendChildren(tree, entry.path, depth + 1, view);
    });
    // The API caps how many entries it scans - say so rather than quietly
    // showing an incomplete folder list.
    if (node.truncated) {
        tree.appendChild(indented(el("div", "tree-note bad",
            t("Folder too large - the list is incomplete.")), depth));
    }
}

function indented(node, depth) {
    node.style.paddingLeft = `${depth * 1.25}em`;
    return node;
}

function folderRow(entry, depth, view) {
    const explicit = folderState.rules[entry.path];
    const included = effectiveMode(folderState.rules, entry.path) === "include";
    const line = indented(el("div", `tree-row ${included ? "included" : ""}`), depth);

    const caret = el("button", `caret ${entry.hasChildren ? "" : "empty"}`,
        entry.hasChildren ? (folderState.expanded[entry.path] ? "▾" : "▸") : "·");
    caret.type = "button";
    caret.disabled = !entry.hasChildren;
    caret.addEventListener("click", () => toggleFolder(entry.path, view));
    line.appendChild(caret);

    const name = el("span", "tree-name", entry.name);
    if (entry.hasChildren) name.addEventListener("click", () => toggleFolder(entry.path, view));
    line.appendChild(name);

    const badge = el("span", `badge ${included ? "on" : "off"}`);
    badge.appendChild(document.createTextNode(included ? t("backed up") : t("not backed up")));
    if (!explicit) badge.appendChild(el("em", null, ` · ${t("inherited")}`));
    line.appendChild(badge);

    const actions = el("span", "tree-actions");
    const include = button(t("Back up"), () => applyRule(entry.path, "include", view),
        explicit === "include" ? "active" : "");
    include.title = t("Back up this folder and everything below it");
    const exclude = button(t("Do not back up"), () => applyRule(entry.path, "exclude", view),
        explicit === "exclude" ? "active" : "");
    exclude.title = t("Do not back up this folder or anything below it");
    actions.appendChild(include);
    actions.appendChild(exclude);
    if (explicit) {
        const reset = button("↺", () => applyRule(entry.path, "inherit", view), "reset");
        reset.title = t("Remove the setting and inherit from the parent folder again");
        actions.appendChild(reset);
    }
    line.appendChild(actions);
    return line;
}

async function toggleFolder(path, view) {
    const open = !folderState.expanded[path];
    folderState.expanded[path] = open;
    if (open && !folderState.nodes[path]) {
        drawFolders(view);
        try {
            folderState.nodes[path] = await api.tree(path);
        } catch (error) {
            folderState.nodes[path] = { error: error.message, entries: [] };
        }
    }
    drawFolders(view);
}

async function applyRule(path, mode, view) {
    const previous = { ...folderState.rules };
    // Optimistic: the tree re-resolves immediately, the request only confirms.
    if (mode === "inherit") delete folderState.rules[path];
    else folderState.rules[path] = mode;
    drawFolders(view);
    try {
        await api.setRule(path, mode);
        showBanner("", "");
    } catch (error) {
        folderState.rules = previous;
        drawFolders(view);
        showBanner("error", t("Could not save: %s", error.message));
    }
}

function ruleSummary(view) {
    const entries = Object.entries(folderState.rules).sort(([a], [b]) => a.localeCompare(b));
    if (!entries.length) return banner("warn", t("No folder selected yet - nothing will be backed up."));
    const box = card();
    box.appendChild(el("h3", null, t("Rules set (%s)", entries.length)));
    entries.forEach(([path, mode]) => {
        const line = el("div", `rule ${mode}`);
        line.appendChild(el("span", "rule-mode", mode === "include" ? t("Back up") : t("Do not back up")));
        line.appendChild(el("span", "rule-path", `/${path}`));
        const remove = button("×", () => applyRule(path, "inherit", view), "icon");
        remove.title = t("Remove rule");
        line.appendChild(remove);
        box.appendChild(line);
    });
    return box;
}

/* ── Targets ────────────────────────────────────────────────────────────── */

const REGIONS = [
    ["eu-north-1", "eu-north-1 — Stockholm"], ["eu-south-2", "eu-south-2 — Zaragoza"],
    ["eu-central-1", "eu-central-1 — Frankfurt"], ["eu-west-1", "eu-west-1 — Ireland"],
    ["eu-west-3", "eu-west-3 — Paris"], ["us-east-1", "us-east-1 — N. Virginia"],
];

const STORAGE_CLASSES = [
    ["STANDARD", "Standard"], ["STANDARD_IA", "Standard-IA"], ["ONEZONE_IA", "One Zone-IA"],
    ["INTELLIGENT_TIERING", "Intelligent-Tiering"], ["GLACIER_IR", "Glacier Instant Retrieval"],
    ["DEEP_ARCHIVE", "Glacier Deep Archive"],
];

/* Presets for the S3-compatible stores people actually reach for. "auto" lets
   boto3 decide; several self-hosted stores need path-style addressing. */
const PRESETS = {
    aws: { label: "Amazon S3", endpoint_url: "", addressing: "auto" },
    minio: { label: "MinIO / Garage / Ceph", endpoint_url: "https://minio.lan:9000", addressing: "path" },
    backblaze: { label: "Backblaze B2", endpoint_url: "https://s3.eu-central-003.backblazeb2.com", addressing: "auto" },
    wasabi: { label: "Wasabi", endpoint_url: "https://s3.eu-central-1.wasabisys.com", addressing: "auto" },
    hetzner: { label: "Hetzner Object Storage", endpoint_url: "https://fsn1.your-objectstorage.com", addressing: "auto" },
    custom: { label: "Another S3-compatible service", endpoint_url: "", addressing: "auto" },
};

const EMPTY_TARGET = {
    name: "", kind: "s3", region: "eu-central-1", bucket: "", prefix: "nas-backup",
    storage_class: "STANDARD_IA", endpoint_url: "", addressing: "auto", require_mount: false,
};

let editingTargetId = null;
let addingTarget = false;

async function renderTargets(view) {
    const targets = await api.targets();
    clear(view);

    view.appendChild(el("p", "hint", t("A target is either a bucket (Amazon S3 or an S3-compatible service) or a directory - a mounted NFS or SMB share, or a USB disk. Every file is written to every active target; encryption happens once, writing happens per target.")));

    const active = targets.filter((target) => target.enabled).length;
    if (active === 0) view.appendChild(banner("warn", t("No active target - nothing is being backed up.")));
    else if (active === 1) view.appendChild(banner("warn", t("Only one active target. For geo-redundancy add a second one somewhere else.")));

    targets.forEach((target) => {
        view.appendChild(editingTargetId === target.id
            ? targetForm(target, async (values) => {
                await api.updateTarget(target.id, values);
                editingTargetId = null;
                renderActive();
            }, () => { editingTargetId = null; renderActive(); })
            : targetCard(target));
    });

    if (addingTarget) {
        view.appendChild(targetForm(EMPTY_TARGET, async (values) => {
            await api.createTarget(values);
            addingTarget = false;
            renderActive();
        }, () => { addingTarget = false; renderActive(); }));
    } else {
        view.appendChild(button(t("Add target"), () => { addingTarget = true; renderActive(); }, "primary"));
    }
}

function targetCard(target) {
    const isFs = target.kind === "fs";
    const { current, outdated, missing, liveObjects } = target.coverage;
    const total = Math.max(liveObjects, current + outdated + missing, 1);
    const pending = outdated + missing;

    const box = el("section", `card target ${target.enabled ? "" : "disabled"}`);
    const head = el("div", "target-head");
    head.appendChild(el("span", `dot ${target.enabled ? (pending ? "warn" : "ok") : ""}`));
    head.appendChild(el("h3", null, target.name));
    head.appendChild(el("span", "badge kind", isFs ? t("Directory") : "S3"));
    if (!isFs) head.appendChild(el("span", "meta", target.region));
    if (!isFs) head.appendChild(el("span", "meta", target.storage_class));
    if (isFs && target.require_mount) head.appendChild(el("span", "meta", t("only when mounted")));
    if (!target.enabled) head.appendChild(el("span", "badge off", t("inactive")));
    box.appendChild(head);

    const path = isFs
        ? `${target.bucket}${target.prefix ? `/${target.prefix}` : ""}`
        : `s3://${target.bucket}${target.prefix ? `/${target.prefix}` : ""}`;
    box.appendChild(el("div", "target-path", path));
    if (!isFs && target.endpoint_url) box.appendChild(el("div", "target-path", target.endpoint_url));

    const bar = el("div", "bar");
    [["current", current], ["outdated", outdated], ["missing", missing]].forEach(([kind, value]) => {
        const segment = el("span", kind);
        segment.style.width = `${(value / total) * 100}%`;
        bar.appendChild(segment);
    });
    box.appendChild(bar);

    const numbers = el("div", "target-numbers");
    numbers.appendChild(el("span", "ok", t("%s current", current)));
    if (outdated) numbers.appendChild(el("span", "warn", t("%s outdated", outdated)));
    if (missing) numbers.appendChild(el("span", "bad", t("%s missing", missing)));
    numbers.appendChild(el("span", "meta", t("of %s files", liveObjects)));
    box.appendChild(numbers);

    const actions = el("div", "actions");
    actions.appendChild(button(t("Edit"), () => { editingTargetId = target.id; renderActive(); }));
    actions.appendChild(button(target.enabled ? t("Disable") : t("Enable"), async () => {
        await api.updateTarget(target.id, { enabled: !target.enabled });
        renderActive();
    }));
    const confirmHolder = el("span", "actions");
    actions.appendChild(button(t("Remove"), () => {
        clear(confirmHolder);
        confirmHolder.appendChild(button(t("Really remove"), async () => {
            await api.deleteTarget(target.id);
            renderActive();
        }, "danger"));
        confirmHolder.appendChild(button(t("Cancel"), () => {
            clear(confirmHolder);
            box.querySelector(".target-warning")?.remove();
        }));
        box.appendChild(el("p", "target-warning hint",
            t("Removing only stops managing this target. The objects stay where they are and no run will clean them up afterwards.")));
    }));
    actions.appendChild(confirmHolder);
    box.appendChild(actions);
    return box;
}

function targetForm(initial, onSubmit, onCancel) {
    const values = {
        name: initial.name || "",
        kind: initial.kind || "s3",
        region: initial.region || "",
        bucket: initial.bucket || "",
        prefix: initial.prefix || "",
        storage_class: initial.storage_class || "STANDARD_IA",
        endpoint_url: initial.endpoint_url || "",
        addressing: initial.addressing || "auto",
        require_mount: !!initial.require_mount,
    };
    let preset = initial.endpoint_url ? "custom" : "aws";

    const box = el("section", "card editing");
    const form = el("div", "form");
    box.appendChild(form);

    function redraw() {
        clear(form);
        const isFs = values.kind === "fs";

        form.appendChild(field(t("Name"),
            input(values.name, (v) => { values.name = v; }, { placeholder: "z. B. Spanien" })));

        form.appendChild(field(t("Kind"), select(values.kind, [
            ["s3", t("Object storage (S3 or S3-compatible)")],
            ["fs", t("Directory (NFS, SMB, USB, second disk)")],
        ], (v) => { values.kind = v; redraw(); })));

        if (isFs) {
            form.appendChild(field(t("Target directory"),
                input(values.bucket, (v) => { values.bucket = v; }, { placeholder: "/mnt/backup" })));
            const check = el("label", "checkbox");
            const box2 = el("input");
            box2.type = "checkbox";
            box2.checked = values.require_mount;
            box2.addEventListener("change", (e) => { values.require_mount = e.target.checked; });
            check.appendChild(box2);
            check.appendChild(el("span", null, t("Abort when the directory is not a mount point")));
            form.appendChild(field(t("only when mounted"), check));
        } else {
            form.appendChild(field(t("Service"), select(preset,
                Object.entries(PRESETS).map(([k, p]) => [k, k === "custom" ? t(p.label) : p.label]),
                (v) => {
                    preset = v;
                    values.endpoint_url = PRESETS[v].endpoint_url;
                    values.addressing = PRESETS[v].addressing;
                    redraw();
                })));
            if (preset !== "aws") {
                form.appendChild(field(t("Endpoint"),
                    input(values.endpoint_url, (v) => { values.endpoint_url = v; },
                        { placeholder: "https://…" })));
                form.appendChild(field(t("Addressing"), select(values.addressing, [
                    ["auto", t("Automatic")],
                    ["path", t("Path style (many self-hosted services)")],
                    ["virtual", t("Virtual-host style")],
                ], (v) => { values.addressing = v; })));
            }
            form.appendChild(field(t("Region"), select(values.region,
                REGIONS.concat(REGIONS.some(([k]) => k === values.region) || !values.region
                    ? [] : [[values.region, values.region]]),
                (v) => { values.region = v; })));
            form.appendChild(field(t("Bucket"), input(values.bucket, (v) => { values.bucket = v; })));
            form.appendChild(field(t("Storage class"),
                select(values.storage_class, STORAGE_CLASSES, (v) => { values.storage_class = v; })));
        }

        form.appendChild(field(t("Prefix"),
            input(values.prefix, (v) => { values.prefix = v; }, { placeholder: "nas-backup" })));
    }

    redraw();

    box.appendChild(el("p", "hint",
        `${values.kind === "fs"
            ? t("The directory must exist and be writable by the backup service. For network shares, \"only when mounted\" is worth enabling: otherwise a share that failed to come up looks like an empty directory on the local disk.")
            : t("The bucket must exist and the configured credentials need read, write and delete rights on it.")} ${t("A new target catches up on everything already backed up during the next run.")}`));

    const actions = el("div", "actions");
    const save = button(t("Save"), async () => {
        save.disabled = true;
        save.textContent = t("Saving ...");
        try {
            await onSubmit(values);
        } catch (error) {
            showBanner("error", t("Could not save: %s", error.message));
            save.disabled = false;
            save.textContent = t("Save");
        }
    }, "primary");
    actions.appendChild(save);
    actions.appendChild(button(t("Cancel"), onCancel));
    box.appendChild(actions);
    return box;
}

/* ── Settings ───────────────────────────────────────────────────────────── */

async function renderSettings(view) {
    const config = await api.config();
    const values = { ...config };
    clear(view);

    if (config.problems && config.problems.length) {
        view.appendChild(banner("warn", t("Still open:"), config.problems));
    }

    const toggle = el("label", "card checkbox big");
    const box = el("input");
    box.type = "checkbox";
    box.checked = config.enabled === "1";
    box.addEventListener("change", (e) => { values.enabled = e.target.checked ? "1" : "0"; });
    toggle.appendChild(box);
    const labels = el("span");
    labels.appendChild(el("strong", null, t("Backup active")));
    labels.appendChild(el("span", "hint", t("Without this the nightly job starts and aborts immediately.")));
    toggle.appendChild(labels);
    view.appendChild(toggle);

    function section(title, note, fields) {
        const group = card();
        group.appendChild(el("h3", null, title));
        if (note) group.appendChild(el("p", "hint", note));
        fields.forEach((node) => group.appendChild(node));
        view.appendChild(group);
    }

    section(t("Source"), null, [
        field(t("NAS root directory"),
            input(values.nas_root, (v) => { values.nas_root = v; }),
            t("Nothing above this path is ever read.")),
    ]);

    section(t("Credentials"),
        t("Used for every S3 target. Leave empty to use the default boto3 credential chain (~/.aws or an instance profile). Directory targets need none."), [
        field(t("Access Key ID"),
            input(values.aws_access_key_id, (v) => { values.aws_access_key_id = v; },
                { autocomplete: "off" })),
        field(t("Secret Access Key"),
            input(values.aws_secret_access_key, (v) => { values.aws_secret_access_key = v; },
                { type: "password", autocomplete: "new-password" }),
            config.aws_secret_access_key_set
                ? t("Stored. Clear the field and type a new one to replace it.")
                : t("Not stored yet.")),
    ]);

    section(t("Encryption"),
        t("Files are encrypted before they leave the Pi. The key was generated during installation and is kept in your credential store; this file is the copy the service reads."), [
        field(t("Key file"), input(values.key_file, (v) => { values.key_file = v; }),
            t("Must be chmod 600, otherwise the job refuses to start.")),
    ]);

    section(t("Retention"), null, [
        field(t("Keep deleted files (days)"),
            input(values.retention_days, (v) => { values.retention_days = v; },
                { type: "number", min: "1", max: "3650" }),
            t("Files that vanished or were deselected get a marker and are only removed from the targets after this period.")),
        field(t("Staging directory for encrypted files"),
            input(values.staging_dir, (v) => { values.staging_dir = v; }),
            t("Empty = system temp. Needs room for the largest single file.")),
    ]);

    const actions = el("div", "actions");
    const feedback = el("span", "feedback");
    const save = button(t("Save"), async () => {
        save.disabled = true;
        try {
            // The mask is echoed back for an untouched secret; sending it would
            // otherwise be indistinguishable from setting it to that literal value.
            const payload = { ...values };
            delete payload.problems;
            delete payload.aws_secret_access_key_set;
            if (payload.aws_secret_access_key === SECRET_MASK) delete payload.aws_secret_access_key;
            await api.saveConfig(payload);
            feedback.className = "feedback ok";
            feedback.textContent = t("Saved.");
        } catch (error) {
            feedback.className = "feedback bad";
            feedback.textContent = error.message;
        } finally {
            save.disabled = false;
        }
    }, "primary");
    const check = button(t("Check connection"), async () => {
        check.disabled = true;
        check.textContent = t("Checking ...");
        try {
            const result = await api.check();
            showBanner(result.ok ? "ok" : "error",
                result.ok ? t("Every target is reachable and the backup key is readable.") : t("Check failed:"),
                result.ok ? null : result.problems);
        } catch (error) {
            showBanner("error", error.message);
        } finally {
            check.disabled = false;
            check.textContent = t("Check connection");
        }
    });
    actions.appendChild(save);
    actions.appendChild(check);
    actions.appendChild(feedback);
    view.appendChild(actions);
}

/* ── Wiring ─────────────────────────────────────────────────────────────── */

document.getElementById("refresh").addEventListener("click", renderActive);
window.addEventListener("hashchange", () => {
    const id = location.hash.slice(1);
    if (TABS.some(([tab]) => tab === id) && id !== activeTab) selectTab(id);
});

PiHome.onLanguageChange(() => { renderTabs(); renderActive(); });
PiHome.initChrome();
renderTabs();
renderActive();
