import { createContext, useCallback, useContext, useEffect, useState } from "react"
import { readJson } from "./http"

/* Who is using this dashboard right now.
 *
 * Not authentication. The list of people lives in the profile service so every
 * device shows the same names; which of them is active is this browser's own
 * business and stays in localStorage. Anybody on this network can call the
 * services as anybody else - that is the same trust model as the rest of the
 * flat's stack, and stating it is better than implying a boundary that is not
 * there.
 *
 * What travels is the id, never the name. A name is a label that gets
 * corrected; the id is what the services store beside their rows, so renaming a
 * person must not mean rewriting three databases.
 */

const PROFILE_API = process.env.REACT_APP_PROFILE_API_ENDPOINT || ""
const STORE_KEY = "activeUser"
export const USER_HEADER = "X-Home-User"

function remembered() {
    try {
        return localStorage.getItem(STORE_KEY) || ""
    } catch {
        return ""
    }
}

function remember(id) {
    try {
        if (id) localStorage.setItem(STORE_KEY, id)
        else localStorage.removeItem(STORE_KEY)
    } catch { /* private window: the choice then lasts for this session */ }
}

/* Read by the api clients. A module-level variable rather than a hook, because
   the fetch wrappers are plain functions called from everywhere - threading a
   React context through all of them would mean rewriting each one for a value
   that changes about once a day. */
let activeUserId = remembered()

export const currentUserId = () => activeUserId
export const userHeaders = () => (activeUserId ? { [USER_HEADER]: activeUserId } : {})

export async function fetchUsers() {
    const r = await fetch(`${PROFILE_API}/users`)
    if (!r.ok) throw new Error("Benutzerliste nicht erreichbar")
    return r.json()
}

async function send(path, options) {
    const r = await fetch(`${PROFILE_API}${path}`, {
        ...options,
        headers: { "Content-Type": "application/json", ...userHeaders() },
        body: options.body ? JSON.stringify(options.body) : undefined,
    })
    return readJson(r, "Der Profildienst")
}

export const createUser = (name) => send("/users", { method: "POST", body: { name } })
export const renameUser = (id, name) => send(`/users/${id}`, { method: "PUT", body: { name } })
export const deleteUser = (id) => send(`/users/${id}`, { method: "DELETE" })
export const fetchLegacy = () => send("/legacy", { method: "GET" })
export const adoptLegacy = () => send("/legacy/adopt", { method: "POST" })

const UserContext = createContext({ users: [], user: null, loading: true })

export function UserProvider({ children }) {
    const [users, setUsers] = useState([])
    const [userId, setUserId] = useState(activeUserId)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState("")

    const refresh = useCallback(async () => {
        try {
            const list = await fetchUsers()
            setUsers(list)
            setError("")
            /* The remembered id may be gone - deleted on another device, or a
               fresh browser. Falling back to the only user there is beats
               asking someone to choose from a list of one; with several, the
               choice is theirs to make. */
            setUserId(current => {
                if (list.some(u => u.id === current)) return current
                const next = list.length === 1 ? list[0].id : ""
                activeUserId = next
                remember(next)
                return next
            })
        } catch (e) {
            setError(e.message)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { refresh() }, [refresh])

    const select = useCallback((id) => {
        activeUserId = id
        remember(id)
        setUserId(id)
    }, [])

    const value = {
        users,
        userId,
        user: users.find(u => u.id === userId) || null,
        loading,
        error,
        select,
        refresh,
    }
    return <UserContext.Provider value={value}>{children}</UserContext.Provider>
}

export const useUser = () => useContext(UserContext)
