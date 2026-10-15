/* The room panel's layout: which blocks appear, in which order.
 *
 * Worth testing without a browser because the merge is the part that fails
 * quietly. A setting saved by an older version does not list a block that was
 * added since — if the merge trusted the stored order, that block would never
 * appear again, and nothing anywhere would say so.
 *
 * The copy to a .mjs is plumbing, not meaning: layout.js is an ES module, but it
 * sits in a Create React App project whose package.json does not declare
 * "type": "module", so node would read a plain .js as CommonJS and fail on the
 * first export.
 */
import { mkdtempSync, copyFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, "..", "apps", "dashboard", "src", "home", "layout.js")
const work = mkdtempSync(join(tmpdir(), "phs-layout-"))
const copy = join(work, "layout.mjs")
copyFileSync(source, copy)

const {
    SECTIONS, CLIMATE_TILES, DEFAULT_LAYOUT,
    readLayout, isHidden, sectionAvailable, orderedSections, orderedTiles, moveWithin,
} = await import(copy)
rmSync(work, { recursive: true, force: true })

let failed = 0
const eq = (label, got, want) => {
    const a = JSON.stringify(got)
    const b = JSON.stringify(want)
    if (a === b) console.log(`PASS  ${label}`)
    else {
        console.log(`FAIL  ${label}\n        expected: ${b}\n        got:      ${a}`)
        failed = 1
    }
}

/* ── Reading a stored layout ─────────────────────────────────────────────── */

eq("nothing stored gives the default order",
   readLayout(undefined).sections, DEFAULT_LAYOUT.sections)
eq("nothing stored hides nothing", readLayout(null).hidden, [])
eq("garbage falls back instead of taking the view down",
   readLayout("{not json").sections, DEFAULT_LAYOUT.sections)
eq("an empty object is a default",
   readLayout("{}").climate_tiles, DEFAULT_LAYOUT.climate_tiles)

eq("a stored order is kept",
   readLayout('{"sections":["vacuum","climate","lights","schedule"]}').sections,
   ["vacuum", "climate", "lights", "schedule"])

/* The point of the merge: an older setting that never heard of a block must not
   bury it. */
eq("a block the stored order never mentioned is appended",
   readLayout('{"sections":["schedule","climate"]}').sections,
   ["schedule", "climate", "lights", "vacuum"])
eq("a block that no longer exists is dropped",
   readLayout('{"sections":["climate","telepathy","lights"]}').sections,
   ["climate", "lights", "schedule", "vacuum"])
eq("the same for tiles",
   readLayout('{"climate_tiles":["humidity","temperature"]}').climate_tiles,
   ["humidity", "temperature", "trv_target", "valve", "head", "battery", "window"])

eq("hidden survives", readLayout('{"hidden":["vacuum"]}').hidden, ["vacuum"])
eq("a hidden list that is not a list is ignored",
   readLayout('{"hidden":"vacuum"}').hidden, [])
eq("isHidden reads it", isHidden(readLayout('{"hidden":["lights"]}'), "lights"), true)
eq("and says no for the rest", isHidden(readLayout('{"hidden":["lights"]}'), "climate"), false)

/* ── Availability comes from the data, never from the setting ────────────── */

const bare = { room: { climate: {}, lights: {}, devices: [], schedules: [] } }

eq("no valve, no climate block", sectionAvailable("climate", bare), false)
eq("a bound valve brings it", sectionAvailable("climate",
   { room: { climate: { bound: 1 }, lights: {} } }), true)
eq("a gateway with valves brings it too, so they can be assigned",
   sectionAvailable("climate", { ...bare, shelly: { configured: true, trvs: 3 } }), true)
eq("a gateway without valves does not",
   sectionAvailable("climate", { ...bare, shelly: { configured: true, trvs: 0 } }), false)

eq("no Hue, no light block", sectionAvailable("lights", bare), false)
eq("Hue set up brings it", sectionAvailable("lights", { ...bare, hue: { configured: true } }), true)

eq("a plan that exists stays reachable, or it could never be deleted",
   sectionAvailable("schedule", { room: { climate: {}, lights: {}, schedules: [{ id: 1 }] } }), true)
eq("without a plan and without a valve it stays away",
   sectionAvailable("schedule", bare), false)

eq("no robot, no robot block", sectionAvailable("vacuum", bare), false)
eq("a robot set up but offline still shows",
   sectionAvailable("vacuum", { ...bare, vacuum: { configured: true, connected: false } }), true)

/* ── Order and availability together ────────────────────────────────────── */

const context = {
    room: { climate: { bound: 2 }, lights: { bound: 1 }, schedules: [], vacuum_rooms: [] },
    hue: { configured: true },
    vacuum: { configured: false, connected: false },
}
eq("only what is there, in the stored order",
   orderedSections(readLayout('{"sections":["schedule","lights","climate","vacuum"]}'), context)
       .map(s => s.id),
   ["schedule", "lights", "climate"])
eq("hiding wins over availability",
   orderedSections(readLayout('{"hidden":["lights"]}'), context).map(s => s.id),
   ["climate", "schedule"])

const climate = { temperature: 21.5, humidity: 48, trv_target: 21, valve_position: 0 }
eq("a tile without a value is left out",
   orderedTiles(readLayout("{}"), climate).map(t => t.id),
   ["temperature", "humidity", "trv_target", "valve"])
eq("and the order is the stored one",
   orderedTiles(readLayout('{"climate_tiles":["valve","humidity"]}'), climate).map(t => t.id),
   ["valve", "humidity", "temperature", "trv_target"])
eq("an empty climate block yields no tiles", orderedTiles(readLayout("{}"), {}), [])
eq("so does a missing one", orderedTiles(readLayout("{}"), undefined), [])

/* ── Moving one entry ───────────────────────────────────────────────────── */

const order = ["a", "b", "c", "d"]
eq("down one", moveWithin(order, "b", 1), ["a", "c", "b", "d"])
eq("up one", moveWithin(order, "c", -1), ["a", "c", "b", "d"])
eq("off the top changes nothing", moveWithin(order, "a", -1), order)
eq("off the bottom changes nothing", moveWithin(order, "d", 1), order)
eq("an unknown id changes nothing", moveWithin(order, "z", 1), order)
eq("the original is untouched", order, ["a", "b", "c", "d"])

/* ── The registries stay in step ────────────────────────────────────────── */

eq("every section has a label", SECTIONS.every(s => s.id && s.label), true)
eq("every tile can say whether it has data",
   CLIMATE_TILES.every(t => t.id && t.label && typeof t.available === "function"), true)
eq("the default order lists every section",
   DEFAULT_LAYOUT.sections.length, SECTIONS.length)
eq("and every tile", DEFAULT_LAYOUT.climate_tiles.length, CLIMATE_TILES.length)

process.exit(failed)
