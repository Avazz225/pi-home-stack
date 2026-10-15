import { useState, useRef, useEffect, useId } from "react"
import "./hint.css"

/* A small ⓘ that explains the thing next to it.
 *
 * The explanations used to be paragraphs under every control. They were right
 * and they were read once, after which they were a wall of text between the
 * reader and the button. So advice moved in here - but only advice: anything
 * that reports a state stays visible, because a warning you have to open is a
 * warning nobody reads.
 *
 * Hover is not enough. On a touch screen there is no hover, so this is a real
 * button that toggles, and it closes on Escape and on a click elsewhere. The
 * text is linked with aria-describedby rather than stuffed into a title
 * attribute, so a screen reader reads it as the description of its control.
 */
export default function Hint({ children, label = "Hinweis" }) {
    const [open, setOpen] = useState(false)
    const box = useRef(null)
    const id = useId()

    useEffect(() => {
        if (!open) return
        function onKey(event) { if (event.key === "Escape") setOpen(false) }
        function onClick(event) {
            if (box.current && !box.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener("keydown", onKey)
        document.addEventListener("pointerdown", onClick)
        return () => {
            document.removeEventListener("keydown", onKey)
            document.removeEventListener("pointerdown", onClick)
        }
    }, [open])

    return (
        <span className="hint" ref={box} data-open={open}>
            <button type="button" className="hint-btn" aria-label={label}
                    aria-expanded={open} aria-describedby={id}
                    onClick={() => setOpen(!open)}>
                i
            </button>
            <span className="hint-text" id={id} role="tooltip">{children}</span>
        </span>
    )
}
