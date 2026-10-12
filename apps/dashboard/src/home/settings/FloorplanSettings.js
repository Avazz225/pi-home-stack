import { useMemo, useState } from "react"
import { updateRoom } from "../api"
import Floorplan from "../floorplan/Floorplan"
import { asRect, rectPoints, polygonArea, parsePoints } from "../floorplan/shapes"

/* Editing the flat's geometry.
 *
 * Two input modes, because almost every room is a rectangle and asking for four
 * corner pairs to describe one is tedious and error-prone. x, y, width and
 * height cover the common case; the raw corner list covers everything else — a
 * balcony with a chamfered corner, a room with a niche.
 *
 * The preview is the same component the dashboard draws, fed with the edited
 * values. Numbers in metres are hard to picture; seeing the room move while
 * typing is what makes this usable at all.
 *
 * Nothing is saved until the room's button is pressed, and each room saves on
 * its own: a mistyped corner in one room must not block the others.
 */

const num = (value) => {
    const n = Number(String(value).replace(",", "."))
    return Number.isFinite(n) ? n : null
}

export default function FloorplanSettings({ rooms, onChanged }) {
    const [drafts, setDrafts] = useState({})
    const [busy, setBusy] = useState(null)
    const [message, setMessage] = useState("")
    const [error, setError] = useState("")

    /* The preview room list: saved values, overlaid with whatever is being
       edited right now. Invalid input leaves the room out of the preview
       instead of drawing nonsense. */
    const preview = useMemo(() => (rooms || []).map(room => {
        const draft = drafts[room.id]
        if (!draft) return room
        const points = draft.mode === "rect"
            ? (() => {
                const r = { x: num(draft.x), y: num(draft.y), w: num(draft.w), h: num(draft.h) }
                if (Object.values(r).some(v => v === null) || r.w <= 0 || r.h <= 0) return null
                return rectPoints(r)
            })()
            : parsePoints(draft.text)
        return { ...room, shape_points: points, outdoor: draft.outdoor }
    }), [rooms, drafts])

    function draftFor(room) {
        if (drafts[room.id]) return drafts[room.id]
        const rect = asRect(room.shape_points)
        return rect
            ? { mode: "rect", x: rect.x, y: rect.y, w: rect.w, h: rect.h,
                text: JSON.stringify(room.shape_points || []), outdoor: !!room.outdoor }
            : { mode: room.shape_points ? "points" : "rect",
                x: 0, y: 0, w: 3, h: 3,
                text: room.shape_points ? JSON.stringify(room.shape_points) : "",
                outdoor: !!room.outdoor }
    }

    function patch(room, change) {
        setDrafts(prev => ({ ...prev, [room.id]: { ...draftFor(room), ...change } }))
        setMessage("")
        setError("")
    }

    function pointsOf(room) {
        const draft = draftFor(room)
        if (draft.mode !== "rect") return parsePoints(draft.text)
        const r = { x: num(draft.x), y: num(draft.y), w: num(draft.w), h: num(draft.h) }
        if (Object.values(r).some(v => v === null) || r.w <= 0 || r.h <= 0) return null
        return rectPoints(r)
    }

    async function save(room, { centreLabel = false } = {}) {
        const points = pointsOf(room)
        if (!points) {
            setError(`${room.name}: die Eingabe ergibt keine Fläche.`)
            return
        }
        setBusy(room.id)
        setError("")
        try {
            const body = { shape_points: points, outdoor: draftFor(room).outdoor }
            // shape_label wird bewusst nur auf Wunsch angefasst: wer die
            // Beschriftung von Hand verschoben hat, verliert sie nicht beim
            // Korrigieren eines Maßes. null heißt "Schwerpunkt verwenden".
            if (centreLabel) body.shape_label = null
            await updateRoom(room.id, body)
            setDrafts(prev => {
                const next = { ...prev }
                delete next[room.id]
                return next
            })
            setMessage(`${room.name} gespeichert.`)
            onChanged()
        } catch (e) {
            setError(`${room.name}: ${e.message}`)
        } finally {
            setBusy(null)
        }
    }

    async function clear(room) {
        setBusy(room.id)
        setError("")
        try {
            await updateRoom(room.id, { shape_points: null })
            setDrafts(prev => {
                const next = { ...prev }
                delete next[room.id]
                return next
            })
            setMessage(`${room.name} hat keine Fläche mehr.`)
            onChanged()
        } catch (e) {
            setError(`${room.name}: ${e.message}`)
        } finally {
            setBusy(null)
        }
    }

    const withoutShape = (rooms || []).filter(r => !r.shape_points).length

    return (
        <div className="home-card">
            <div className="home-card-header">
                <h4>Grundriss</h4>
                <span className="home-meta">
                    {(rooms || []).length - withoutShape} von {(rooms || []).length} Räumen im Plan
                </span>
            </div>

            <p className="home-empty">
                Maße in Metern, Ursprung oben links, y läuft nach unten. Ein Balkon liegt
                außerhalb und bekommt ein negatives y sowie den Haken „außen". Räume ohne
                Fläche erscheinen in den Listen, aber nicht im Plan.
            </p>

            <Floorplan rooms={preview} title="Vorschau" />

            <div className="fps-rooms">
                {(rooms || []).map(room => {
                    const draft = draftFor(room)
                    const points = pointsOf(room)
                    const dirty = !!drafts[room.id]
                    return (
                        <div className="fps-room" key={room.id} data-dirty={dirty}>
                            <div className="fps-room-head">
                                <strong>{room.name}</strong>
                                <span className="home-meta home-num">
                                    {points ? `${polygonArea(points).toFixed(2)} m²` : "keine Fläche"}
                                    {room.area_m2 ? ` · angegeben ${room.area_m2} m²` : ""}
                                </span>
                                <span className="fps-spacer" />
                                <label className="fps-inline">
                                    <input type="checkbox" checked={draft.outdoor}
                                           onChange={e => patch(room, { outdoor: e.target.checked })} />
                                    außen
                                </label>
                                <button className="home-btn" onClick={() => patch(room, {
                                    mode: draft.mode === "rect" ? "points" : "rect",
                                    text: draft.mode === "rect" && points ? JSON.stringify(points) : draft.text,
                                })}>
                                    {draft.mode === "rect" ? "Punkte" : "Rechteck"}
                                </button>
                            </div>

                            {draft.mode === "rect" ? (
                                <div className="fps-grid">
                                    {[["x", "x"], ["y", "y"], ["w", "Breite"], ["h", "Höhe"]].map(([field, label]) => (
                                        <label className="home-field" key={field}>{label}
                                            <input type="number" step="0.01" value={draft[field]}
                                                   onChange={e => patch(room, { [field]: e.target.value })} />
                                        </label>
                                    ))}
                                </div>
                            ) : (
                                <label className="home-field">Ecken
                                    <input value={draft.text} spellCheck="false"
                                           placeholder="[[0,0],[4,0],[4,3],[0,3]] oder 0 0 4 0 4 3 0 3"
                                           onChange={e => patch(room, { text: e.target.value })} />
                                </label>
                            )}

                            <div className="home-form-actions">
                                <button className="home-btn primary" disabled={busy === room.id || !points}
                                        onClick={() => save(room)}>Speichern</button>
                                <button className="home-btn" disabled={busy === room.id || !points}
                                        onClick={() => save(room, { centreLabel: true })}>
                                    Speichern, Beschriftung zentrieren
                                </button>
                                {room.shape_points && (
                                    <button className="home-btn" disabled={busy === room.id}
                                            onClick={() => clear(room)}>Fläche entfernen</button>
                                )}
                            </div>
                        </div>
                    )
                })}
            </div>

            {message && <p className="home-meta">{message}</p>}
            {error && <p className="home-error">{error}</p>}
        </div>
    )
}
