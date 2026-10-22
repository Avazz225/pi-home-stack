/* Reading a timestamp that came from a service.
 *
 * Two shapes arrive and they look alike: Python writes its zone, SQLite's
 * datetime('now') writes UTC with nothing saying so. JavaScript reads the
 * second as local time, which on a Pi in Berlin lands two hours out in summer
 * and one in winter - the kind of wrongness that gets blamed on the clock
 * rather than on the parser.
 *
 * The copy to a .mjs is plumbing: time.js sits in a Create React App project
 * whose package.json does not declare "type": "module".
 */
import { mkdtempSync, copyFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, "..", "apps", "dashboard", "src", "common", "time.js")
const work = mkdtempSync(join(tmpdir(), "phs-time-"))
const copy = join(work, "time.mjs")
copyFileSync(source, copy)
const { parseStamp, formatStamp } = await import(copy)
rmSync(work, { recursive: true, force: true })

let failed = 0
const eq = (label, got, want) => {
    if (got === want) console.log(`PASS  ${label}`)
    else {
        console.log(`FAIL  ${label}\n        expected: ${want}\n        got:      ${got}`)
        failed = 1
    }
}

const instant = "2026-10-20T05:33:53.000Z"

/* All four name the same moment. The first is the one that used to be read
   wrongly, and it is the one SQLite writes by default. */
eq("SQLite's bare stamp is UTC", parseStamp("2026-10-20 05:33:53").toISOString(), instant)
eq("Python's offset is honoured", parseStamp("2026-10-20T05:33:53+00:00").toISOString(), instant)
eq("a trailing Z too", parseStamp("2026-10-20T05:33:53Z").toISOString(), instant)
eq("and a real offset is not thrown away",
   parseStamp("2026-10-20T07:33:53+02:00").toISOString(), instant)
eq("a negative offset as well",
   parseStamp("2026-10-20T01:33:53-04:00").toISOString(), instant)
eq("without the colon, as some writers emit it",
   parseStamp("2026-10-20T05:33:53+0000").toISOString(), instant)

/* The hyphens in the date are not signs - an earlier guess at this test matched
   them and read every bare stamp as already zoned. */
eq("the date's hyphens are not an offset",
   parseStamp("2026-10-20 05:33:53").toISOString(),
   parseStamp("2026-10-20T05:33:53Z").toISOString())

eq("epoch seconds, as the gateway reports a timer",
   parseStamp(1792068078).toISOString(), new Date(1792068078000).toISOString())

eq("nothing stays nothing", parseStamp(null), null)
eq("empty stays nothing", parseStamp(""), null)
eq("nonsense stays nothing", parseStamp("irgendwas"), null)
eq("and formatting nothing is a dash", formatStamp(null), "–")

process.exit(failed)
