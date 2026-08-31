/* Home interface — renders status.json, which a systemd timer refreshes once a
   minute. No framework and no build step: this file is served as-is from the Pi. */

const POLL_MS = 30000;
const LINK_KEY = "pi-home-quicklinks";
const THEME_KEY = "pi-home-theme";
const LANG_KEY = "pi-home-language";

/* ── Translation ────────────────────────────────────────────────────────────
   Same approach as the installer: the English text is the key, so an untranslated
   string degrades to English instead of showing an identifier. */

const TRANSLATIONS = {
    de: {
        "Refresh": "Aktualisieren",
        "Loading status ...": "Status wird geladen …",
        "Quick links": "Quicklinks",
        "Add": "Hinzufügen",
        "Name": "Name",
        "Quick links are stored in this browser only.":
            "Quicklinks werden nur in diesem Browser gespeichert.",
        "No quick links yet.": "Noch keine Quicklinks angelegt.",
        "Remove": "Entfernen",
        "System": "System",
        "Uptime": "Laufzeit",
        "Load (1 min)": "Last (1 min)",
        "Temperature": "Temperatur",
        "Memory": "Arbeitsspeicher",
        "Data store": "Datenablage",
        "free": "frei",
        "Used": "Belegt",
        "Path": "Pfad",
        "Share": "Freigabe",
        "Warning": "Achtung",
        "not mounted": "nicht eingehängt",
        "RAID": "RAID",
        "degraded": "beschädigt",
        "healthy": "in Ordnung",
        "Note": "Hinweis",
        "Check and replace the disk": "Platte prüfen und ersetzen",
        "Pi-hole": "Pi-hole",
        "of all queries blocked": "der Anfragen blockiert",
        "Queries today": "Anfragen heute",
        "Blocked today": "Blockiert heute",
        "Domains on list": "Domains auf Liste",
        "Running. Pi-hole v6 only reports numbers through its signed-in interface.":
            "Läuft. Pi-hole v6 liefert Zahlen nur über die angemeldete Oberfläche.",
        "Service is not running.": "Dienst läuft nicht.",
        "Open the interface →": "Zur Oberfläche →",
        "Backup": "Backup",
        "last run failed": "letzter Lauf fehlgeschlagen",
        "last run": "letzter Lauf",
        "Backed up": "Gesichert",
        "files": "Dateien",
        "Volume": "Datenmenge",
        "Transferred": "Übertragen",
        "No run recorded yet.": "Noch kein Lauf aufgezeichnet.",
        "Internet": "Internet",
        "Download": "Download",
        "Upload": "Upload",
        "Latency": "Latenz",
        "Measured": "Gemessen",
        "Services": "Dienste",
        "Web server": "Webserver",
        "Network share": "Netzwerkfreigabe",
        "Backup API": "Backup-API",
        "Network monitor": "Netzwerkmonitor",
        "running": "läuft",
        "Status unavailable. ": "Status nicht verfügbar. ",
        "Is pi-home-status.timer running?": "Läuft pi-home-status.timer?",
        "As of %s": "Stand %s",
        "Theme: follow system": "Design: wie System",
        "Theme: light": "Design: hell",
        "Theme: dark": "Design: dunkel",
    },
};

let language = "en";
let messages = {};

function t(key, ...args) {
    let text = messages[key] || key;
    args.forEach((value) => { text = text.replace("%s", value); });
    return text;
}

function detectLanguage() {
    try {
        const stored = localStorage.getItem(LANG_KEY);
        if (stored) return stored;
    } catch { /* storage blocked */ }
    const preferred = (navigator.language || "en").slice(0, 2).toLowerCase();
    return TRANSLATIONS[preferred] ? preferred : "en";
}

function setLanguage(code) {
    language = TRANSLATIONS[code] ? code : "en";
    messages = TRANSLATIONS[language] || {};
    document.documentElement.lang = language;
    try { localStorage.setItem(LANG_KEY, language); } catch { /* storage blocked */ }
    document.querySelectorAll("[data-i18n]").forEach((node) => {
        node.textContent = t(node.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
        node.placeholder = t(node.getAttribute("data-i18n-placeholder"));
    });
    renderLinks();
    if (lastData) render(lastData);
    updateThemeButton();
}

/* ── Theme ──────────────────────────────────────────────────────────────────
   Three states: "auto" removes the attribute and lets the system decide. */

const THEME_ORDER = ["auto", "light", "dark"];
const THEME_ICONS = { auto: "◐", light: "☀", dark: "☾" };
const THEME_LABELS = { auto: "Theme: follow system", light: "Theme: light", dark: "Theme: dark" };

function currentTheme() {
    const explicit = document.documentElement.getAttribute("data-theme");
    return explicit === "light" || explicit === "dark" ? explicit : "auto";
}

function applyTheme(theme) {
    if (theme === "auto") {
        document.documentElement.removeAttribute("data-theme");
        try { localStorage.removeItem(THEME_KEY); } catch { /* storage blocked */ }
    } else {
        document.documentElement.setAttribute("data-theme", theme);
        try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage blocked */ }
    }
    updateThemeButton();
}

function updateThemeButton() {
    const theme = currentTheme();
    const button = document.getElementById("theme");
    document.getElementById("theme-icon").textContent = THEME_ICONS[theme];
    button.title = t(THEME_LABELS[theme]);
    button.setAttribute("aria-label", t(THEME_LABELS[theme]));
}

/* ── Formatting ─────────────────────────────────────────────────────────────
   Number and date formatting follows the chosen language, not the browser's. */

function locale() { return language === "de" ? "de-DE" : "en-GB"; }

function num(value) {
    return (value ?? 0).toLocaleString(locale());
}

function bytes(value) {
    if (value === null || value === undefined) return "–";
    const units = ["B", "kB", "MB", "GB", "TB"];
    let index = 0;
    let size = value;
    while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
    return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function duration(seconds) {
    if (seconds === null || seconds === undefined) return "–";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days) return `${days} d ${hours} h`;
    if (hours) return `${hours} h ${minutes} min`;
    return `${minutes} min`;
}

function when(iso) {
    if (!iso) return "–";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString(locale(), { dateStyle: "short", timeStyle: "short" });
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/* ── Tiles ──────────────────────────────────────────────────────────────── */

function tile(title, dotClass) {
    const node = element("section", "tile");
    const heading = element("h3");
    if (dotClass !== undefined) heading.appendChild(element("span", `dot ${dotClass}`));
    heading.appendChild(element("span", null, title));
    node.appendChild(heading);
    return node;
}

function addRow(parent, label, value) {
    const row = element("div", "row");
    row.appendChild(element("span", null, label));
    row.appendChild(element("span", null, value));
    parent.appendChild(row);
}

function addBar(parent, ratio) {
    const bar = element("div", "bar");
    const fill = element("span");
    const percent = Math.max(0, Math.min(1, ratio)) * 100;
    fill.style.width = `${percent}%`;
    if (percent > 90) fill.className = "bad";
    else if (percent > 75) fill.className = "warn";
    bar.appendChild(fill);
    parent.appendChild(bar);
}

function systemTile(system) {
    const node = tile(t("System"));
    node.appendChild(element("div", "value", duration(system.uptimeSeconds)));
    node.appendChild(element("div", "sub", t("Uptime")));
    if (system.load) {
        const perCore = system.cpuCount ? system.load[0] / system.cpuCount : system.load[0];
        addRow(node, t("Load (1 min)"),
            `${system.load[0].toFixed(2)}${system.cpuCount ? ` · ${Math.round(perCore * 100)} %` : ""}`);
    }
    if (system.cpuTemperature !== null) addRow(node, t("Temperature"), `${system.cpuTemperature} °C`);
    if (system.memoryTotal) {
        const used = system.memoryTotal - (system.memoryAvailable || 0);
        addRow(node, t("Memory"), `${bytes(used)} / ${bytes(system.memoryTotal)}`);
        addBar(node, used / system.memoryTotal);
    }
    return node;
}

function storageTile(storage, shareName) {
    if (!storage) return null;
    const node = tile(t("Data store"), storage.mounted ? "ok" : "bad");
    node.appendChild(element("div", "value", bytes(storage.free)));
    node.appendChild(element("div", "sub", t("free")));
    addRow(node, t("Used"), `${bytes(storage.used)} / ${bytes(storage.total)}`);
    addBar(node, storage.total ? storage.used / storage.total : 0);
    addRow(node, t("Path"), storage.path);
    if (shareName) addRow(node, t("Share"), shareName);
    if (!storage.mounted) addRow(node, t("Warning"), t("not mounted"));
    return node;
}

function raidTile(arrays) {
    if (!arrays || !arrays.length) return null;
    /* A degraded array is the one condition on this page that needs acting on,
       so it decides the colour of the whole tile. */
    const degraded = arrays.some((array) => array.healthy === false);
    const node = tile(t("RAID"), degraded ? "bad" : "ok");
    arrays.forEach((array) => {
        const state = array.healthy === false ? t("degraded") : t("healthy");
        addRow(node, `${array.name} (${array.level})`, `${array.disks || "?"} · ${state}`);
        if (array.resync) {
            addRow(node, array.resync.kind, `${array.resync.percent.toFixed(1)} %`);
            addBar(node, array.resync.percent / 100);
        }
    });
    if (degraded) addRow(node, t("Note"), t("Check and replace the disk"));
    return node;
}

function piholeTile(pihole, serviceState) {
    if (serviceState === "missing") return null;
    const node = tile(t("Pi-hole"), serviceState === "active" ? "ok" : "bad");
    if (pihole) {
        node.appendChild(element("div", "value", `${pihole.blockedPercent ?? 0} %`));
        node.appendChild(element("div", "sub", t("of all queries blocked")));
        addRow(node, t("Queries today"), num(pihole.queriesToday));
        addRow(node, t("Blocked today"), num(pihole.blockedToday));
        addRow(node, t("Domains on list"), num(pihole.domainsOnList));
    } else {
        node.appendChild(element("div", "sub", serviceState === "active"
            ? t("Running. Pi-hole v6 only reports numbers through its signed-in interface.")
            : t("Service is not running.")));
    }
    const link = element("a", null, t("Open the interface →"));
    link.href = "/admin/";
    node.appendChild(link);
    return node;
}

function backupTile(backup, serviceState) {
    if (!backup && serviceState === "missing") return null;
    const run = backup && backup.lastRun;
    const failed = run && run.status === "error";
    const node = tile(t("Backup"), failed ? "bad" : run ? "ok" : "warn");
    if (run) {
        node.appendChild(element("div", "value", when(run.started_at)));
        node.appendChild(element("div", "sub", failed ? t("last run failed") : t("last run")));
        addRow(node, t("Backed up"), `${num(backup.objects)} ${t("files")}`);
        addRow(node, t("Volume"), bytes(backup.bytes));
        addRow(node, t("Transferred"), `${run.files_uploaded} · ${bytes(run.bytes_uploaded)}`);
    } else {
        node.appendChild(element("div", "sub", t("No run recorded yet.")));
    }
    return node;
}

function netmonitorTile(measurement) {
    if (!measurement) return null;
    const node = tile(t("Internet"));
    node.appendChild(element("div", "value", `${Math.round(measurement.download_mbps)} Mbit/s`));
    node.appendChild(element("div", "sub", t("Download")));
    if (measurement.upload_mbps) addRow(node, t("Upload"), `${Math.round(measurement.upload_mbps)} Mbit/s`);
    if (measurement.ping_ms) addRow(node, t("Latency"), `${Math.round(measurement.ping_ms)} ms`);
    addRow(node, t("Measured"), when(measurement.measured_at));
    return node;
}

const SERVICE_LABELS = {
    nginx: "Web server", samba: "Network share", pihole: "Pi-hole",
    backup: "Backup API", netmonitor: "Network monitor",
};

function servicesTile(services) {
    const known = Object.entries(services).filter(([, state]) => state !== "missing");
    if (!known.length) return null;
    const broken = known.some(([, state]) => state !== "active");
    const node = tile(t("Services"), broken ? "warn" : "ok");
    known.forEach(([key, state]) => {
        addRow(node, t(SERVICE_LABELS[key] || key), state === "active" ? t("running") : state);
    });
    return node;
}

/* ── Rendering ──────────────────────────────────────────────────────────── */

let lastData = null;

function render(data) {
    lastData = data;
    document.getElementById("hostname").textContent = data.system.hostname || "Home";
    document.getElementById("model").textContent = data.system.model || "";
    document.getElementById("updated").textContent = t("As of %s", when(data.generatedAt));

    const main = document.getElementById("tiles");
    main.textContent = "";
    [
        systemTile(data.system),
        storageTile(data.storage, data.shareName),
        raidTile(data.raid),
        piholeTile(data.pihole, data.services.pihole),
        backupTile(data.backup, data.services.backup),
        netmonitorTile(data.netmonitor),
        servicesTile(data.services),
    ].filter(Boolean).forEach((node) => main.appendChild(node));
}

function renderError(message) {
    const main = document.getElementById("tiles");
    main.textContent = "";
    const box = element("div", "error");
    box.appendChild(element("strong", null, t("Status unavailable. ")));
    box.appendChild(document.createTextNode(message));
    main.appendChild(box);
}

async function refresh() {
    try {
        /* no-store because the file is rewritten every minute; a cached copy would
           look exactly like a stalled service. */
        const response = await fetch("status.json", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        render(await response.json());
    } catch (error) {
        renderError(`${error.message}. ${t("Is pi-home-status.timer running?")}`);
    }
}

/* ── Quick links ────────────────────────────────────────────────────────── */

function loadLinks() {
    try {
        return JSON.parse(localStorage.getItem(LINK_KEY) || "[]");
    } catch {
        return [];
    }
}

function saveLinks(links) {
    try {
        localStorage.setItem(LINK_KEY, JSON.stringify(links));
    } catch { /* private mode - the links simply do not persist */ }
}

function renderLinks() {
    const container = document.getElementById("quicklinks");
    container.textContent = "";
    const links = loadLinks();
    if (!links.length) {
        container.appendChild(element("p", "hint", t("No quick links yet.")));
        return;
    }
    links.forEach((link, index) => {
        const anchor = element("a");
        anchor.href = link.url;
        anchor.appendChild(element("span", null, link.label));
        const remove = element("span", "remove", "×");
        remove.title = t("Remove");
        remove.addEventListener("click", (event) => {
            event.preventDefault();
            const current = loadLinks();
            current.splice(index, 1);
            saveLinks(current);
            renderLinks();
        });
        anchor.appendChild(remove);
        container.appendChild(anchor);
    });
}

/* ── Wiring ─────────────────────────────────────────────────────────────── */

document.getElementById("link-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const label = document.getElementById("link-label");
    const url = document.getElementById("link-url");
    const links = loadLinks();
    links.push({ label: label.value.trim(), url: url.value.trim() });
    saveLinks(links);
    label.value = "";
    url.value = "";
    renderLinks();
});

document.getElementById("refresh").addEventListener("click", refresh);

document.getElementById("theme").addEventListener("click", () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme()) + 1) % THEME_ORDER.length];
    applyTheme(next);
});

const languageSelect = document.getElementById("language");
["en", ...Object.keys(TRANSLATIONS)].forEach((code) => {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = code.toUpperCase();
    languageSelect.appendChild(option);
});
languageSelect.addEventListener("change", (event) => setLanguage(event.target.value));

setLanguage(detectLanguage());
languageSelect.value = language;
refresh();
setInterval(refresh, POLL_MS);
