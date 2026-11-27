import { useCallback, useEffect, useState } from "react"

/* Theme mode handling.
 *
 * The user picks one of three modes; "auto" follows the operating system.
 * Whatever the mode, the *resolved* theme ("light" or "dark") is written to
 * <html data-theme="..."> so the stylesheet only has to carry two palettes.
 *
 * The same resolution runs as an inline script in public/index.html before the
 * first paint, which is what keeps the page from flashing the wrong theme.
 * Keep the two in sync.
 */

const THEME_KEY = "themeMode"
const DARK_QUERY = "(prefers-color-scheme: dark)"

// Address-bar / task-switcher color per resolved theme. Mirrors --bg in
// theme.css, and the same two values are in the bootstrap in index.html.
const THEME_COLOR = { light: "#f3f4f8", dark: "#07070c" }

/* The accent hue, 0-360. One number, because everything else about the
 * accent - its lightness, its chroma, the eight translucent shades and the
 * glow behind the page - is derived from it in theme.css. See the comment
 * there for why the lightness is not the user's to choose.
 *
 * Kept next to the theme mode and in the same place: this is a preference
 * about how this screen looks to the person in front of it, not something
 * the flat agrees on, so it lives in localStorage and not in a service. */
const ACCENT_KEY = "accentHue"
const DEFAULT_HUE = 205

/* Named stops around the wheel. Offered because a slider alone asks somebody
 * to find a colour they like by sweeping 360 positions, and most people want
 * one of six. The slider is still there for the rest. */
const ACCENT_PRESETS = [
    { hue: 205, label: "Cyan" },
    { hue: 255, label: "Indigo" },
    { hue: 300, label: "Violett" },
    { hue: 350, label: "Rosé" },
    { hue: 40,  label: "Bernstein" },
    { hue: 150, label: "Grün" },
]

function isHue(value){
    return Number.isFinite(value) && value >= 0 && value <= 360
}

function loadAccentHue(){
    try {
        const stored = parseInt(localStorage.getItem(ACCENT_KEY), 10)
        if (isHue(stored)) return stored
    } catch {
        // Private mode or blocked storage - fall through to the default.
    }
    return DEFAULT_HUE
}

function applyAccentHue(hue){
    document.documentElement.style.setProperty("--accent-h", String(hue))
    return hue
}

/* The accent, as a hook shaped like useTheme so the settings screen treats
 * the two the same way. */
function useAccent(){
    const [hue, setHue] = useState(loadAccentHue)

    useEffect(() => {
        applyAccentHue(hue)
    }, [hue])

    const selectHue = useCallback((next) => {
        const value = Math.round(Number(next))
        if (!isHue(value)) return
        try {
            localStorage.setItem(ACCENT_KEY, String(value))
        } catch {
            // Persisting is a convenience; the in-memory hue still applies.
        }
        setHue(value)
    }, [])

    const reset = useCallback(() => selectHue(DEFAULT_HUE), [selectHue])

    return { hue, selectHue, reset, isDefault: hue === DEFAULT_HUE }
}

const THEME_MODES = [
    { key: "light", label: "Hell" },
    { key: "dark",  label: "Dunkel" },
    { key: "auto",  label: "Automatisch" },
]

function isMode(value){
    return value === "light" || value === "dark" || value === "auto"
}

function prefersDark(){
    return typeof window !== "undefined"
        && typeof window.matchMedia === "function"
        && window.matchMedia(DARK_QUERY).matches
}

function loadThemeMode(){
    try {
        const stored = localStorage.getItem(THEME_KEY)
        if (isMode(stored)) return stored
    } catch {
        // Private mode or blocked storage - fall through to the default.
    }
    return "auto"
}

function saveThemeMode(mode){
    try {
        localStorage.setItem(THEME_KEY, mode)
    } catch {
        // Persisting is a convenience; the in-memory mode still applies.
    }
}

function resolveTheme(mode){
    if (mode === "light" || mode === "dark") return mode
    return prefersDark() ? "dark" : "light"
}

function applyTheme(mode){
    const resolved = resolveTheme(mode)
    document.documentElement.setAttribute("data-theme", resolved)

    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute("content", THEME_COLOR[resolved])

    return resolved
}

/* Subscribes to OS theme changes and returns an unsubscribe function. */
function watchSystemTheme(onChange){
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => {}
    }
    const mql = window.matchMedia(DARK_QUERY)
    const handler = () => onChange(mql.matches ? "dark" : "light")

    // Safari below 14 only supports the deprecated addListener API.
    if (mql.addEventListener) {
        mql.addEventListener("change", handler)
        return () => mql.removeEventListener("change", handler)
    }
    mql.addListener(handler)
    return () => mql.removeListener(handler)
}

/* Single source of truth for the theme. Returns the picked mode, the resolved
 * theme and setters for both direct selection and cycling through the modes. */
function useTheme(){
    const [mode, setMode] = useState(loadThemeMode)
    const [resolved, setResolved] = useState(() => resolveTheme(loadThemeMode()))

    useEffect(() => {
        setResolved(applyTheme(mode))
    }, [mode])

    useEffect(() => {
        if (mode !== "auto") return undefined
        return watchSystemTheme(() => setResolved(applyTheme("auto")))
    }, [mode])

    const selectMode = useCallback((next) => {
        if (!isMode(next)) return
        saveThemeMode(next)
        setMode(next)
    }, [])

    const cycleMode = useCallback(() => {
        setMode(current => {
            const i = THEME_MODES.findIndex(m => m.key === current)
            const next = THEME_MODES[(i + 1) % THEME_MODES.length].key
            saveThemeMode(next)
            return next
        })
    }, [])

    return { mode, resolved, selectMode, cycleMode }
}

export { THEME_MODES, useTheme, loadThemeMode, resolveTheme, applyTheme }
export { ACCENT_PRESETS, DEFAULT_HUE, useAccent, loadAccentHue, applyAccentHue }
