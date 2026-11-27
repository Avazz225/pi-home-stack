import { useMemo } from "react"
import { roomShapes, viewBoxFor, toPath, classifyWalls } from "./shapes"
import "./floorplan.css"

/* The plan is navigation, not a control surface: tapping a room selects it and
   the controls live in the panel beside it. On a phone a lamp toggle drawn into
   a 2 m² room would be a coin-sized target right next to six others.

   mode "single" selects one room, "multi" collects a set — the vacuum view uses
   the same plan to pick which rooms to clean. */
/* Wall thicknesses in metres. Defaults for the callers that have no settings to
   hand - the vacuum view and the editor preview - so a missing value draws a
   plausible wall rather than none. */
const DEFAULT_WALLS = { inner: 0.115, outer: 0.24 }

/* How strong the warmest and coldest room may be tinted. Low, because the
   label on top of it has to stay readable and because the tint is a hint
   rather than a reading - the number is written in the room. */
const TINT = 0.18

/* The least spread worth colouring, in kelvin. A flat whose rooms differ by a
   tenth of a degree is an even flat; stretching that across the whole scale
   would turn measurement noise into a picture of a problem. */
const MIN_SPREAD_K = 1.0

/* How far from the middle counts as fully out of step. Fixed, not derived
   from the spread - dividing by the observed range meant the coldest and
   warmest rooms sat at full saturation in every flat, however even it was,
   because the extremes define the range they are measured against. Two
   kelvin from the middle of the flat is a room somebody would notice walking
   into it. */
const FULL_SCALE_K = 2.0

/* Where each room sits on a cold-to-warm scale, as -1 .. +1 around the middle
   of what this flat is actually doing.
 *
 * Diverging around the flat's own middle rather than mapped onto fixed
 * temperatures: 21 °C is neither warm nor cold in the abstract, it is warm in
 * a flat where everything else is 19 and cold in one where everything else is
 * 23. The useful question on a floorplan is which room is out of step.
 *
 * Returns an empty map when fewer than two rooms report, or when they all
 * agree - no tint at all beats a tint that means nothing. */
function heatByRoom(rooms) {
    const temps = (rooms || [])
        .map(r => [r.id, (r.climate || {}).temperature])
        .filter(([, t]) => typeof t === "number")
    if (temps.length < 2) return {}
    const values = temps.map(([, t]) => t)
    const low = Math.min(...values)
    const high = Math.max(...values)
    if (high - low < MIN_SPREAD_K) return {}
    const middle = (low + high) / 2
    /* At least FULL_SCALE_K, so an even flat stays pale and only a genuinely
       deviant room reaches the end of the scale. Never less, or the range
       normalises itself and every flat looks equally extreme. */
    const half = Math.max(FULL_SCALE_K, (high - low) / 2)
    return Object.fromEntries(temps.map(([id, t]) =>
        [id, Math.max(-1, Math.min(1, (t - middle) / half))]))
}

export default function Floorplan({ rooms, selected = [], onSelect, mode = "single", title,
                                    walls = DEFAULT_WALLS }) {
    const byKey = Object.fromEntries((rooms || []).map(r => [r.key, r]))
    const heat = useMemo(() => heatByRoom(rooms), [rooms])
    const selectedIds = new Set(selected)
    /* Geometry comes with the rooms, so the plan rebuilds itself when a room is
       edited. The viewBox follows from the shapes rather than from a constant
       that would have to be kept in step with them. */
    const shapes = useMemo(() => roomShapes(rooms), [rooms])
    const viewBox = useMemo(() => viewBoxFor(shapes), [shapes])
    /* Which edge is a partition and which faces outside. Derived from the rooms
       themselves, so moving a room changes its walls with it. */
    const wallsByRoom = useMemo(() => classifyWalls(rooms), [rooms])

    /* No room carries geometry yet. An empty frame says nothing, so say what is
       missing and where to fix it - the rooms themselves are listed beside the
       plan either way. */
    if (Object.keys(shapes).length === 0) {
        return (
            <div className="fp-wrap">
                {title && <span className="home-meta fp-title">{title}</span>}
                <p className="home-meta fp-empty">
                    Für diese Wohnung ist noch kein Grundriss hinterlegt. Unter
                    „Einstellungen" lässt sich je Raum eine Fläche eintragen.
                </p>
            </div>
        )
    }

    /* The scale the tints are read against. Without it the colours are
       decoration; with it they are a reading - and it only appears when
       something is actually tinted. */
    const tinted = Object.values(heat).some(v => Math.abs(v) > 0.05)
    const temps = (rooms || []).map(r => (r.climate || {}).temperature)
                               .filter(t => typeof t === "number")

    return (
        <div className="fp-wrap">
            <div className="fp-head">
                <span className="home-meta fp-title">{title || "Grundriss"}</span>
                {tinted && temps.length > 1 && (
                    <span className="fp-scale" aria-hidden>
                        <span className="fp-scale-bar" />
                        <span className="fp-scale-end">
                            {Math.min(...temps).toFixed(0)}°
                        </span>
                        <span className="fp-scale-end">
                            {Math.max(...temps).toFixed(0)}°
                        </span>
                    </span>
                )}
            </div>
            <svg
                className="fp-svg"
                viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
                role="group"
                aria-label="Grundriss der Wohnung"
            >
                {/* Walls above the room fills so they read as walls, below
                    the labels so they never cut through a name.

                    Drawn centred on the edge, which means two neighbouring
                    rooms each draw the same line - the same geometry at the
                    same width, so it looks like one wall, and neither room has
                    to know it is the second one there.

                    No non-scaling-stroke here, unlike the grid: a wall is
                    11.5 cm wide in the flat and has to shrink with the plan. */}
                <g className="fp-walls">
                    {(rooms || []).flatMap(room => (wallsByRoom[room.id] || []).map((wall, i) => (
                        <line key={`${room.id}-${i}`}
                              x1={wall.a[0]} y1={wall.a[1]} x2={wall.b[0]} y2={wall.b[1]}
                              strokeWidth={wall.interior ? walls.inner : walls.outer}
                              data-interior={wall.interior} />
                    )))}
                </g>

                {Object.entries(shapes).map(([key, shape]) => {
                    const room = byKey[key]
                    if (!room) return null
                    const isSelected = selectedIds.has(room.id)
                    const lightsOn = room.lights && room.lights.on > 0
                    const warmth = heat[room.id] || 0
                    const climate = room.climate || {}
                    const power = (room.plugs || {}).power_w
                    return (
                        <g
                            key={key}
                            className="fp-room"
                            data-selected={isSelected}
                            data-outdoor={!!shape.outdoor}
                            data-lights-on={lightsOn}
                            onClick={() => onSelect && onSelect(room)}
                            role="button"
                            tabIndex={0}
                            aria-pressed={isSelected}
                            aria-label={`${room.name}, ${room.area_m2} Quadratmeter`}
                            onKeyDown={e => {
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault()
                                    onSelect && onSelect(room)
                                }
                            }}
                        >
                            <polygon className="fp-room-shape" points={toPath(shape.points)} />
                            {/* The tint is its own layer over the room's fill, so the
                                shape keeps one surface colour and only the wash
                                changes. Opacity is the datum, so it is set here;
                                the hue comes from a token. */}
                            {warmth < 0 && (
                                <polygon className="fp-room-tint" data-side="cold"
                                         points={toPath(shape.points)}
                                         opacity={-warmth * TINT} />
                            )}
                            {warmth > 0 && (
                                <polygon className="fp-room-tint" data-side="hot"
                                         points={toPath(shape.points)}
                                         opacity={warmth * TINT} />
                            )}
                            <text className="fp-room-name" x={shape.label[0]} y={shape.label[1]}>{room.name}</text>
                            {/* The temperature where the area used to be. A room's
                                size never changes and is in the settings; what it is
                                doing right now is the reason to look at a floorplan. */}
                            <text className="fp-room-meta" x={shape.label[0]} y={shape.label[1] + 0.33}>
                                {climate.temperature != null
                                    ? `${climate.temperature.toFixed(1).replace(".", ",")} °C`
                                    : `${room.area_m2} m²`}
                            </text>
                            {power != null && power > 0 && (
                                <text className="fp-room-power" x={shape.label[0]} y={shape.label[1] + 0.62}>
                                    {Math.round(power)} W
                                </text>
                            )}
                            <RoomBadges room={room} x={shape.label[0]}
                                        y={shape.label[1] + (power != null && power > 0 ? 1.0 : 0.78)} />
                            {mode === "multi" && isSelected && (
                                <text className="fp-check" x={shape.label[0]} y={shape.label[1] - 0.55}>✓</text>
                            )}
                        </g>
                    )
                })}
            </svg>
        </div>
    )
}

/* One compact row under the room name. Each badge carries its own number, so the
   colour is never the only thing saying what the state is.

   Every badge declares its width and draws from its own left edge; the row is
   then centred as a whole. Laying them out from their centres instead lets a
   badge whose content is not symmetric — the lamp dot plus its count — run into
   its neighbour. */
const BADGE_GAP = 0.18

function RoomBadges({ room, x, y }) {
    const badges = []

    if (room.lights && room.lights.bound > 0) {
        badges.push({
            key: "lights",
            width: 0.92,
            render: (
                <g className="fp-badge" data-on={room.lights.on > 0}>
                    <circle className="fp-badge-dot" cx={0.13} cy={-0.1} r={0.13} />
                    <text className="fp-badge-text" x={0.33} y={0}>{room.lights.on}/{room.lights.bound}</text>
                </g>
            ),
        })
    }
    if (room.vacuum_rooms && room.vacuum_rooms.length > 0) {
        badges.push({
            key: "vacuum",
            width: 0.26,
            render: (
                <g className="fp-badge">
                    <rect className="fp-badge-square" x={0} y={-0.24} width={0.26} height={0.26} rx={0.07} />
                </g>
            ),
        })
    }
    if (badges.length === 0) return null

    const total = badges.reduce((sum, b) => sum + b.width, 0) + BADGE_GAP * (badges.length - 1)
    let cursor = -total / 2
    return (
        <g transform={`translate(${x} ${y})`}>
            {badges.map(badge => {
                const left = cursor
                cursor += badge.width + BADGE_GAP
                return <g key={badge.key} transform={`translate(${left} 0)`}>{badge.render}</g>
            })}
        </g>
    )
}
