import { useEffect, useRef, useState } from "react"
import { useUser, createUser } from "./user"
import "./usermenu.css"

/* Who is looking at this. Sits in the toolbar, because the answer changes what
 * every pane shows and that has to be visible without opening settings.
 *
 * Renaming and deleting live in the settings pane. Here is only: who am I, who
 * else is there, and - when there is nobody yet - a way to become someone.
 */
export default function UserMenu() {
    const { users, user, userId, loading, error, select, refresh } = useUser()
    const [open, setOpen] = useState(false)
    const [adding, setAdding] = useState(false)
    const [name, setName] = useState("")
    const [busy, setBusy] = useState(false)
    const [failure, setFailure] = useState("")
    const box = useRef(null)

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

    async function add() {
        const wanted = name.trim()
        if (!wanted) return
        setBusy(true)
        try {
            const created = await createUser(wanted)
            await refresh()
            select(created.id)
            setName("")
            setAdding(false)
            setOpen(false)
            setFailure("")
        } catch (e) {
            setFailure(e.message)
        } finally {
            setBusy(false)
        }
    }

    if (loading) return null
    if (error) {
        // The registry is unreachable, which is worth a word: without it the
        // panes that belong to somebody have nothing to show.
        return <span className="um-offline" title={error}>Benutzer?</span>
    }

    const label = user ? user.name : (users.length ? "wer bist du?" : "Benutzer anlegen")

    return (
        <span className="um" ref={box} data-open={open}>
            <button className="um-btn" onClick={() => setOpen(!open)}
                    data-unset={!userId}
                    aria-expanded={open} aria-haspopup="menu">
                {label}
            </button>
            {open && (
                <div className="um-menu" role="menu">
                    {users.map(u => (
                        <button key={u.id} role="menuitemradio" aria-checked={u.id === userId}
                                className={u.id === userId ? "um-item active" : "um-item"}
                                onClick={() => { select(u.id); setOpen(false) }}>
                            {u.name}
                        </button>
                    ))}
                    {users.length === 0 && (
                        <p className="um-empty">Noch niemand angelegt.</p>
                    )}
                    {adding ? (
                        <div className="um-add">
                            <input value={name} autoFocus placeholder="Name"
                                   onChange={e => setName(e.target.value)}
                                   onKeyDown={e => { if (e.key === "Enter") add() }} />
                            <button className="um-item" disabled={busy || !name.trim()}
                                    onClick={add}>Anlegen</button>
                        </div>
                    ) : (
                        <button className="um-item um-new" onClick={() => setAdding(true)}>
                            + Neuer Benutzer
                        </button>
                    )}
                    {failure && <p className="um-error">{failure}</p>}
                </div>
            )}
        </span>
    )
}
