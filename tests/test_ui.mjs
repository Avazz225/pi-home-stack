/* The shared parts, and whether the modules are still using them.
 *
 * Before common/ui existed, the same six components had been written ten
 * times under ten names: `.home-chip`, `.study-chip` and `.level-tag` were
 * byte-identical rules in three files, and there were 29 classes for a small
 * coloured pill. Nothing stopped that happening, which is why it did.
 *
 * This file is what stops it happening again. It does three things:
 *
 *   1. No module may restyle a `.ui-*` class. That is exactly how the ten
 *      versions grew the first time - one module needed its pill a little
 *      different, reached into the shared one, and then the next module
 *      could not use it.
 *   2. No raw colour outside the theme. The project is already good about
 *      this; the rule is here so it stays that way.
 *   3. A budget for duplicate components, which only goes down. Converting
 *      ten modules is not one session's work, so the remaining duplicates
 *      are counted rather than forbidden - and the count may not grow.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const SRC = join(HERE, "..", "apps", "dashboard", "src")

let failed = 0

function check(label, got, want) {
    const same = JSON.stringify(got) === JSON.stringify(want)
    if (same) console.log(`PASS  ${label}`)
    else {
        console.log(`FAIL  ${label}\n        expected: ${JSON.stringify(want)}` +
                    `\n        got:      ${JSON.stringify(got)}`)
        failed = 1
    }
}

function ok(label, condition, detail = "") {
    check(label, condition ? true : (detail || false), true)
}

function cssFiles(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) cssFiles(full, out)
        else if (entry.endsWith(".css")) out.push(full)
    }
    return out
}

const files = cssFiles(SRC).map(f => ({ path: relative(SRC, f), text: readFileSync(f, "utf8") }))
ok("there are stylesheets to check", files.length > 20, `${files.length}`)

/* ── 1. Nobody restyles the shared parts ─────────────────────────────────── */

const ownsUi = (path) => path.startsWith("common/ui/")

/* A module may place a shared part inside its own container and give that
   container a layout - `.cat-toggle .ui-empty { margin: 0 }` is scoping, not
   restyling. What it may not do is set the part's own look, which is a rule
   whose selector *starts* with the shared class. That distinction is the
   whole difference between using the system and forking it. */
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "")

const trespassers = files
    .filter(f => !ownsUi(f.path))
    .flatMap(f => (strip(f.text).match(/[^{}]+\{/g) || [])
        .flatMap(block => block.slice(0, -1).split(","))
        .map(sel => sel.trim())
        .filter(sel => /^\.ui-[a-z-]+(\[[^\]]*\])?(:[a-z-]+)?$/.test(sel))
        .map(sel => `${f.path}: ${sel}`))

check("no module restyles a shared part", trespassers, [])

/* ── 2. Colours come from the theme ──────────────────────────────────────── */

/* The gallery doubles as a screensaver and stays on black in both themes,
   which is a decision rather than a leak, and it says so in the file. */
const COLOUR_EXEMPT = ["gallery/gallery.css"]

const rawColours = files
    .filter(f => f.path !== "theme.css" && !COLOUR_EXEMPT.includes(f.path))
    .flatMap(f => (f.text.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map(hit => `${f.path}: ${hit}`))

check("no raw colours outside the theme", rawColours, [])

/* ── 3. The duplicate budget ─────────────────────────────────────────────── */

/* Every rule, as a selector and its sorted declarations. Two rules in two
   modules with the same declarations are the same component written twice. */
function rules(text) {
    const out = []
    for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = match[1].replace(/\/\*[\s\S]*?\*\//g, "").trim()
        const body = match[2]
            .split(";")
            .map(d => d.trim())
            .filter(Boolean)
            .sort()
            .join("; ")
        // A one-declaration rule is a modifier, not a component; counting
        // those would drown the signal in `color: var(--ok)`.
        if (selector && body && body.split(";").length >= 3) out.push({ selector, body })
    }
    return out
}

const byBody = new Map()
for (const file of files) {
    if (ownsUi(file.path) || file.path === "theme.css") continue
    const moduleName = file.path.split("/")[0]
    for (const rule of rules(file.text)) {
        if (!byBody.has(rule.body)) byBody.set(rule.body, new Set())
        byBody.get(rule.body).add(`${moduleName} (${rule.selector.split(",")[0].trim()})`)
    }
}

/* Only across modules. Two identical rules inside one module are that
   module's business and often deliberate. */
const duplicated = [...byBody.values()]
    .map(owners => [...owners])
    .filter(owners => new Set(owners.map(o => o.split(" ")[0])).size > 1)

/* The budget: a ratchet, not a target. It started at 31 - every one of those
   was a component some module had written for itself while another module
   had written the same one. Lower it as modules move onto the shared parts.
   It may never be raised: a pull request that needs a bigger number here is a
   pull request that forked a shared part, and the fix is to use the part.
   When it reaches zero, turn this into a plain equality check. */
const BUDGET = 20

console.log(`      ${duplicated.length} component(s) still written in more than one module`)
for (const owners of duplicated.slice(0, 12)) console.log(`        ${owners.join("  =  ")}`)

ok(`duplicated components stay within the budget of ${BUDGET}`,
   duplicated.length <= BUDGET,
   `${duplicated.length} found - convert a module onto common/ui rather than raising this`)

/* ── 4. The parts exist and are exported ─────────────────────────────────── */

const index = readFileSync(join(SRC, "common", "ui", "index.js"), "utf8")
const ui = readFileSync(join(SRC, "common", "ui", "ui.css"), "utf8")

for (const part of ["Pill", "Row", "Card", "Btn", "Field", "Empty", "Note", "Stat"]) {
    ok(`${part} is exported`, new RegExp(`export function ${part}\\b`).test(index))
}

/* Every tone the components offer has to exist in the stylesheet, or a module
   sets a tone that silently does nothing. */
for (const tone of ["accent", "ok", "warn", "caution", "danger", "thesis"]) {
    ok(`the ${tone} tone is styled`, ui.includes(`.ui-pill[data-tone="${tone}"]`))
}

/* ── 5. Both themes define the same tokens ───────────────────────────────── */

const theme = readFileSync(join(SRC, "theme.css"), "utf8")
const blocks = theme.split(/:root\[data-theme="dark"\]/)
ok("the theme has a light block and a dark block", blocks.length === 2)

const tokensOf = (text) => new Set((text.match(/^\s*(--[a-z0-9-]+)\s*:/gm) || [])
    .map(line => line.trim().replace(/\s*:$/, "")))

/* What each token in a block is set to, so a derived token can be told from a
   literal one. */
const valuesOf = (text) => {
    const out = new Map()
    for (const [, name, value] of text.matchAll(/^\s*(--[a-z0-9-]+)\s*:([^;]*);/gm)) {
        out.set(name, value.trim())
    }
    return out
}

const light = tokensOf(blocks[0])
const dark = tokensOf(blocks[1] || "")
const lightValues = valuesOf(blocks[0])

/* A derived token is built out of other tokens - `--accent` is an oklch() of
   --accent-l, --accent-c and --accent-h - and custom properties resolve their
   var() references where they are used, not where they are written. Redefining
   the three parts for dark therefore changes --accent too, and declaring it a
   second time would be a copy to keep in step by hand. Only a token that
   contains no var() at all has to be stated per theme. */
const derived = (name) => {
    const value = lightValues.get(name) || ""
    return value.includes("var(--") && !/#[0-9a-f]{3,8}|rgba?\(|oklch\(\s*[\d.]/i.test(value)
}

/* Aliases are declared once, in the light block, and inherit. Anything else
   missing from dark is a token that falls back to its light value on a dark
   page, which is the kind of bug nobody sees until a screenshot. */
const ALIAS = ["--paneBG", "--detailCol", "--lineCol", "--hoveringCol", "--card-border",
               "--radius-sm", "--radius-md", "--radius-lg",
               /* The accent hue is the one thing the user sets, and it is the
                  same hue in both themes by design - only its lightness and
                  chroma differ. */
               "--accent-h"]
const missingInDark = [...light]
    .filter(t => !dark.has(t) && !ALIAS.includes(t) && !derived(t))
check("every themed token is defined for dark as well", missingInDark, [])

const strayInDark = [...dark].filter(t => !light.has(t))
check("and dark defines nothing light does not have", strayInDark, [])

console.log()
console.log(failed ? "Fehler aufgetreten." : "Alle UI-Tests bestanden.")
process.exit(failed)
