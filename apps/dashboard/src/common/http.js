/* Reading a service's answer, including the ones that are not an answer.
 *
 * nginx serves this dashboard for any path it has no route for - that is what
 * makes a single-page app work - so a call to a service that is not installed
 * comes back as the dashboard's own HTML with status 200. Parsing that as JSON
 * fails somewhere in a parser, and the message it produces says nothing about
 * the cause: "unexpected character at line 1 column 1" is not a sentence that
 * leads anyone to a missing nginx location.
 *
 * So the content type is checked before the body is believed.
 */
export async function readJson(response, what = "Der Dienst") {
    const type = response.headers.get("content-type") || ""
    const isJson = type.includes("json")

    if (!response.ok) {
        let message = response.statusText || `HTTP ${response.status}`
        try {
            const text = await response.text()
            // Flask's abort() answers HTML with the reason in a <p>; that
            // sentence is the part worth showing.
            const match = text.match(/<p>(.*?)<\/p>/)
            if (match) message = match[1]
            else if (isJson) {
                const data = JSON.parse(text)
                message = data.error || data.message || message
            }
        } catch { /* keep what the status line said */ }
        const error = new Error(message)
        error.status = response.status
        throw error
    }

    if (!isJson) {
        throw new Error(
            `${what} ist nicht erreichbar — vermutlich fehlt die nginx-Route oder der `
            + `Dienst läuft nicht. Prüfen mit: sudo ./install.sh --update`)
    }
    return response.json()
}
