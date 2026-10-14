import { useState } from "react"

/* One collapsible settings block.
 *
 * Built on <details>/<summary> rather than a div and a click handler: the
 * browser then handles keyboard operation, the open state, and what a screen
 * reader announces. Reimplementing that with React state is more code and less
 * correct.
 *
 * Closed by default. All four blocks expanded at once made the settings page so
 * long that the one being looked for was never on screen — and the floorplan
 * editor alone is taller than a phone. What is open is remembered per viewer, so
 * a reload does not undo the click that was just made.
 *
 * The header carries the status itself (connected, not set up, how many rooms
 * are drawn), because a closed block whose state is invisible has to be opened
 * to be ruled out — which defeats the collapsing.
 */

const STORE_PREFIX = "home.settings.open."

function remembered(id, fallback) {
    try {
        const value = localStorage.getItem(STORE_PREFIX + id)
        return value === null ? fallback : value === "1"
    } catch {
        // Private window, blocked site data: the default is right either way.
        return fallback
    }
}

export default function SettingsSection({ id, title, chips, summary, defaultOpen = false, children }) {
    const [open, setOpen] = useState(() => remembered(id, defaultOpen))

    function toggle(event) {
        const next = event.currentTarget.open
        setOpen(next)
        try {
            localStorage.setItem(STORE_PREFIX + id, next ? "1" : "0")
        } catch { /* nothing to remember, nothing lost */ }
    }

    return (
        <details className="home-card set-section" open={open} onToggle={toggle}>
            <summary className="set-section-head">
                <span className="set-section-marker" aria-hidden="true" />
                <h4>{title}</h4>
                {chips}
                {/* Only while closed: open, the block says all this itself. */}
                {!open && summary && <span className="home-meta set-section-summary">{summary}</span>}
            </summary>
            <div className="set-section-body">{children}</div>
        </details>
    )
}
