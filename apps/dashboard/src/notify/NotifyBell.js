import { useCallback, useEffect, useRef, useState } from "react"
import { fetchNotifications, markRead, clearRead } from "./api"
import { useUser } from "../common/user"
import { parseStamp, formatStamp } from "../common/time"
import "./notify.css"

/* The bell: what the flat wanted to tell this person.
 *
 * Polled rather than pushed. A browser that is open on a wall tablet for weeks
 * outlives any socket, and a minute of delay is nothing against the things
 * being reported - a lamp left on, a disk filling up.
 *
 * Nothing at all is shown when there is no user: notifications belong to
 * somebody, and a bell that is always empty is furniture.
 *
 * The panel used to carry the level and whether a message had been read on one
 * 3px bar down its left edge, so a read alert and an unread note looked much
 * the same; it repeated the full date on every row even when five of them were
 * from this morning; its two actions were bare text links at the weight of the
 * heading; and it was as long as its list, so the seventh message simply ran
 * off the bottom with nothing saying so.
 *
 * Now: the level is the icon and nothing else, unread shows on the row itself,
 * days are headings so a row needs only its time, and the list scrolls inside
 * a panel that is the same shape with two messages or forty.
 */

const POLL_MS = 60000

export default function NotifyBell() {
    const { userId } = useUser()
    const [data, setData] = useState(null)
    const [open, setOpen] = useState(false)
    const [error, setError] = useState("")
    const box = useRef(null)

    const refresh = useCallback(async () => {
        if (!userId) return setData(null)
        try {
            setData(await fetchNotifications())
            setError("")
        } catch (e) {
            setError(e.message)
        }
    }, [userId])

    useEffect(() => {
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => clearInterval(timer)
    }, [refresh])

    useEffect(() => {
        if (!open) return
        function onClick(event) {
            if (box.current && !box.current.contains(event.target)) setOpen(false)
        }
        function onKey(event) { if (event.key === "Escape") setOpen(false) }
        document.addEventListener("pointerdown", onClick)
        document.addEventListener("keydown", onKey)
        return () => {
            document.removeEventListener("pointerdown", onClick)
            document.removeEventListener("keydown", onKey)
        }
    }, [open])

    if (!userId) return null
    // The service is optional; without it the dashboard simply has no bell
    // rather than a permanent error in the toolbar.
    if (!data && error) return null

    const unread = data ? data.unread : 0
    const items = (data && data.items) || []
    const hasRead = items.some(i => i.read_at)

    async function act(action) {
        try {
            await action()
            await refresh()
        } catch (e) {
            setError(e.message)
        }
    }

    return (
        <span className="nb" ref={box}>
            {/* A trigger with its panel open keeps its pressed look. */}
            <button className="invisibleBtn nb-btn" onClick={() => setOpen(!open)}
                    data-open={open ? "true" : undefined}
                    aria-label={unread ? `${unread} ungelesene Meldungen` : "Meldungen"}
                    aria-expanded={open}>
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                    <path fill="currentColor" d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5a6 6 0 0 0-5-5.91V4a1 1 0 0 0-2 0v1.09A6 6 0 0 0 6 11v5l-2 2v1h16v-1z"/>
                </svg>
                {unread > 0 && <span className="nb-count">{unread > 99 ? "99+" : unread}</span>}
            </button>

            {open && (
                <div className="nb-panel">
                    <div className="nb-head">
                        <strong className="nb-head-title">Meldungen</strong>
                        {unread > 0 && <span className="nb-unread">{unread} ungelesen</span>}
                        <span className="nb-spacer" />
                        {unread > 0 && (
                            <button className="nb-action" onClick={() => act(() => markRead())}>
                                <CheckIcon />
                                Alle gelesen
                            </button>
                        )}
                        {/* Quiet, because it throws things away - and an icon
                            rather than a second link at the heading's weight. */}
                        {hasRead && (
                            <button className="nb-action" data-quiet="true"
                                    title="Gelesene löschen" aria-label="Gelesene löschen"
                                    onClick={() => act(clearRead)}>
                                <TrashIcon />
                            </button>
                        )}
                    </div>

                    {items.length === 0 && <p className="nb-empty">Nichts zu melden.</p>}

                    {items.length > 0 && (
                        <div className="nb-list">
                            {groupByDay(items).map(group => (
                                <div className="nb-group" key={group.key}>
                                    {/* The day said once, over its messages. The
                                        old list typed the full date on every
                                        row, five times for one morning. */}
                                    <p className="nb-day">{group.label}</p>
                                    {group.items.map(item => (
                                        <Message key={item.id} item={item} act={act} />
                                    ))}
                                </div>
                            ))}
                        </div>
                    )}
                    {error && <p className="nb-error">{error}</p>}
                </div>
            )}
        </span>
    )
}

function Message({ item, act }) {
    const unread = !item.read_at
    return (
        <button className="nb-item" data-level={item.level} data-unread={unread || undefined}
                onClick={() => {
                    if (unread) act(() => markRead(item.id))
                    if (item.link) window.open(item.link, "_blank", "noreferrer")
                }}>
            {/* The level is the icon's job and nothing else's. */}
            <span className="nb-icon" aria-hidden><LevelIcon level={item.level} /></span>
            <span className="nb-text">
                <span className="nb-title">{item.title}</span>
                {item.body && <span className="nb-body">{item.body}</span>}
            </span>
            {/* The time alone: the day is the heading above it. Unread shows
                on the row - the fill, the weight of the title, the time in the
                accent - rather than as a mark in a gutter that stands empty on
                half the rows. */}
            <span className="nb-when">{fmtTime(item.created_at)}</span>
        </button>
    )
}

/* Messages under the day they arrived on.
 *
 * Today and yesterday get a word; anything older gets its date. The order the
 * service answered in is kept - it sorts newest first and that is the order to
 * read them in. */
export function groupByDay(items, now = new Date()) {
    const groups = []
    const byKey = new Map()

    for (const item of items) {
        const date = parseStamp(item.created_at)
        const key = date ? dayKey(date) : "unbekannt"
        if (!byKey.has(key)) {
            const group = { key, label: dayLabel(date, now), items: [] }
            byKey.set(key, group)
            groups.push(group)
        }
        byKey.get(key).items.push(item)
    }
    return groups
}

const dayKey = (date) =>
    `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`

function dayLabel(date, now) {
    if (!date) return "Ohne Datum"
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    if (dayKey(date) === dayKey(now)) return "Heute"
    if (dayKey(date) === dayKey(yesterday)) return "Gestern"
    return formatStamp(date.toISOString(), { weekday: "short", day: "2-digit", month: "2-digit" })
}

const fmtTime = (value) => formatStamp(value, { timeStyle: "short" })

/* Drawn here rather than pulled from an icon set: the dashboard ships no icon
   package, and one stroke width and one size are kept across the three. */
function LevelIcon({ level }) {
    const props = {
        viewBox: "0 0 24 24", width: 15, height: 15, fill: "none",
        stroke: "currentColor", strokeWidth: 2,
        strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
    }
    if (level === "alert") {
        return (
            <svg {...props}>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v5M12 16h.01" />
            </svg>
        )
    }
    if (level === "warn") {
        return (
            <svg {...props}>
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <path d="M12 9v4M12 17h.01" />
            </svg>
        )
    }
    return (
        <svg {...props}>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 16v-5M12 8h.01" />
        </svg>
    )
}

function CheckIcon() {
    return (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
             strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
        </svg>
    )
}

function TrashIcon() {
    return (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
        </svg>
    )
}
