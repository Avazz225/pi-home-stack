const PROFILE_API = process.env.REACT_APP_PROFILE_API_ENDPOINT || ""

/* The gallery's pictures. Not per user: a frame in the hallway shows the same
   thing to everybody walking past. */

async function request(path, options) {
    const r = await fetch(`${PROFILE_API}${path}`, {
        ...options,
        headers: options && options.body ? { "Content-Type": "application/json" } : undefined,
        body: options && options.body ? JSON.stringify(options.body) : undefined,
    })
    if (!r.ok) {
        let message = r.statusText
        try {
            const match = (await r.text()).match(/<p>(.*?)<\/p>/)
            if (match) message = match[1]
        } catch { /* keep the status text */ }
        throw new Error(message)
    }
    return r.json()
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
    if (!r.ok) {
        let message = r.status === 413 ? "Datei zu groß" : r.statusText
        try {
            const match = (await r.text()).match(/<p>(.*?)<\/p>/)
            if (match) message = match[1]
        } catch { /* keep the status text */ }
        throw new Error(message)
    }
    return r.json()
}

/* Where one entry's picture actually is. An upload is served by the service, a
   link points wherever it already pointed. */
export const imageSrc = (entry) =>
    entry.kind === "upload" ? `${PROFILE_API}/gallery/file/${entry.id}` : entry.url
