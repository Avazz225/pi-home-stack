import { useState } from "react"
import "./collapsible.css"

/* A block that folds away, with its state remembered per viewer.
 *
 * Built on <details>/<summary>: the browser handles keyboard operation, the
 * open state and what a screen reader announces. Reimplementing that with React
 * state is more code and less correct.
 *
 * The header carries the status itself - connected, how many entries, the next
 * time - because a closed block whose state is invisible has to be opened to be
 * ruled out, and then folding it away gained nothing.
 */

function remembered(key, fallback) {
    try {
        const value = localStorage.getItem(key)
        return value === null ? fallback : value === "1"
    } catch {
        // Private window, blocked site data: the default is right either way.
        return fallback
    }
}

export default function Collapsible({
    id, store = "home.open.", title, chips, summary,
    defaultOpen = false, className = "", children,
}) {
    const key = store + id
    const [open, setOpen] = useState(() => remembered(key, defaultOpen))

    function toggle(event) {
        const next = event.currentTarget.open
        setOpen(next)
        try {
            localStorage.setItem(key, next ? "1" : "0")
        } catch { /* nothing to remember, nothing lost */ }
    }

    return (
        <details className={`collapsible ${className}`} open={open} onToggle={toggle}>
            <summary className="collapsible-head">
                <span className="collapsible-marker" aria-hidden="true" />
                {title}
                {chips}
                {/* Only while closed: open, the block says all this itself. */}
                {!open && summary && <span className="home-meta collapsible-summary">{summary}</span>}
            </summary>
            <div className="collapsible-body">{children}</div>
        </details>
    )
}
