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

// Address-bar / task-switcher color per resolved theme. Mirrors --bg in theme.css.
const THEME_COLOR = { light: "#f2f3f9", dark: "#09090e" }

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
