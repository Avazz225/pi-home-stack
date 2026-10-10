const BACKUP_API = process.env.REACT_APP_BACKUP_API_ENDPOINT || ""

async function request(path, options) {
    const r = await fetch(`${BACKUP_API}${path}`, options && {
        ...options,
        headers: { "Content-Type": "application/json" },
        body: options.body ? JSON.stringify(options.body) : undefined,
    })
    if (!r.ok) {
        // The service answers errors with a JSON body where it can — surface that
        // text instead of a bare status code.
        let message = r.statusText
        try {
            const data = await r.json()
            message = data.error || data.message || message
        } catch { /* not a JSON error body */ }
        const error = new Error(message)
        error.status = r.status
        throw error
    }
    return r.json()
}

export const fetchConfig = () => request("/config")
export const saveConfig = (data) => request("/config", { method: "PUT", body: data })
export const checkConnection = () => request("/config/check", { method: "POST" })

export const fetchTargets = () => request("/targets")
export const createTarget = (data) => request("/targets", { method: "POST", body: data })
export const updateTarget = (id, data) => request(`/targets/${id}`, { method: "PUT", body: data })
export const deleteTarget = (id) => request(`/targets/${id}`, { method: "DELETE" })

export const fetchTree = (path = "") => request(`/tree?path=${encodeURIComponent(path)}`)
export const fetchRules = () => request("/rules")
export const setRule = (path, mode) => request("/rules", { method: "PUT", body: { path, mode } })

export const fetchStatus = () => request("/status")
export const fetchRuns = (limit = 20) => request(`/runs?limit=${limit}`)
export const fetchRun = (id) => request(`/runs/${id}`)
export const startRun = (dryRun = false) => request("/runs", { method: "POST", body: { dryRun } })

export const fetchObjects = (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request(`/objects${qs ? `?${qs}` : ""}`)
}
