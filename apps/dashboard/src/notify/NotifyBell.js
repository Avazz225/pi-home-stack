import { useCallback, useEffect, useRef, useState } from "react"
import { fetchNotifications, markRead, clearRead } from "./api"
import { useUser } from "../common/user"
import { formatStamp } from "../common/time"
import "./notify.css"

/* The bell: what the flat wanted to tell this person.
 *
 * Polled rather than pushed. A browser that is open on a wall tablet for weeks
 * outlives any socket, and a minute of delay is nothing against the things
 * being reported - a lamp left on, a disk filling up.
 *
 * Nothing at all is shown when there is no user: notifications belong to
 * somebody, and a bell that is always empty is furniture.
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
            <button className="invisibleBtn nb-btn" onClick={() => setOpen(!open)}
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
                        <strong>Meldungen</strong>
                        {unread > 0 && (
                            <button className="nb-action" onClick={() => act(() => markRead())}>
                                alle gelesen
                            </button>
                        )}
                        {items.some(i => i.read_at) && (
                            <button className="nb-action" onClick={() => act(clearRead)}>
                                gelesene löschen
                            </button>
                        )}
                    </div>

                    {items.length === 0 && <p className="nb-empty">Nichts zu melden.</p>}

                    <div className="nb-list">
                        {items.map(item => (
                            <button key={item.id} className="nb-item" data-level={item.level}
                                    data-unread={!item.read_at}
                                    onClick={() => {
                                        if (!item.read_at) act(() => markRead(item.id))
                                        if (item.link) window.open(item.link, "_blank", "noreferrer")
                                    }}>
                                <span className="nb-title">{item.title}</span>
                                {item.body && <span className="nb-body">{item.body}</span>}
                                <span className="nb-when">{formatStamp(item.created_at)}</span>
                            </button>
                        ))}
                    </div>
                    {error && <p className="nb-error">{error}</p>}
                </div>
            )}
        </span>
    )
}
