/* Reading a service's answer, including the ones that are not an answer.
 *
 * nginx serves the dashboard for any path it has no route for - that is what
 * makes a single-page app work - so a call to a service that is not installed
 * comes back as the dashboard's own HTML with status 200. Parsing that as JSON
 * fails inside a parser, and "unexpected character at line 1 column 1" is not a
 * sentence that leads anyone to a missing nginx location. It happened exactly
 * that way the first time the notification service was called before its route
 * existed.
 */
import { mkdtempSync, copyFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(join(tmpdir(), "phs-http-"))
const copy = join(work, "http.mjs")
copyFileSync(join(here, "..", "apps", "dashboard", "src", "common", "http.js"), copy)
const { readJson } = await import(copy)
rmSync(work, { recursive: true, force: true })

let failed = 0

/* Enough of a Response to answer the three questions readJson asks. */
const reply = (status, type, body) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: { 404: "Not Found", 500: "Internal Server Error" }[status] || "",
    headers: { get: () => type },
    text: async () => body,
    json: async () => JSON.parse(body),
})

async function check(label, response, expected) {
    let got
    try {
        got = JSON.stringify(await readJson(response))
    } catch (error) {
        got = error.message
    }
    if (got.includes(expected)) console.log(`PASS  ${label}`)
    else {
        console.log(`FAIL  ${label}\n        expected to contain: ${expected}\n        got: ${got}`)
        failed = 1
    }
}

await check("json comes through", reply(200, "application/json", '{"a":1}'), '{"a":1}')
await check("a charset on the type is still json",
            reply(200, "application/json; charset=utf-8", '{"a":1}'), '{"a":1}')

// The one that started this: 200, and not an answer.
await check("the dashboard's own page names the cause, not the parser",
            reply(200, "text/html", "<!doctype html><html>…"), "nginx-Route")
await check("and points at the fix", reply(200, "text/html", "<html>"), "--update")

await check("a Flask refusal shows its sentence",
            reply(400, "text/html", "<p>X-Home-User fehlt</p>"), "X-Home-User fehlt")
await check("a status with no body shows the status",
            reply(404, "text/html", ""), "Not Found")
await check("a json error body shows its error field",
            reply(502, "application/json", '{"error":"Gateway weg"}'), "Gateway weg")
await check("and its message field when there is no error field",
            reply(502, "application/json", '{"message":"zu"}'), "zu")

process.exit(failed)
