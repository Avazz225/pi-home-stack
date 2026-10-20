import { userHeaders } from "../common/user"

const STUDY_API = process.env.REACT_APP_STUDY_API_ENDPOINT || ""

async function request(path, options) {
    /* The init object is built unconditionally now. It used to be passed only
       when there were options, so a plain GET went out with no headers at all -
       and the user header has to be on every call, reads included. */
    const r = await fetch(`${STUDY_API}${path}`, {
        ...options,
        headers: { "Content-Type": "application/json", ...userHeaders() },
        body: options && options.body ? JSON.stringify(options.body) : undefined,
    })
    if (!r.ok) throw new Error(r.statusText)
    return r.json()
}

export const fetchOverview = () => request("/overview")

export const fetchCategories = () => request("/categories")
export const createCategory = (data) => request("/categories", { method: "POST", body: data })
export const updateCategory = (id, data) => request(`/categories/${id}`, { method: "PUT", body: data })
export const deleteCategory = (id) => request(`/categories/${id}`, { method: "DELETE" })

export const fetchModules = () => request("/modules")
export const createModule = (data) => request("/modules", { method: "POST", body: data })
export const updateModule = (id, data) => request(`/modules/${id}`, { method: "PUT", body: data })
export const deleteModule = (id) => request(`/modules/${id}`, { method: "DELETE" })

export const fetchPlans = () => request("/plans")
export const fetchPlan = (id) => request(`/plans/${id}`)
export const createPlan = (data) => request("/plans", { method: "POST", body: data })
export const updatePlan = (id, data) => request(`/plans/${id}`, { method: "PUT", body: data })
export const deletePlan = (id) => request(`/plans/${id}`, { method: "DELETE" })
export const activatePlan = (id) => request(`/plans/${id}/activate`, { method: "POST" })
export const adoptPlan = (id) => request(`/plans/${id}/adopt`, { method: "POST" })

export const createPlanEntry = (planId, data) => request(`/plans/${planId}/entries`, { method: "POST", body: data })
export const updatePlanEntry = (id, data) => request(`/plan-entries/${id}`, { method: "PUT", body: data })
export const deletePlanEntry = (id) => request(`/plan-entries/${id}`, { method: "DELETE" })

export const fetchSettings = () => request("/settings")
export const saveSettings = (data) => request("/settings", { method: "PUT", body: data })

/* Data from before there were users. Offered for adoption in the settings;
   nobody is given it automatically, because whose it is cannot be derived. */
export const legacyStatus = () => request("/legacy")
export const adoptLegacy = () => request("/legacy/adopt", { method: "POST" })
