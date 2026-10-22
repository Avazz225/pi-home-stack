import { userHeaders } from "../common/user"

/* Notifications belong to a person - that is the whole point of them - so every
   call says who is asking, reads included. */

const NOTIFY_API = process.env.REACT_APP_NOTIFY_API_ENDPOINT || ""

async function request(path, options) {
    const r = await fetch(`${NOTIFY_API}${path}`, {
        ...options,
        headers: { "Content-Type": "application/json", ...userHeaders() },
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

export const fetchNotifications = (limit = 50) => request(`/notifications?limit=${limit}`)
export const markRead = (id) => request("/notifications/read", { method: "POST", body: id ? { id } : {} })
export const clearRead = () => request("/notifications", { method: "DELETE" })

export const fetchKinds = () => request("/kinds")
export const fetchRules = () => request("/rules")
export const createRule = (data) => request("/rules", { method: "POST", body: data })
export const updateRule = (id, data) => request(`/rules/${id}`, { method: "PUT", body: data })
export const deleteRule = (id) => request(`/rules/${id}`, { method: "DELETE" })
export const checkRulesNow = () => request("/rules/check", { method: "POST" })

export const fetchChannels = () => request("/channels")
export const createChannel = (data) => request("/channels", { method: "POST", body: data })
export const deleteChannel = (id) => request(`/channels/${id}`, { method: "DELETE" })
export const testChannel = (id) => request(`/channels/${id}/test`, { method: "POST" })

export const fetchVersion = () => request("/version")
