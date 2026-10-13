/* Floorplan geometry: the pure functions behind the plan and its editor.
 *
 * Worth testing without a browser, because this is where a flat turns into
 * coordinates and a wrong corner shows up as a stray triangle rather than an
 * error. The functions live in shapes.js precisely so this file can import
 * them — the editor component pulls in React and the API client, which node
 * cannot resolve.
 *
 * The copy to a .mjs is plumbing, not meaning: shapes.js is an ES module, but
 * it sits in a Create React App project whose package.json does not declare
 * "type": "module", so node would read a plain .js as CommonJS and fail on the
 * first export.
 */
import { mkdtempSync, copyFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, "..", "apps", "dashboard", "src", "home", "floorplan", "shapes.js")
const work = mkdtempSync(join(tmpdir(), "phs-floorplan-"))
const copy = join(work, "shapes.mjs")
copyFileSync(source, copy)

const {
    toPath, centroid, roomShapes, viewBoxFor,
    asRect, rectPoints, polygonArea, parsePoints,
    movePoint, insertVertex, removeVertex, edgeLength, setEdgeLength,
    boundsOf, moveTo, snapTargets, snapCorrection,
    sharesWall, classifyWalls,
} = await import(copy)
rmSync(work, { recursive: true, force: true })

let failed = 0
const eq = (label, got, want) => {
    const a = JSON.stringify(got)
    const b = JSON.stringify(want)
    if (a === b) {
        console.log(`PASS  ${label}`)
    } else {
        console.log(`FAIL  ${label}\n        expected: ${b}\n        got:      ${a}`)
        failed = 1
    }
}
const near = (label, got, want, tol = 0.005) => {
    if (Math.abs(got - want) <= tol) console.log(`PASS  ${label}`)
    else { console.log(`FAIL  ${label}\n        expected: ${want}\n        got:      ${got}`); failed = 1 }
}

/* ── Drawing ─────────────────────────────────────────────────────────────── */

eq("toPath", toPath([[0, 0], [4, 0], [4, 3]]), "0,0 4,0 4,3")

near("centroid of a rectangle, x", centroid([[0, 0], [4, 0], [4, 3], [0, 3]])[0], 2)
near("centroid of a rectangle, y", centroid([[0, 0], [4, 0], [4, 3], [0, 3]])[1], 1.5)
// A triangle's centroid is a third of the way up, not half - the mean of the
// corners would agree here, which is why the next case matters more.
near("centroid of a triangle, y", centroid([[0, 0], [3, 0], [0, 3]])[1], 1)
// Four corners clustered on one side: the corner average would be pulled left,
// the area centroid stays in the middle.
near("centroid is area-weighted", centroid([[0, 0], [0.1, 0], [10, 0], [0, 4]])[0], 3.36, 0.2)
eq("degenerate polygon still yields a point",
   centroid([[1, 1], [1, 1], [1, 1]]).map(n => Math.round(n)), [1, 1])

/* ── Shapes from rooms ───────────────────────────────────────────────────── */

const rooms = [
    { key: "wohnen", shape_points: [[0, 0], [4, 0], [4, 3], [0, 3]], shape_label: [2, 1.5], outdoor: 0 },
    { key: "balkon", shape_points: [[0, 0], [3, 0], [3, -1.5], [0, -1.5]], shape_label: null, outdoor: 1 },
    { key: "ohne", shape_points: null, shape_label: null, outdoor: 0 },
    { key: "zu_kurz", shape_points: [[0, 0], [1, 1]], shape_label: null, outdoor: 0 },
    { key: "kaputt", shape_points: [[0, 0], [1, "x"], [2, 2]], shape_label: null, outdoor: 0 },
]
const shapes = roomShapes(rooms)
eq("only drawable rooms get a shape", Object.keys(shapes).sort(), ["balkon", "wohnen"])
eq("explicit label is kept", shapes.wohnen.label, [2, 1.5])
near("missing label falls back to the centroid", shapes.balkon.label[1], -0.75)
eq("outdoor is carried over", [shapes.wohnen.outdoor, shapes.balkon.outdoor], [false, true])
eq("no rooms at all", roomShapes([]), {})
eq("undefined rooms", roomShapes(undefined), {})

/* ── The view box ────────────────────────────────────────────────────────── */

const box = viewBoxFor(shapes, 0.5)
// x from 0 to 4 and y from -1.5 to 3, plus half a metre of margin on every
// side: 5 wide and 5.5 tall, starting at -0.5 / -2.
eq("view box covers every shape including the balcony",
   [box.x, box.y, box.width, box.height], [-0.5, -2, 5, 5.5])
eq("empty input yields a usable box", viewBoxFor({}), { x: 0, y: 0, width: 1, height: 1 })

/* ── The editor's helpers ────────────────────────────────────────────────── */

eq("rectangle recognised", asRect([[0, 0], [4, 0], [4, 3], [0, 3]]), { x: 0, y: 0, w: 4, h: 3 })
eq("corner order does not matter", asRect([[4, 3], [0, 3], [0, 0], [4, 0]]), { x: 0, y: 0, w: 4, h: 3 })
eq("negative y, as a balcony has", asRect([[0.2, 0], [3.2, 0], [3.2, -1.5], [0.2, -1.5]]),
   { x: 0.2, y: -1.5, w: 3, h: 1.5 })
eq("five corners is not a rectangle", asRect([[0, 0], [1, 0], [2, 1], [1, 2], [0, 2]]), null)
eq("a slanted edge is not a rectangle", asRect([[0, 0], [4, 0], [3, 3], [0, 3]]), null)
eq("degenerate is not a rectangle", asRect([[0, 0], [4, 0], [4, 0], [0, 0]]), null)
eq("not an array", asRect(null), null)

eq("rectPoints", rectPoints({ x: 1, y: 2, w: 3, h: 4 }), [[1, 2], [4, 2], [4, 6], [1, 6]])
eq("rectangle round trip", asRect(rectPoints({ x: 0.2, y: -1.5, w: 3, h: 1.5 })),
   { x: 0.2, y: -1.5, w: 3, h: 1.5 })

near("area of a rectangle", polygonArea([[0, 0], [4, 0], [4, 3], [0, 3]]), 12)
// A balcony with the chamfered corner a real plan has.
near("area with a chamfer",
     polygonArea([[0.15, 0], [0.15, -1.9], [3.11, -1.9], [3.71, -1.3], [3.71, 0]]), 6.58)

eq("points as JSON", parsePoints("[[0,0],[4,0],[4,3],[0,3]]"), [[0, 0], [4, 0], [4, 3], [0, 3]])
eq("points as bare numbers", parsePoints("0 0 4 0 4 3 0 3"), [[0, 0], [4, 0], [4, 3], [0, 3]])
eq("points with punctuation", parsePoints("0,0; 4,0; 4,3; 0,3"), [[0, 0], [4, 0], [4, 3], [0, 3]])
eq("negative coordinates", parsePoints("0 0 3 0 3 -1.5 0 -1.5"), [[0, 0], [3, 0], [3, -1.5], [0, -1.5]])
eq("too few numbers", parsePoints("0 0 4 0"), null)
eq("an odd count is not pairs", parsePoints("0 0 4 0 4"), null)
eq("empty", parsePoints("   "), null)
eq("no numbers at all", parsePoints("keine Zahlen hier"), null)

/* ── Editing a polygon ───────────────────────────────────────────────────── */

const square = [[0, 0], [4, 0], [4, 3], [0, 3]]

eq("movePoint", movePoint(square, 2, [5, 3]), [[0, 0], [4, 0], [5, 3], [0, 3]])
eq("movePoint leaves the input alone", square, [[0, 0], [4, 0], [4, 3], [0, 3]])
eq("movePoint out of range", movePoint(square, 9, [1, 1]), square)

eq("insertVertex splits the top wall",
   insertVertex(square, 0), [[0, 0], [2, 0], [4, 0], [4, 3], [0, 3]])
// The last edge wraps around to the first corner; inserting there must append,
// not fall off the end.
eq("insertVertex on the closing wall",
   insertVertex(square, 3), [[0, 0], [4, 0], [4, 3], [0, 3], [0, 1.5]])

eq("removeVertex", removeVertex(square, 1), [[0, 0], [4, 3], [0, 3]])
eq("a triangle keeps its three corners",
   removeVertex([[0, 0], [1, 0], [0, 1]], 0), [[0, 0], [1, 0], [0, 1]])

near("edgeLength horizontal", edgeLength(square, 0), 4)
near("edgeLength vertical", edgeLength(square, 1), 3)
near("edgeLength wraps around", edgeLength(square, 3), 3)
near("edgeLength diagonal", edgeLength([[0, 0], [3, 4], [0, 4]], 0), 5)

// Setting a wall length moves only the far corner, so walls already set stay.
eq("setEdgeLength shortens the top wall",
   setEdgeLength(square, 0, 2.5), [[0, 0], [2.5, 0], [4, 3], [0, 3]])
eq("setEdgeLength on a diagonal keeps the direction",
   setEdgeLength([[0, 0], [3, 4], [0, 4]], 0, 10).map(p => p.map(n => Math.round(n * 100) / 100)),
   [[0, 0], [6, 8], [0, 4]])
eq("setEdgeLength refuses zero", setEdgeLength(square, 0, 0), square)
eq("setEdgeLength refuses nonsense", setEdgeLength(square, 0, NaN), square)
eq("setEdgeLength on a degenerate edge",
   setEdgeLength([[1, 1], [1, 1], [2, 2]], 0, 3), [[1, 1], [1, 1], [2, 2]])
eq("setEdgeLength wraps the index",
   setEdgeLength(square, 4, 2), setEdgeLength(square, 0, 2))

eq("boundsOf", boundsOf([[1, 2], [4, 2], [4, 6], [1, 6]]), { x: 1, y: 2, w: 3, h: 4 })
eq("boundsOf with negative y, as a balcony has",
   boundsOf([[0, 0], [3, 0], [3, -1.5]]), { x: 0, y: -1.5, w: 3, h: 1.5 })

eq("moveTo shifts the whole polygon",
   moveTo([[1, 2], [4, 2], [4, 6], [1, 6]], 0, 0), [[0, 0], [3, 0], [3, 4], [0, 4]])
eq("moveTo keeps the shape of an L",
   moveTo([[0, 0], [4, 0], [4, 2], [2, 2], [2, 3], [0, 3]], 1, 1),
   [[1, 1], [5, 1], [5, 3], [3, 3], [3, 4], [1, 4]])
eq("moveTo refuses nonsense", moveTo([[0, 0], [1, 0], [1, 1]], NaN, 0),
   [[0, 0], [1, 0], [1, 1]])
eq("moveTo on an empty polygon", moveTo([], 1, 1), [])

/* ── Snapping ────────────────────────────────────────────────────────────── */

const neighbours = [
    { id: 1, shape_points: [[0, 0], [3.965, 0], [3.965, 4.45], [0, 4.45]] },
    { id: 2, shape_points: [[3.965, 0], [7.305, 0], [7.305, 4.45], [3.965, 4.45]] },
    { id: 3, shape_points: null },
]
const targets = snapTargets(neighbours, 2)
eq("snapTargets collects the other rooms' x values", targets.xs.sort((a, b) => a - b), [0, 3.965])
eq("snapTargets collects their y values", targets.ys.sort((a, b) => a - b), [0, 4.45])
eq("a room without geometry contributes nothing", targets.corners.length, 4)
eq("the dragged room is excluded", snapTargets(neighbours, 1).xs.sort((a, b) => a - b), [3.965, 7.305])

// Grid-snapped to 4.0 while the neighbour's wall is at 3.965: the correction
// closes the 3.5 cm seam the grid would have left.
const near4 = [[4, 0], [7, 0], [7, 3], [4, 3]]
const corr = snapCorrection(near4, targets, 0.15)
near("x is pulled onto the neighbour's wall", corr.dx, -0.035)
near("y already lines up", corr.dy, 0)

// Out of reach: half a metre away is a decision, not a near miss.
eq("nothing snaps from far away",
   snapCorrection([[6, 9], [7, 9], [7, 10]], targets, 0.15), { dx: 0, dy: 0 })

// The axes are independent, so a room can meet a wall on one side while its
// other side stays where it was put.
const oneAxis = snapCorrection([[3.93, 7], [6, 7], [6, 9]], targets, 0.15)
near("x snaps", oneAxis.dx, 0.035)
near("y does not", oneAxis.dy, 0)

eq("no targets at all", snapCorrection(near4, { xs: [], ys: [], corners: [] }), { dx: 0, dy: 0 })

/* ── Walls ───────────────────────────────────────────────────────────────── */

eq("two rooms along the same vertical line share a wall",
   sharesWall([4, 0], [4, 3], [4, 0], [4, 3]), true)
eq("partial overlap still shares a wall",
   sharesWall([4, 0], [4, 3], [4, 1], [4, 5]), true)
eq("a corner touch is not a wall",
   sharesWall([4, 0], [4, 3], [4, 3], [4, 3.05]), false)
eq("parallel but offset is not the same wall",
   sharesWall([4, 0], [4, 3], [4.5, 0], [4.5, 3]), false)
eq("perpendicular is not the same wall",
   sharesWall([4, 0], [4, 3], [4, 0], [7, 0]), false)
eq("a chamfered edge matches its own direction",
   sharesWall([3.11, -1.9], [3.71, -1.3], [3.11, -1.9], [3.71, -1.3]), true)

const flat = [
    { id: 1, outdoor: false, shape_points: [[0, 0], [4, 0], [4, 3], [0, 3]] },
    { id: 2, outdoor: false, shape_points: [[4, 0], [7, 0], [7, 3], [4, 3]] },
    { id: 3, outdoor: true,  shape_points: [[0, 0], [3, 0], [3, -1.5], [0, -1.5]] },
]
const walls = classifyWalls(flat)
// Room 1's edges: top (shared with the balcony), right (shared with room 2),
// bottom and left on the boundary.
eq("the wall between two rooms is interior",
   walls[1].filter(w => w.interior).length, 1)
eq("and it is the one at x = 4",
   walls[1].find(w => w.interior).a, [4, 0])
// The balcony shares the top edge, but that is the building's skin.
eq("an edge shared with a balcony stays exterior",
   walls[1].filter(w => w.a[1] === 0 && w.b[1] === 0)[0].interior, false)
eq("the balcony has no interior wall at all",
   walls[3].every(w => !w.interior), true)
eq("rooms without geometry are skipped", Object.keys(classifyWalls([{ id: 9 }])).length, 0)

process.exit(failed)
