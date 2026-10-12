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

process.exit(failed)
