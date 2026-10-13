import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
    polygonArea, rectPoints, movePoint, insertVertex, removeVertex,
    edgeLength, setEdgeLength, snapTargets, snapCorrection,
} from "../floorplan/shapes"
import "./grideditor.css"

/* Drawing the flat on a grid.
 *
 * Metres in a number field are hard to picture; a shape you drag is not. The
 * canvas is the rough pass and the wall list underneath is the exact one, and
 * both edit the same polygon — neither is the authoritative view.
 *
 * Everything is a polygon. A rectangle is one with four corners, so there is no
 * separate rectangle mode and no "convert" button: dragging a corner resizes,
 * dragging a wall's midpoint turns a rectangle into an L, and the wall list
 * takes exact lengths.
 *
 * Coordinates: pointer positions arrive in screen pixels and have to go through
 * the SVG's own matrix. Dividing by a stored scale factor looks simpler and
 * breaks as soon as the element is scrolled, zoomed by the browser, or laid out
 * at a size that differs from its viewBox.
 */

const GRID_STEPS = [0.1, 0.25, 0.5]
const HANDLE = 0.2
const MIN_SIDE = 0.4

/* The canvas always covers the rooms and always at least this, so there is
   empty grid to draw the first room on. */
const MIN_EXTENT = { x: 0, y: -2, width: 11, height: 10 }

const snap = (value, step) => Math.round(value / step) * step
/* How close a wall has to come to a neighbour's before it is pulled onto it.
   Wide enough to catch a rough drag, narrow enough that 30 cm away stays 30 cm
   away - at that distance the operator meant it. */
const SNAP_REACH = 0.18
/* Rounded to the millimetre: a float out of a division would otherwise show up
   as 3.7000000000000006 in a number field. */
const tidy = (value) => Math.round(value * 1000) / 1000
const tidyPoints = (points) => points.map(([x, y]) => [tidy(x), tidy(y)])

export default function GridEditor({ rooms, selectedId, onSelect, onPoints, step, onStep }) {
    const svgRef = useRef(null)
    const [drag, setDrag] = useState(null)
    const [focusEdge, setFocusEdge] = useState(null)
    const [hint, setHint] = useState("")
    const edgeInputs = useRef({})

    const selected = (rooms || []).find(r => r.id === selectedId) || null
    const points = selected && Array.isArray(selected.shape_points) && selected.shape_points.length >= 3
        ? selected.shape_points
        : null

    useEffect(() => { setFocusEdge(null) }, [selectedId])

    const view = useMemo(() => {
        let minX = MIN_EXTENT.x, minY = MIN_EXTENT.y
        let maxX = MIN_EXTENT.x + MIN_EXTENT.width, maxY = MIN_EXTENT.y + MIN_EXTENT.height
        for (const room of rooms || []) {
            for (const [x, y] of room.shape_points || []) {
                minX = Math.min(minX, x); maxX = Math.max(maxX, x)
                minY = Math.min(minY, y); maxY = Math.max(maxY, y)
            }
        }
        const pad = 0.6
        return { x: minX - pad, y: minY - pad,
                 width: (maxX - minX) + 2 * pad, height: (maxY - minY) + 2 * pad }
    }, [rooms])

    const toUser = useCallback((event) => {
        const svg = svgRef.current
        if (!svg) return null
        const ctm = svg.getScreenCTM()
        if (!ctm) return null
        const point = svg.createSVGPoint()
        point.x = event.clientX
        point.y = event.clientY
        const local = point.matrixTransform(ctm.inverse())
        return { x: local.x, y: local.y }
    }, [])

    function begin(event, kind, index) {
        if (!selected) { setHint("Erst einen Raum in der Liste auswählen."); return }
        const at = toUser(event)
        if (!at) return
        event.currentTarget.setPointerCapture?.(event.pointerId)
        event.preventDefault()
        event.stopPropagation()
        setHint("")

        // Pulling a wall's midpoint means: insert a corner there, then drag it.
        if (kind === "edge-mid") {
            const grown = insertVertex(points, index)
            setDrag({ kind: "vertex", index: index + 1, start: at, points: grown })
            return
        }
        setDrag({ kind, index, start: at, points: points ? points.map(p => [...p]) : null })
    }

    /* Coordinates of every other room, to snap against. The grid alone does not
       make rooms meet: with a 0.25 m grid and a neighbour's wall at 3.965, the
       grid leaves a seam of three and a half centimetres that is not in the
       flat. */
    const targets = useMemo(() => snapTargets(rooms, selectedId), [rooms, selectedId])

    /* The polygon the drag currently describes. Computed from the pointer every
       time rather than stored, so what is drawn and what gets saved cannot
       drift apart. */
    const live = useMemo(() => {
        if (!drag) return null
        const at = drag.now || drag.start

        // Grid first, neighbours second: lining up with the neighbour is what
        // the operator means, the grid is only a convenience, so the neighbour
        // correction is applied on top and wins.
        const withSnap = (polygon) => {
            const { dx, dy } = snapCorrection(polygon, targets, SNAP_REACH)
            if (dx === 0 && dy === 0) return polygon
            return polygon.map(([x, y]) => [x + dx, y + dy])
        }

        if (drag.kind === "draw") {
            const x1 = snap(drag.start.x, step), y1 = snap(drag.start.y, step)
            const x2 = snap(at.x, step), y2 = snap(at.y, step)
            return withSnap(rectPoints({ x: Math.min(x1, x2), y: Math.min(y1, y2),
                                         w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }))
        }
        if (!drag.points) return null
        if (drag.kind === "vertex") {
            const moved = [snap(at.x, step), snap(at.y, step)]
            const { dx, dy } = snapCorrection([moved], targets, SNAP_REACH)
            return movePoint(drag.points, drag.index, [moved[0] + dx, moved[1] + dy])
        }
        if (drag.kind === "move") {
            const dx = snap(at.x - drag.start.x, step)
            const dy = snap(at.y - drag.start.y, step)
            return withSnap(drag.points.map(([x, y]) => [x + dx, y + dy]))
        }
        return null
    }, [drag, step, targets])

    function finish() {
        const result = live
        setDrag(null)
        if (!result || !selected) return
        const area = polygonArea(result)
        if (area < MIN_SIDE * MIN_SIDE) {
            setHint(`Zu klein — unter ${(MIN_SIDE * MIN_SIDE).toFixed(2)} m² ist eher ein Verrutschen als ein Raum.`)
            return
        }
        onPoints(selected, tidyPoints(result))
    }

    function dropVertex(index) {
        if (!points) return
        if (points.length <= 3) {
            setHint("Drei Ecken sind das Minimum für eine Fläche.")
            return
        }
        onPoints(selected, tidyPoints(removeVertex(points, index)))
    }

    function applyEdge(index, raw) {
        const value = Number(String(raw).replace(",", "."))
        if (!Number.isFinite(value) || value <= 0) {
            setHint("Keine brauchbare Länge.")
            return
        }
        setHint("")
        onPoints(selected, tidyPoints(setEdgeLength(points, index, value)))
    }

    const shown = live || points
    const gridLines = []
    for (let x = Math.ceil(view.x); x <= view.x + view.width; x += 1) {
        gridLines.push(<line key={`v${x}`} x1={x} y1={view.y} x2={x} y2={view.y + view.height}
                             className="ge-grid" data-zero={x === 0} />)
    }
    for (let y = Math.ceil(view.y); y <= view.y + view.height; y += 1) {
        gridLines.push(<line key={`h${y}`} x1={view.x} y1={y} x2={view.x + view.width} y2={y}
                             className="ge-grid" data-zero={y === 0} />)
    }

    return (
        <div className="ge-wrap">
            <div className="ge-bar">
                <span className="home-meta">Raster</span>
                {GRID_STEPS.map(s => (
                    <button key={s} className="home-btn" data-active={s === step}
                            onClick={() => onStep(s)}>{s} m</button>
                ))}
                <span className="fps-spacer" />
                <span className="home-meta">
                    {selected ? selected.name : "kein Raum ausgewählt"}
                </span>
            </div>

            <svg
                ref={svgRef}
                className="ge-svg"
                viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
                onPointerDown={e => { if (e.target === e.currentTarget) begin(e, "draw") }}
                onPointerMove={e => {
                    if (!drag) return
                    const at = toUser(e)
                    if (at) setDrag(d => (d ? { ...d, now: at } : d))
                }}
                onPointerUp={finish}
                onPointerCancel={() => setDrag(null)}
                role="application"
                aria-label="Grundriss zeichnen"
            >
                <g className="ge-grid-layer">{gridLines}</g>

                {/* Every room, so the one being edited has its neighbours to
                    line up against - that is most of what a plan is for. */}
                {(rooms || []).map(room => {
                    const polygon = room.id === selectedId ? shown : room.shape_points
                    if (!Array.isArray(polygon) || polygon.length < 3) return null
                    const isSelected = room.id === selectedId
                    const label = polygon.reduce((acc, p) => [acc[0] + p[0] / polygon.length,
                                                              acc[1] + p[1] / polygon.length], [0, 0])
                    return (
                        <g key={room.id} className="ge-room"
                           data-selected={isSelected} data-outdoor={!!room.outdoor}>
                            <polygon
                                points={polygon.map(([x, y]) => `${x},${y}`).join(" ")}
                                onPointerDown={e => {
                                    if (!isSelected) { e.stopPropagation(); onSelect(room); return }
                                    begin(e, "move")
                                }}
                            />
                            <text x={label[0]} y={label[1]}>{room.name}</text>
                            {isSelected && (
                                <text className="ge-area" x={label[0]} y={label[1] + 0.4}>
                                    {polygonArea(polygon).toFixed(2)} m²
                                </text>
                            )}
                        </g>
                    )
                })}

                {/* Handles only on the selected room: four per room everywhere
                    would turn the plan into a field of dots. Hidden while
                    dragging, where they would chase the pointer. */}
                {selected && shown && !drag && shown.map(([x, y], index) => (
                    <rect key={`p${index}`} className="ge-handle"
                          x={x - HANDLE / 2} y={y - HANDLE / 2} width={HANDLE} height={HANDLE}
                          onPointerDown={e => begin(e, "vertex", index)}
                          onDoubleClick={e => { e.stopPropagation(); dropVertex(index) }} />
                ))}

                {/* An explicit grab point in the middle. Dragging anywhere
                    inside the room works too, but nothing on the screen says
                    so - and a corner handle right next to the edge makes it
                    easy to grab the wrong thing. */}
                {selected && shown && !drag && (() => {
                    const c = shown.reduce((acc, p) => [acc[0] + p[0] / shown.length,
                                                        acc[1] + p[1] / shown.length], [0, 0])
                    return <circle className="ge-centre" cx={c[0]} cy={c[1]} r={HANDLE / 1.6}
                                   onPointerDown={e => begin(e, "move")} />
                })()}

                {selected && shown && !drag && shown.map((a, index) => {
                    const b = shown[(index + 1) % shown.length]
                    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
                    return (
                        <circle key={`m${index}`} className="ge-mid"
                                cx={mid[0]} cy={mid[1]} r={HANDLE / 2.2}
                                onPointerDown={e => begin(e, "edge-mid", index)}
                                onDoubleClick={e => {
                                    e.stopPropagation()
                                    setFocusEdge(index)
                                    edgeInputs.current[index]?.focus()
                                    edgeInputs.current[index]?.select()
                                }} />
                    )
                })}
            </svg>

            <p className="home-meta ge-legend">
                Auf freier Fläche ziehen zeichnet ein Rechteck · im Raum ziehen verschiebt ·
                Ecke ziehen formt um · Doppelklick auf eine Ecke entfernt sie ·
                Punkt auf einer Wand ziehen fügt eine Ecke ein, Doppelklick darauf springt
                zur Längenangabe · Wände rasten an den Nachbarräumen ein
            </p>

            {selected && points && (
                <div className="ge-walls">
                    <span className="home-meta">Wandlängen von {selected.name}</span>
                    <div className="ge-wall-grid">
                        {points.map((_, index) => (
                            <label className="home-field ge-wall" key={index}
                                   data-focus={index === focusEdge}>
                                Wand {index + 1}
                                <input
                                    ref={el => { edgeInputs.current[index] = el }}
                                    type="number" step="0.01" min="0.1"
                                    defaultValue={tidy(edgeLength(points, index))}
                                    key={`${index}-${tidy(edgeLength(points, index))}`}
                                    onKeyDown={e => {
                                        if (e.key === "Enter") applyEdge(index, e.currentTarget.value)
                                    }}
                                    onBlur={e => {
                                        const next = Number(e.currentTarget.value)
                                        if (Math.abs(next - edgeLength(points, index)) > 1e-6) {
                                            applyEdge(index, e.currentTarget.value)
                                        }
                                    }}
                                />
                            </label>
                        ))}
                    </div>
                    <span className="home-meta">
                        Eine Länge zu setzen verschiebt nur das hintere Ende dieser Wand —
                        schon gesetzte Wände bleiben, wie sie sind.
                    </span>
                </div>
            )}

            {hint && <p className="home-meta ge-hint">{hint}</p>}
        </div>
    )
}
