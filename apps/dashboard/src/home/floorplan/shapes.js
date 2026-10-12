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
