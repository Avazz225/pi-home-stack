import { ROOM_SHAPES, BUILDING_OUTLINE, VIEW_BOX, toPath } from "./shapes"
import "./floorplan.css"

/* The plan is navigation, not a control surface: tapping a room selects it and
   the controls live in the panel beside it. On a phone a lamp toggle drawn into
   a 2 m² room would be a coin-sized target right next to six others.

   mode "single" selects one room, "multi" collects a set — the vacuum view uses
   the same plan to pick which rooms to clean. */
export default function Floorplan({ rooms, selected = [], onSelect, mode = "single", title }) {
    const byKey = Object.fromEntries(rooms.map(r => [r.key, r]))
    const selectedIds = new Set(selected)

    return (
        <div className="fp-wrap">
            {title && <span className="home-meta fp-title">{title}</span>}
            <svg
                className="fp-svg"
                viewBox={`${VIEW_BOX.x} ${VIEW_BOX.y} ${VIEW_BOX.width} ${VIEW_BOX.height}`}
                role="group"
                aria-label="Grundriss der Wohnung"
            >
                <polygon className="fp-outline" points={toPath(BUILDING_OUTLINE)} />

                {Object.entries(ROOM_SHAPES).map(([key, shape]) => {
                    const room = byKey[key]
                    if (!room) return null
                    const isSelected = selectedIds.has(room.id)
                    const lightsOn = room.lights && room.lights.on > 0
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
                            <text className="fp-room-name" x={shape.label[0]} y={shape.label[1]}>{room.name}</text>
                            <text className="fp-room-meta" x={shape.label[0]} y={shape.label[1] + 0.33}>
                                {room.area_m2} m²
                            </text>
                            <RoomBadges room={room} x={shape.label[0]} y={shape.label[1] + 0.78} />
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
