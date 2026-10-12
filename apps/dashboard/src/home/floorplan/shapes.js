/* Geometry of the flat, in metres. THIS IS AN EXAMPLE — replace it with yours.
 *
 * Origin is the top-left inner corner of the building; x runs right, y runs down,
 * which matches SVG and keeps the plan readable in the same orientation as a
 * paper one. Anything outside the heated envelope — a balcony, a terrace — gets
 * negative y and `outdoor: true`.
 *
 * The example is a 8.40 × 6.60 m flat, fully tiled, so the room areas add up to
 * the envelope exactly:
 *   Wohnen 4.60×3.80 = 17.5 · Schlafen 3.80×3.80 = 14.4 · Flur 5.80×1.20 = 7.0
 *   Bad 2.80×1.60 = 4.5     · Küche 3.00×1.60 = 4.8    · Arbeiten 2.60×2.80 = 7.3
 *   sum 55.4 = 8.40 × 6.60 ✓   plus the balcony outside with 3.00×1.50 = 4.5
 *
 * Shapes are keyed by room.key in the service's database — the same keys the
 * service's seed.json uses. A room without an entry here simply does not appear
 * on the plan; it still shows up in the lists. So you can start by editing
 * seed.json alone and add the shapes afterwards.
 */

export const ROOM_SHAPES = {
    wohnen: {
        points: [[0, 0], [4.60, 0], [4.60, 3.80], [0, 3.80]],
        label: [2.30, 1.90],
    },
    schlafen: {
        points: [[4.60, 0], [8.40, 0], [8.40, 3.80], [4.60, 3.80]],
        label: [6.50, 1.90],
    },
    flur: {
        points: [[0, 3.80], [5.80, 3.80], [5.80, 5.00], [0, 5.00]],
        label: [2.90, 4.40],
    },
    bad: {
        points: [[0, 5.00], [2.80, 5.00], [2.80, 6.60], [0, 6.60]],
        label: [1.40, 5.80],
    },
    kueche: {
        points: [[2.80, 5.00], [5.80, 5.00], [5.80, 6.60], [2.80, 6.60]],
        label: [4.30, 5.80],
    },
    arbeiten: {
        points: [[5.80, 3.80], [8.40, 3.80], [8.40, 6.60], [5.80, 6.60]],
        label: [7.10, 5.20],
    },
    /* Outdoors: negative y puts it above the envelope on the plan. */
    balkon: {
        points: [[0.20, 0], [0.20, -1.50], [3.20, -1.50], [3.20, 0]],
        label: [1.70, -0.75],
        outdoor: true,
    },
}

/* Footprint of the heated envelope. A plain rectangle here; make it follow the
 * real outline if your flat is not one. */
export const BUILDING_OUTLINE = [[0, 0], [8.40, 0], [8.40, 6.60], [0, 6.60]]

/* Must cover every shape above, balcony included, with a little margin. */
export const VIEW_BOX = { x: -0.30, y: -1.80, width: 9.00, height: 8.70 }

export function toPath(points) {
    return points.map(([x, y]) => `${x},${y}`).join(" ")
}
