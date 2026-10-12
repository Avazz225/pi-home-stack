/* status.json, written by a systemd timer, read as a plain file.
 *
 * No service behind this: the collector runs once a minute as root and leaves a
 * file in the web root. That is the whole reason this pane needs no backend and
 * works on an install that has nothing but nginx.
 *
 * cache: no-store because the file keeps its name - a cached copy would freeze
 * the pane at whatever it said when the tab was opened. */
const STATUS_URL = process.env.REACT_APP_STATUS_URL || "/status.json"

export async function fetchSystemStatus() {
    const r = await fetch(STATUS_URL, { cache: "no-store" })
    if (!r.ok) {
        const error = new Error(r.status === 404
            ? "status.json ist nicht da — läuft pi-home-status.timer?"
            : r.statusText)
        error.status = r.status
        throw error
    }
    /* A missing file does not have to arrive as a 404: nginx serves this
       single-page app with try_files ... /index.html, so a status.json that was
       never written comes back as the app's own HTML with status 200. Without
       this the pane would report a JSON syntax error, which says nothing about
       the actual cause. */
    try {
        return await r.json()
    } catch {
        throw new Error("status.json fehlt oder ist unlesbar — läuft pi-home-status.timer?")
    }
}
