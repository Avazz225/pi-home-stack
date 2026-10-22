import { readJson } from "../common/http"

const PROFILE_API = process.env.REACT_APP_PROFILE_API_ENDPOINT || ""

/* The gallery's pictures. Not per user: a frame in the hallway shows the same
   thing to everybody walking past. */

async function request(path, options) {
    /* no-store, on every call: an answer from a service is a fact about right
       now, never a document. It matters most when the service was not there
       yet - nginx then serves the dashboard's own page for that path with
       status 200, and a browser that keeps it replays that page long after the
       service exists. Which is exactly how a missing route survived its own
       repair.
    */
    const r = await fetch(`${PROFILE_API}${path}`, {
        ...options,
        cache: "no-store",
        headers: options && options.body ? { "Content-Type": "application/json" } : undefined,
        body: options && options.body ? JSON.stringify(options.body) : undefined,
    })
    return readJson(r, "Der Profildienst")
}

export const fetchGallery = () => request("/gallery")
export const addImageUrl = (url, name) => request("/gallery/url", { method: "POST", body: { url, name } })
export const deleteImage = (id) => request(`/gallery/${id}`, { method: "DELETE" })
export const setGalleryDir = (dir) => request("/gallery/settings", { method: "PUT", body: { dir } })

/* Multipart, so no JSON header and no stringify - the browser sets the
   boundary itself, and overriding Content-Type here breaks the upload. */
export async function uploadImage(file) {
    const form = new FormData()
    form.append("file", file)
    const r = await fetch(`${PROFILE_API}/gallery/upload`, { method: "POST", body: form })
    // 413 comes from nginx, not from the service, and arrives as HTML - its own
    // message is clearer than anything dug out of that page.
    if (r.status === 413) throw new Error("Datei zu groß")
    return readJson(r, "Der Profildienst")
}

/* Where one entry's picture actually is. An upload is served by the service, a
   link points wherever it already pointed. */
export const imageSrc = (entry) =>
    entry.kind === "upload" ? `${PROFILE_API}/gallery/file/${entry.id}` : entry.url
