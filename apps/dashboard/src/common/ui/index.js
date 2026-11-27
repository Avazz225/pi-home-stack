/* The dashboard's shared parts, as components.
 *
 * The CSS next door is the real definition; these are thin wrappers so a
 * module writes <Pill tone="ok"> rather than remembering a class name and a
 * data attribute. Thin on purpose - a component that takes fifteen props is
 * a second styling system, and the first one is what this replaces.
 *
 * Every part takes `className` and spreads the rest, so a module can place
 * one in its own grid without this file knowing about the grid.
 */

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"

import "./ui.css"

const cx = (...parts) => parts.filter(Boolean).join(" ")

/* A short status word. `dot` for a list where the colour has to survive being
   scanned down a column - a tinted background alone is hard to compare across
   rows that are far apart. */
export function Pill({ tone = "neutral", dot = false, className, children, ...rest }) {
    return (
        <span {...rest} className={cx("ui-pill", className)} data-tone={tone}>
            {dot && <span className="ui-pill__dot" />}
            {children}
        </span>
    )
}

/* One entry in a list. `off` dims it: for something switched off, unreachable
   or finished, which must stay where it was rather than disappear. */
export function Row({ off = false, className, children, ...rest }) {
    return (
        <div {...rest} className={cx("ui-row", className)} data-off={off ? "true" : undefined}>
            {children}
        </div>
    )
}

Row.Title = function RowTitle({ className, children, ...rest }) {
    return <span {...rest} className={cx("ui-row__title", className)}>{children}</span>
}

/* `num` switches on lining digits, so a column of figures lines up. Without
   it a list of wattages jitters as the values change. */
Row.Meta = function RowMeta({ num = false, className, children, ...rest }) {
    return (
        <span {...rest} className={cx("ui-row__meta", className)} data-num={num || undefined}>
            {children}
        </span>
    )
}

Row.Spacer = function RowSpacer() {
    return <span className="ui-row__spacer" />
}

export function Card({ title, actions, className, children, ...rest }) {
    return (
        <div {...rest} className={cx("ui-card", className)}>
            {(title || actions) && (
                <div className="ui-card__header">
                    {title && <span className="ui-card__title">{title}</span>}
                    <span className="ui-row__spacer" />
                    {actions}
                </div>
            )}
            {children}
        </div>
    )
}

/* `variant`: primary for the one thing the screen is for, danger for the
   destructive one, ghost for the action that repeats on every row. `on` is a
   pressed state, for a button used as a choice. */
export function Btn({ variant, size, on = false, className, children, ...rest }) {
    return (
        <button {...rest} type={rest.type || "button"} className={cx("ui-btn", className)}
                data-variant={variant} data-size={size} data-on={on || undefined}>
            {children}
        </button>
    )
}

/* Label above the control. The children are the control itself, so this does
   not have to know whether it is an input, a select or something else. */
export function Field({ label, className, children, ...rest }) {
    return (
        <label {...rest} className={cx("ui-field", className)}>
            {label && <span className="ui-field__label">{label}</span>}
            {children}
        </label>
    )
}

export function Empty({ className, children, ...rest }) {
    return <p {...rest} className={cx("ui-empty", className)}>{children}</p>
}

/* A line that reports a state. Stays visible rather than becoming a tooltip:
   a warning that has to be opened is a warning nobody reads. */
/* The whole screen, while it loads or because the service behind it is not
   answering. Distinct from Empty, which is a list with nothing in it. */
export function Status({ tone, className, children, ...rest }) {
    return <div {...rest} className={cx("ui-status", className)} data-tone={tone}>{children}</div>
}

export function Note({ tone, className, children, ...rest }) {
    return (
        <p {...rest} className={cx("ui-note", className)} data-tone={tone}>
            {children}
        </p>
    )
}

/* A label and its number. `size="lg"` is the one number on the screen that
   gets to be big. */
export function Stat({ label, value, unit, size, className, ...rest }) {
    return (
        <div {...rest} className={cx("ui-stat", className)} data-size={size}>
            {label && <span className="ui-stat__label">{label}</span>}
            <span className="ui-stat__value">
                {value}
                {unit && <span className="ui-stat__unit">{unit}</span>}
            </span>
        </div>
    )
}

/* The shell every module sits in, and its tab strip. `items` is
   [{id, label}]; the caller keeps the selected id, because which tab is open
   is the module's state and not this component's. */
export function Module({ className, children, ...rest }) {
    return <div {...rest} className={cx("ui-module", className)}>{children}</div>
}

export function Tabs({ items, value, onChange, inHeader = true, className, ...rest }) {
    /* A module's tabs belong beside the module's name, not in a row of their
       own below it. The host puts a slot in its header and these go there
       through it, so a module still writes its tabs where its own code is
       and does not have to know what the page around it looks like.
     *
     * The slot is found after the first paint, because on the very first
     * render the host's header has not mounted yet. Until then - and
     * wherever there is no slot at all, as in a test - they render in
     * place, which is also correct, just lower down. */
    const [slot, setSlot] = useState(null)
    useEffect(() => {
        if (!inHeader) return undefined
        setSlot(document.getElementById("dash-tabslot"))
        return () => setSlot(null)
    }, [inHeader])

    const strip = (
        <div {...rest} className={cx("ui-tabs", className)} role="tablist">
            {items.map(item => (
                <button key={item.id} type="button" role="tab"
                        aria-selected={item.id === value}
                        className={item.id === value ? "active" : undefined}
                        onClick={() => onChange(item.id)}>
                    {item.label}
                </button>
            ))}
        </div>
    )
    return slot ? createPortal(strip, slot) : strip
}

/* A figure in a row of figures. Distinct from Stat: a Stat is one number in a
   layout of its own, a Tile is one of several that have to line up. */
export function Tiles({ className, children, ...rest }) {
    return <div {...rest} className={cx("ui-tiles", className)}>{children}</div>
}

export function Tile({ label, value, hint, tone, className, ...rest }) {
    return (
        <div {...rest} className={cx("ui-tile", className)} data-tone={tone}>
            <span className="ui-tile__value">{value}</span>
            {label && <span className="ui-tile__label">{label}</span>}
            {hint && <span className="ui-tile__hint">{hint}</span>}
        </div>
    )
}

export function Actions({ className, children, ...rest }) {
    return <div {...rest} className={cx("ui-actions", className)}>{children}</div>
}

export function List({ className, children, ...rest }) {
    return <div {...rest} className={cx("ui-list", className)}>{children}</div>
}
