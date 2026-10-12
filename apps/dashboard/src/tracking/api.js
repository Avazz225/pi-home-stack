const TRACKING_API = process.env.REACT_APP_TRACKING_API_ENDPOINT || ""

async function request(path, options) {
    const r = await fetch(`${TRACKING_API}${path}`, options && {
        ...options,
        headers: { "Content-Type": "application/json" },
        body: options.body ? JSON.stringify(options.body) : undefined,
    })
    if (!r.ok) throw new Error(r.statusText)
    return r.json()
}

export const fetchHierarchy = () => request("/hierarchy")
export const fetchDashboardSummary = () => request("/dashboard/summary")

export const createMilestone = (data) => request("/milestones", { method: "POST", body: data })
export const updateMilestone = (id, data) => request(`/milestones/${id}`, { method: "PUT", body: data })
export const deleteMilestone = (id) => request(`/milestones/${id}`, { method: "DELETE" })

export const createFeature = (data) => request("/features", { method: "POST", body: data })
export const updateFeature = (id, data) => request(`/features/${id}`, { method: "PUT", body: data })
export const deleteFeature = (id) => request(`/features/${id}`, { method: "DELETE" })

export const createWorkPackage = (data) => request("/work-packages", { method: "POST", body: data })
export const updateWorkPackage = (id, data) => request(`/work-packages/${id}`, { method: "PUT", body: data })
export const deleteWorkPackage = (id) => request(`/work-packages/${id}`, { method: "DELETE" })

export const createCard = (workPackageId, data) => request(`/work-packages/${workPackageId}/cards`, { method: "POST", body: data })
export const deleteCard = (id) => request(`/cards/${id}`, { method: "DELETE" })

export const fetchDependencies = (entityType) => request(`/dependencies?entity_type=${entityType}`)
export const fetchDependencyChains = (entityType) => request(`/dependencies/chains?entity_type=${entityType}`)
export const createDependency = (data) => request("/dependencies", { method: "POST", body: data })
export const deleteDependency = (id) => request(`/dependencies/${id}`, { method: "DELETE" })

export const fetchRisks = () => request("/risks")
export const createRisk = (data) => request("/risks", { method: "POST", body: data })
export const updateRisk = (id, data) => request(`/risks/${id}`, { method: "PUT", body: data })
export const deleteRisk = (id) => request(`/risks/${id}`, { method: "DELETE" })
export const createRiskLink = (riskId, data) => request(`/risks/${riskId}/links`, { method: "POST", body: data })
export const deleteRiskLink = (id) => request(`/risk-links/${id}`, { method: "DELETE" })

export const fetchLessons = (params = {}) => {
    const qs = new URLSearchParams(params).toString()
    return request(`/lessons${qs ? `?${qs}` : ""}`)
}
export const createLesson = (data) => request("/lessons", { method: "POST", body: data })
export const updateLesson = (id, data) => request(`/lessons/${id}`, { method: "PUT", body: data })
export const deleteLesson = (id) => request(`/lessons/${id}`, { method: "DELETE" })
export const createLessonLink = (lessonId, data) => request(`/lessons/${lessonId}/links`, { method: "POST", body: data })
export const deleteLessonLink = (id) => request(`/lesson-links/${id}`, { method: "DELETE" })

export const fetchConversations = (featureId) => request(`/features/${featureId}/conversations`)
export const createConversation = (featureId, data) => request(`/features/${featureId}/conversations`, { method: "POST", body: data })
export const deleteConversation = (id) => request(`/conversations/${id}`, { method: "DELETE" })
