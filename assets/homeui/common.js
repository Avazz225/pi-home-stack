/* Shared chrome for every page of the stack: theme, translation, formatting and a
   few DOM helpers.

   Loaded before each page's own app.js. Pages add their strings with
   PiHome.addTranslations() and call PiHome.initChrome() once the header exists,
   which keeps theme and language behaviour identical everywhere without a build
   step or a framework. */

window.PiHome = (function () {
    const THEME_KEY = "pi-home-theme";
    const LANG_KEY = "pi-home-language";

    /* ── Storage that never throws ─────────────────────────────────────────
       Private windows and "block site data" make localStorage throw on access,
       not just return null, so every use goes through these. */

    function readStore(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }

    function writeStore(key, value) {
        try {
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        } catch { /* nothing to do - the setting just does not persist */ }
    }

    /* ── Translation ───────────────────────────────────────────────────────
       The English text is the key, so an untranslated string degrades to English
       instead of showing an identifier. Same convention as the installer. */

    const translations = {
        de: {
            "Refresh": "Aktualisieren",
            "Theme: follow system": "Design: wie System",
            "Theme: light": "Design: hell",
            "Theme: dark": "Design: dunkel",
            "Language": "Sprache",
            "As of %s": "Stand %s",
            "Loading ...": "Lädt …",
            "Saving ...": "Speichert …",
            "Save": "Speichern",
            "Cancel": "Abbrechen",
            "Edit": "Bearbeiten",
            "Remove": "Entfernen",
            "Add": "Hinzufügen",
            "Back": "Zurück",
            "yes": "ja",
            "no": "nein",
        },
    };

    let language = "en";
    let messages = {};
    const languageListeners = [];

    function addTranslations(extra) {
        Object.entries(extra).forEach(([code, table]) => {
            translations[code] = Object.assign(translations[code] || {}, table);
        });
    }

    function t(key, ...args) {
        let text = messages[key] || key;
        args.forEach((value) => { text = text.replace("%s", value); });
        return text;
    }

    function detectLanguage() {
        const stored = readStore(LANG_KEY);
        if (stored) return stored;
        const preferred = (navigator.language || "en").slice(0, 2).toLowerCase();
        return translations[preferred] ? preferred : "en";
    }

    function setLanguage(code) {
        language = translations[code] ? code : "en";
        messages = translations[language] || {};
        document.documentElement.lang = language;
        writeStore(LANG_KEY, language);
        applyStaticTranslations();
        updateThemeButton();
        languageListeners.forEach((fn) => fn(language));
    }

    function applyStaticTranslations() {
        document.querySelectorAll("[data-i18n]").forEach((node) => {
            node.textContent = t(node.getAttribute("data-i18n"));
        });
        document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
            node.placeholder = t(node.getAttribute("data-i18n-placeholder"));
        });
        document.querySelectorAll("[data-i18n-title]").forEach((node) => {
            node.title = t(node.getAttribute("data-i18n-title"));
        });
    }

    function onLanguageChange(fn) { languageListeners.push(fn); }

    function locale() { return language === "de" ? "de-DE" : "en-GB"; }

    /* ── Theme ─────────────────────────────────────────────────────────────
       Three states; "auto" removes the attribute and lets the system decide. */

    const THEME_ORDER = ["auto", "light", "dark"];
    const THEME_ICONS = { auto: "◐", light: "☀", dark: "☾" };
    const THEME_LABELS = {
        auto: "Theme: follow system", light: "Theme: light", dark: "Theme: dark",
    };

    function currentTheme() {
        const explicit = document.documentElement.getAttribute("data-theme");
        return explicit === "light" || explicit === "dark" ? explicit : "auto";
    }

    function applyTheme(theme) {
        if (theme === "auto") {
            document.documentElement.removeAttribute("data-theme");
            writeStore(THEME_KEY, null);
        } else {
            document.documentElement.setAttribute("data-theme", theme);
            writeStore(THEME_KEY, theme);
        }
        updateThemeButton();
    }

    function updateThemeButton() {
        const button = document.getElementById("theme");
        if (!button) return;
        const theme = currentTheme();
        const icon = document.getElementById("theme-icon");
        if (icon) icon.textContent = THEME_ICONS[theme];
        button.title = t(THEME_LABELS[theme]);
        button.setAttribute("aria-label", t(THEME_LABELS[theme]));
    }

    /* ── Formatting ────────────────────────────────────────────────────────── */

    function bytes(value) {
        if (value === null || value === undefined) return "–";
        const units = ["B", "kB", "MB", "GB", "TB"];
        let index = 0;
        let size = value;
        while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
        return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
    }

    function num(value) { return (value ?? 0).toLocaleString(locale()); }

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

    /* ── DOM ───────────────────────────────────────────────────────────────── */

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function clear(node) { node.textContent = ""; }

    /* ── Wiring ────────────────────────────────────────────────────────────── */

    function initChrome() {
        const button = document.getElementById("theme");
        if (button) {
            button.addEventListener("click", () => {
                const next = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme()) + 1) % THEME_ORDER.length];
                applyTheme(next);
            });
        }
        const select = document.getElementById("language");
        if (select) {
            clear(select);
            Object.keys(translations).concat("en").sort().forEach((code) => {
                if (select.querySelector(`option[value="${code}"]`)) return;
                const option = document.createElement("option");
                option.value = code;
                option.textContent = code.toUpperCase();
                select.appendChild(option);
            });
            select.addEventListener("change", (event) => setLanguage(event.target.value));
        }
        setLanguage(detectLanguage());
        if (select) select.value = language;
    }

    /* ── API access ────────────────────────────────────────────────────────── */

    async function requestJson(url, options) {
        const response = await fetch(url, options && {
            ...options,
            headers: { "Content-Type": "application/json" },
            body: options.body ? JSON.stringify(options.body) : undefined,
        });
        if (!response.ok) {
            let message = `HTTP ${response.status}`;
            try {
                const data = await response.json();
                message = data.error || data.message || message;
            } catch { /* not a JSON error body */ }
            const error = new Error(message);
            error.status = response.status;
            throw error;
        }
        return response.json();
    }

    return {
        addTranslations, t, setLanguage, onLanguageChange, initChrome,
        get language() { return language; },
        bytes, num, duration, when, el, clear, requestJson,
    };
}());
