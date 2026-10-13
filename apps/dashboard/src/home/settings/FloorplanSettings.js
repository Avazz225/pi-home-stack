import { useMemo, useState } from "react"
import { updateRoom, saveSettings } from "../api"
import Floorplan from "../floorplan/Floorplan"
import GridEditor from "./GridEditor"
import { boundsOf, moveTo, parsePoints, polygonArea } from "../floorplan/shapes"

/* Editing the flat's geometry.
 *
 * Three views on the same polygon, each for a different moment:
 *
 *   the canvas          rough shaping - draw, drag, pull a wall out into an L
 *   the wall list       exact lengths, inside the canvas where the walls are
 *   position + corners  where the room sits, and the raw numbers for pasting
 *
 * There used to be a rectangle mode with width and height fields. The wall list
 * replaced it: wall 1 and wall 2 of a rectangle *are* its width and height, and
 * the list works for an L-shaped room as well. What the lengths cannot say is
 * where the room sits, so position stayed.
 *
 * None of the views is the authoritative one, and nothing is written until the
 * room's own save button is pressed. Each room saves separately: a mistyped
 * corner in one must not hold up the others.
 */

const num = (value) => {
    const n = Number(String(value).replace(",", "."))
    return Number.isFinite(n) ? n : null
}
const tidy = (value) => Math.round(value * 1000) / 1000

export default function FloorplanSettings({ rooms, settings, onSaved, onChanged }) {
    const [drafts, setDrafts] = useState({})
    const [selectedId, setSelectedId] = useState(null)
    /* Quarter metres: fine enough for a wall, coarse enough that a rough drag
       lands on a round number. */
    const [step, setStep] = useState(0.25)
    const [busy, setBusy] = useState(null)
    const [message, setMessage] = useState("")
    const [error, setError] = useState("")
    const [inner, setInner] = useState(settings?.wall_inner ?? "0.115")
    const [outer, setOuter] = useState(settings?.wall_outer ?? "0.24")

    function draftFor(room) {
        return drafts[room.id] || {
            points: Array.isArray(room.shape_points) ? room.shape_points : null,
            text: room.shape_points ? JSON.stringify(room.shape_points) : "",
            outdoor: !!room.outdoor,
        }
    }

    function patch(room, change) {
        setDrafts(prev => ({ ...prev, [room.id]: { ...draftFor(room), ...change } }))
        setMessage("")
        setError("")
    }

    /* Setting the polygon keeps the text field in step, so switching between the
       canvas and the raw numbers never shows two different rooms. */
    function setPoints(room, points) {
        patch(room, { points, text: points ? JSON.stringify(points) : "" })
    }

    const preview = useMemo(() => (rooms || []).map(room => {
        const draft = drafts[room.id]
        if (!draft) return room
        return { ...room, shape_points: draft.points, outdoor: draft.outdoor }
    }), [rooms, drafts])

    async function save(room, { centreLabel = false } = {}) {
        const draft = draftFor(room)
        if (!draft.points || draft.points.length < 3) {
            setError(`${room.name}: ohne Fläche gibt es nichts zu speichern.`)
            return
        }
        setBusy(room.id)
        setError("")
        try {
            const body = { shape_points: draft.points, outdoor: draft.outdoor }
            /* shape_label is left alone unless asked: a label moved by hand
               should survive correcting a wall length. null means "use the
               centroid". */
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

    const drawn = (rooms || []).filter(r => r.shape_points).length

    return (
        <div className="home-card">
            <div className="home-card-header">
                <h4>Grundriss</h4>
                <span className="home-meta">{drawn} von {(rooms || []).length} Räumen im Plan</span>
            </div>

            <p className="home-empty">
                Maße in Metern, Ursprung oben links, y läuft nach unten. Ein Balkon liegt
                außerhalb und bekommt den Haken „außen". Räume ohne Fläche erscheinen in den
                Listen, aber nicht im Plan.
            </p>

            <GridEditor
                rooms={preview}
                selectedId={selectedId}
                onSelect={room => setSelectedId(room.id)}
                onPoints={setPoints}
                step={step}
                onStep={setStep}
            />

            <div className="fps-rooms">
                {(rooms || []).map(room => {
                    const draft = draftFor(room)
                    const points = draft.points
                    const bounds = points && points.length >= 3 ? boundsOf(points) : null
                    const dirty = !!drafts[room.id]
                    return (
                        <div className="fps-room" key={room.id} data-dirty={dirty}
                             data-selected={room.id === selectedId}
                             onClick={() => setSelectedId(room.id)}>
                            <div className="fps-room-head">
                                <strong>{room.name}</strong>
                                <span className="home-meta home-num">
                                    {points ? `${polygonArea(points).toFixed(2)} m²` : "keine Fläche"}
                                    {room.area_m2 ? ` · angegeben ${room.area_m2} m²` : ""}
                                    {points ? ` · ${points.length} Ecken` : ""}
                                </span>
                                <span className="fps-spacer" />
                                <label className="fps-inline">
                                    <input type="checkbox" checked={draft.outdoor}
                                           onChange={e => patch(room, { outdoor: e.target.checked })} />
                                    außen
                                </label>
                            </div>

                            {bounds && (
                                <div className="fps-grid">
                                    <label className="home-field">Position x
                                        <input type="number" step="0.01" value={tidy(bounds.x)}
                                               onChange={e => {
                                                   const v = num(e.target.value)
                                                   if (v !== null) setPoints(room, moveTo(points, v, bounds.y))
                                               }} />
                                    </label>
                                    <label className="home-field">Position y
                                        <input type="number" step="0.01" value={tidy(bounds.y)}
                                               onChange={e => {
                                                   const v = num(e.target.value)
                                                   if (v !== null) setPoints(room, moveTo(points, bounds.x, v))
                                               }} />
                                    </label>
                                    <span className="home-meta fps-extent">
                                        {tidy(bounds.w)} × {tidy(bounds.h)} m
                                    </span>
                                </div>
                            )}

                            <label className="home-field">Ecken
                                <input value={draft.text} spellCheck="false"
                                       placeholder="[[0,0],[4,0],[4,3],[0,3]] oder 0 0 4 0 4 3 0 3"
                                       onChange={e => patch(room, {
                                           text: e.target.value,
                                           points: parsePoints(e.target.value),
                                       })} />
                            </label>

                            <div className="home-form-actions">
                                <button className="home-btn primary"
                                        disabled={busy === room.id || !points}
                                        onClick={() => save(room)}>Speichern</button>
                                <button className="home-btn"
                                        disabled={busy === room.id || !points}
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

            <div className="home-section">
                <span className="home-meta">Wandstärken</span>
                <p className="home-empty">
                    Nur für die Darstellung — die Räume kacheln die Wohnung, und eine Wand ist
                    eine Kante zwischen zwei Räumen. Welche innen und welche außen liegt,
                    erkennt der Plan selbst: eine Kante, an der ein anderer Raum anliegt, ist
                    innen. Grenzt sie an etwas Außenliegendes wie den Balkon, gilt sie als
                    Außenwand — das ist dort die Gebäudehülle.
                </p>
                <div className="fps-grid">
                    <label className="home-field">Innenwand (m)
                        <input type="number" step="0.005" min="0.01" max="0.6"
                               value={inner} onChange={e => setInner(e.target.value)} />
                    </label>
                    <label className="home-field">Außenwand (m)
                        <input type="number" step="0.005" min="0.01" max="0.6"
                               value={outer} onChange={e => setOuter(e.target.value)} />
                    </label>
                    <div className="home-form-actions fps-extent">
                        <button className="home-btn primary" disabled={busy === "walls"}
                                onClick={async () => {
                                    setBusy("walls"); setError("")
                                    try {
                                        await saveSettings({ wall_inner: inner, wall_outer: outer })
                                        setMessage("Wandstärken gespeichert.")
                                        onSaved ? onSaved() : onChanged()
                                    } catch (e) {
                                        setError(e.message)
                                    } finally { setBusy(null) }
                                }}>Speichern</button>
                    </div>
                </div>
            </div>

            <Floorplan rooms={preview} walls={{
                inner: Number(inner) || 0.115,
                outer: Number(outer) || 0.24,
            }} title="So sieht es im Dashboard aus" />

            {message && <p className="home-meta">{message}</p>}
            {error && <p className="home-error">{error}</p>}
        </div>
    )
}
