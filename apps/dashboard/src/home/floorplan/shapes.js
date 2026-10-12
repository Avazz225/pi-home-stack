/* Floorplan geometry, derived from what the service hands out.
 *
 * This used to be a constant in this file: one flat, hard-coded, in metres. The
 * consequence was that any installation whose rooms differed from the shipped
 * example needed the frontend rebuilt — which defeats shipping a prebuilt
 * bundle in the first place. The geometry now lives in the home service's
 * database, so a flat is data. This module only turns rooms into something an
 * SVG can draw.
 *
 * Coordinates are metres, origin at the top-left inner corner, y running down
 * to match SVG. A room outside the heated envelope — a balcony, a terrace — has
 * negative y and carries the outdoor flag.
 */

export function toPath(points) {
    return points.map(([x, y]) => `${x},${y}`).join(" ")
}

/* Area centroid of a polygon, used when a room has no label position of its
   own. The mean of the corners would drift towards wherever corners cluster;
   the area centroid sits where the room looks like its middle. */
export function centroid(points) {
    let area = 0
    let cx = 0
    let cy = 0
    for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i]
        const [x2, y2] = points[(i + 1) % points.length]
        const cross = x1 * y2 - x2 * y1
        area += cross
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    }
    area /= 2
    if (Math.abs(area) < 1e-9) {
        // A degenerate polygon has no centroid; the average of the corners is
        // at least inside the bounding box and keeps the label on screen.
        const n = points.length || 1
        return [points.reduce((s, p) => s + p[0], 0) / n,
                points.reduce((s, p) => s + p[1], 0) / n]
    }
    return [cx / (6 * area), cy / (6 * area)]
}

/* Rooms that can be drawn, keyed the way the plan iterates them.
 *
 * A room without usable geometry is left out rather than guessed at: it still
 * appears in the lists, it just has no place on the plan yet. Fewer than three
 * corners is not a shape, and the service already rejects that on write — this
 * is the second line, for data that predates the check. */
export function roomShapes(rooms) {
    const shapes = {}
    for (const room of rooms || []) {
        const points = room.shape_points
        if (!Array.isArray(points) || points.length < 3) continue
        if (!points.every(p => Array.isArray(p) && p.length === 2
                               && Number.isFinite(p[0]) && Number.isFinite(p[1]))) continue
        const label = Array.isArray(room.shape_label) && room.shape_label.length === 2
            && Number.isFinite(room.shape_label[0]) && Number.isFinite(room.shape_label[1])
            ? room.shape_label
            : centroid(points)
        shapes[room.key] = { points, label, outdoor: !!room.outdoor }
    }
    return shapes
}

/* The viewBox follows from the shapes, so there is no constant to keep in step
   with them. The margin leaves room for the balcony's label and for the stroke
   around the outermost rooms, which would otherwise be clipped in half. */
export function viewBoxFor(shapes, margin = 0.45) {
    const points = Object.values(shapes).flatMap(s => s.points)
    if (points.length === 0) return { x: 0, y: 0, width: 1, height: 1 }

    const xs = points.map(p => p[0])
    const ys = points.map(p => p[1])
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    return {
        x: minX - margin,
        y: minY - margin,
        width: (Math.max(...xs) - minX) + 2 * margin,
        height: (Math.max(...ys) - minY) + 2 * margin,
    }
}

/* ── Used by the editor ───────────────────────────────────────────────────
 * Pure geometry, kept here rather than in the editor component so a test can
 * import it: this module has no imports of its own, the component pulls in
 * React and the API client. */

/* A rectangle, if the polygon is one. Four corners, every one sitting on the
   bounding box, so each edge runs along an axis. Anything else is not a
   rectangle and gets the corner list instead. */
export function asRect(points) {
    if (!Array.isArray(points) || points.length !== 4) return null
    const xs = points.map(p => p[0])
    const ys = points.map(p => p[1])
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    if (maxX - minX < 1e-9 || maxY - minY < 1e-9) return null
    const onBox = points.every(([x, y]) =>
        (x === minX || x === maxX) && (y === minY || y === maxY))
    if (!onBox) return null
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function rectPoints({ x, y, w, h }) {
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
}

/* Area of a polygon by the shoelace formula, so the editor can say what it
   measures and the operator can compare it with the plan on paper. */
export function polygonArea(points) {
    let sum = 0
    for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i]
        const [x2, y2] = points[(i + 1) % points.length]
        sum += x1 * y2 - x2 * y1
    }
    return Math.abs(sum) / 2
}

/* Corner list from text. Accepts what someone would plausibly type: JSON, or
   bare numbers separated by anything. Returns null on anything unusable rather
   than a half-read polygon. */
export function parsePoints(text) {
    const trimmed = (text || "").trim()
    if (!trimmed) return null
    try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed) && parsed.length >= 3
            && parsed.every(p => Array.isArray(p) && p.length === 2
                                 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))) {
            return parsed.map(p => [Number(p[0]), Number(p[1])])
        }
    } catch {
        // Nicht JSON - dann als Zahlenfolge lesen.
    }
    const numbers = trimmed.split(/[^-0-9.]+/).filter(Boolean).map(Number)
    if (numbers.length < 6 || numbers.length % 2 !== 0 || numbers.some(n => !Number.isFinite(n))) {
        return null
    }
    const points = []
    for (let i = 0; i < numbers.length; i += 2) points.push([numbers[i], numbers[i + 1]])
    return points
}

/* ── Editing a polygon ─────────────────────────────────────────────────────
 * Pure, so the editor stays about pointers and these stay about geometry.
 * Every one returns a new array; none mutates its input, because the editor
 * keeps the previous state for the preview while a drag is in flight. */

export function movePoint(points, index, position) {
    if (!Array.isArray(points) || index < 0 || index >= points.length) return points
    const next = points.map(p => [...p])
    next[index] = [position[0], position[1]]
    return next
}

/* Inserts a corner in the middle of edge `index`, the edge from corner index to
   the next one. That is how a rectangle becomes an L: grab the midpoint of a
   wall and pull it. */
export function insertVertex(points, index) {
    if (!Array.isArray(points) || points.length < 3) return points
    const a = points[index]
    const b = points[(index + 1) % points.length]
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const next = points.map(p => [...p])
    next.splice(index + 1, 0, mid)
    return next
}

/* Three corners are the minimum for an area; removing one from a triangle would
   leave a line, so it is refused rather than silently ignored. */
export function removeVertex(points, index) {
    if (!Array.isArray(points) || points.length <= 3) return points
    const next = points.map(p => [...p])
    next.splice(index, 1)
    return next
}

export function edgeLength(points, index) {
    const a = points[index]
    const b = points[(index + 1) % points.length]
    return Math.hypot(b[0] - a[0], b[1] - a[1])
}

/* Sets the length of edge `index` by moving its far end along the edge, leaving
   the near end where it is.
 *
 * Only that one corner moves. Scaling the whole room instead would be the other
 * plausible reading of "this wall is 3.40 m", but it would move walls the
 * operator just got right - and after adjusting the second wall the first would
 * be wrong again. */
export function setEdgeLength(points, index, length) {
    if (!Array.isArray(points) || points.length < 3) return points
    if (!Number.isFinite(length) || length <= 0) return points
    const i = ((index % points.length) + points.length) % points.length
    const j = (i + 1) % points.length
    const a = points[i]
    const b = points[j]
    const current = Math.hypot(b[0] - a[0], b[1] - a[1])
    // A zero-length edge has no direction to extend along.
    if (current < 1e-9) return points
    const factor = length / current
    const next = points.map(p => [...p])
    next[j] = [a[0] + (b[0] - a[0]) * factor, a[1] + (b[1] - a[1]) * factor]
    return next
}

export function boundsOf(points) {
    const xs = points.map(p => p[0])
    const ys = points.map(p => p[1])
    return { x: Math.min(...xs), y: Math.min(...ys),
             w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

/* Moves the whole polygon so its top-left corner sits at (x, y), keeping its
   shape. This is what "position" means for a room: wall lengths say how big it
   is, this says where it is, and laying rooms against each other needs both. */
export function moveTo(points, x, y) {
    if (!Array.isArray(points) || points.length === 0) return points
    if (!Number.isFinite(x) || !Number.isFinite(y)) return points
    const b = boundsOf(points)
    const dx = x - b.x
    const dy = y - b.y
    return points.map(([px, py]) => [px + dx, py + dy])
}

/* ── Snapping to the neighbours ────────────────────────────────────────────
 *
 * A grid alone does not make rooms meet. With a 0.25 m grid and a wall at
 * 3.965 m, the wall next to it lands a few centimetres off and the plan shows a
 * seam that is not in the flat. So the rooms snap to each other as well, and
 * that wins over the grid: lining up with the neighbour is what the operator
 * means, the grid is only a convenience.
 */

/* Every coordinate worth aligning with: the corners of the other rooms, and
   the distinct x and y values among them — which are their walls wherever a
   wall runs along an axis, and that is almost always. */
export function snapTargets(rooms, excludeId) {
    const xs = new Set()
    const ys = new Set()
    const corners = []
    for (const room of rooms || []) {
        if (room.id === excludeId) continue
        for (const point of room.shape_points || []) {
            if (!Array.isArray(point) || point.length !== 2) continue
            xs.add(point[0])
            ys.add(point[1])
            corners.push(point)
        }
    }
    return { xs: [...xs], ys: [...ys], corners }
}

/* The smallest correction that lines any of `points` up with a target, per
   axis independently — so a room can snap its left wall to a neighbour without
   its top being dragged along. Returns zeros when nothing is within reach. */
export function snapCorrection(points, targets, tolerance = 0.15) {
    let best = { dx: 0, dy: 0 }
    let bestX = tolerance
    let bestY = tolerance
    for (const [x, y] of points || []) {
        for (const tx of targets.xs || []) {
            const d = tx - x
            if (Math.abs(d) < bestX) { bestX = Math.abs(d); best.dx = d }
        }
        for (const ty of targets.ys || []) {
            const d = ty - y
            if (Math.abs(d) < bestY) { bestY = Math.abs(d); best.dy = d }
        }
    }
    return best
}

/* ── Walls ─────────────────────────────────────────────────────────────────
 *
 * The rooms tile the flat, so a wall is not a shape of its own — it is an edge
 * two rooms share, or an edge at the boundary. Drawing them with a thickness is
 * what makes the plan read as a floorplan rather than as coloured tiles, and
 * the two thicknesses differ enough (11.5 cm against 24) to be worth telling
 * apart.
 *
 * Which is which is derived, not configured per edge: an edge another room lies
 * against is interior, anything else faces outside. One exception, and it is
 * the kind that only shows up in a real flat: the edge between a balcony and
 * the room behind it is shared, but it is the building's outer wall. So an edge
 * touching something outdoors counts as exterior however well it is shared.
 */

/* Do these two segments run along the same wall? Parallel, on the same line,
   and overlapping by more than a token touch - two rooms meeting at a corner
   share a point, not a wall. */
export function sharesWall(a1, a2, b1, b2, eps = 0.02) {
    const ax = a2[0] - a1[0], ay = a2[1] - a1[1]
    const bx = b2[0] - b1[0], by = b2[1] - b1[1]
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by)
    if (la < eps || lb < eps) return false
    // Parallel, measured as a normalised cross product so the test does not
    // depend on how long the walls happen to be.
    if (Math.abs((ax * by - ay * bx) / (la * lb)) > 0.02) return false
    // And on the same line, not merely parallel to it.
    if (Math.abs(((b1[0] - a1[0]) * ay - (b1[1] - a1[1]) * ax) / la) > eps) return false

    const along = (p) => ((p[0] - a1[0]) * ax + (p[1] - a1[1]) * ay) / (la * la)
    const t1 = Math.min(along(b1), along(b2))
    const t2 = Math.max(along(b1), along(b2))
    const overlap = (Math.min(1, t2) - Math.max(0, t1)) * la
    return overlap > 0.1
}

/* Every room's edges, each marked interior or exterior. Keyed by room id so the
   renderer can look them up while it walks the rooms. */
export function classifyWalls(rooms) {
    const usable = (rooms || []).filter(
        r => Array.isArray(r.shape_points) && r.shape_points.length >= 3)
    const out = {}
    for (const room of usable) {
        const points = room.shape_points
        out[room.id] = points.map((a, i) => {
            const b = points[(i + 1) % points.length]
            let interior = false
            for (const other of usable) {
                if (other.id === room.id) continue
                const theirs = other.shape_points
                for (let j = 0; j < theirs.length; j++) {
                    if (!sharesWall(a, b, theirs[j], theirs[(j + 1) % theirs.length])) continue
                    // Shared, but an outdoor neighbour means this is the
                    // building's skin, not a partition.
                    if (!room.outdoor && !other.outdoor) interior = true
                    break
                }
                if (interior) break
            }
            return { a, b, interior }
        })
    }
    return out
}
