// Small fetch helpers for the Lab Portal. Session cookie is sent automatically (same origin).

export type Role = "healjour_admin" | "lab_admin" | "lab_staff" | "lab_viewer";
export type PortalUser = { id: string; email: string; name: string; role: Role; labId: string | null; active: boolean; mustChangePassword: boolean; lastLoginAt?: string; createdAt: string; isSuperAdmin?: boolean; adminRoleId?: string };
export type PortalLab = { id: string; code: string; name: string; city?: string; contactEmail?: string; active: boolean; users?: number; openCases?: number; unseen?: number };
export type AuthState = { setupNeeded: boolean; setupKeyRequired: boolean; user: PortalUser | null; lab: PortalLab | null; permissions: string[]; modules?: string[]; adminPermissions?: string[]; superAdmin?: boolean };

export type CaseStatus = "new" | "accepted" | "sample_collected" | "processing" | "report_ready" | "completed" | "rejected" | "cancelled";
export type CaseSummary = {
  id: string; caseNo: string; labId: string; labName: string;
  patient: { name: string; age: number; ageUnit: string; gender: string; phone?: string; healjourId?: string };
  tests: Array<{ code: string; name: string }>; priority: string; collection: string; scheduledAt?: string;
  status: CaseStatus; reportCount: number; resultCount: number; createdAt: string; updatedAt: string; lastLabUpdateAt?: string; unseen: boolean;
};
export type ResultRow = { testCode: string; testName: string; value: string; unit: string; referenceRange: string; flag: "" | "normal" | "low" | "high" | "abnormal" };
export type LabCase = Omit<CaseSummary, "reportCount" | "resultCount" | "unseen"> & {
  notes?: string; results: ResultRow[];
  reports: Array<{ id: string; fileName: string; mimeType: string; size: number; uploadedAt: string; uploadedBy: string; note?: string }>;
  timeline: Array<{ at: string; by: string; role: string; action: string; status?: CaseStatus; note?: string }>;
};

export const ROLE_LABEL: Record<Role, string> = {
  healjour_admin: "Healjour admin", lab_admin: "Lab admin", lab_staff: "Lab staff", lab_viewer: "Viewer"
};
export const STATUS_LABEL: Record<CaseStatus, string> = {
  new: "New", accepted: "Accepted", sample_collected: "Sample collected", processing: "Processing",
  report_ready: "Report ready", completed: "Completed", rejected: "Rejected", cancelled: "Cancelled"
};

export async function api<T = Record<string, unknown>>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin"
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status}).`);
  return data as T;
}

export const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
