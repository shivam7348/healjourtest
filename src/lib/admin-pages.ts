import type { ModuleId } from "../../server/core/portal/access";

// scope "platform": data shared by every tenant (catalog, connectors, settings); only platform admins get these pages.
// scope "workspace": data owned by a tenant (labs, Flabs accounts, bookings, logs); filtered to the admin's workspaces.
export type PageScope = "platform" | "workspace";
type PageDefinition = { label: string; section: string; module: ModuleId; scope: PageScope; api?: readonly string[] };

// Order here is also the order used in the Super Admin editor and access summaries.
export const PAGES = {
  "integration-hub": { label: "Integration Hub", section: "Integration Products", module: "integrations", scope: "platform", api: ["/api/hub"] },
  "connector-framework": { label: "Connector Framework", section: "Integration Products", module: "integrations", scope: "platform", api: ["/api/framework"] },
  integrations: { label: "Integrations", section: "Integration Products", module: "integrations", scope: "platform", api: ["/api/integrations"] },
  "integration-studio": { label: "Integration Studio", section: "Integration Products", module: "integrations", scope: "platform" },
  "connector-marketplace": { label: "Connector Marketplace", section: "Integration Products", module: "integrations", scope: "platform" },
  "core-layers": { label: "Core Layers", section: "Integration Products", module: "integrations", scope: "platform", api: ["/api/core"] },
  "lab-cases": { label: "Lab Cases", section: "Labs & Catalogue", module: "labs", scope: "workspace", api: ["/api/portal/cases"] },
  "labs-users": { label: "Labs & Users", section: "Labs & Catalogue", module: "labs", scope: "workspace", api: ["/api/portal/labs", "/api/portal/users"] },
  organizations: { label: "Organizations", section: "Labs & Catalogue", module: "labs", scope: "platform" },
  "test-catalog": { label: "Test Catalog", section: "Labs & Catalogue", module: "catalog", scope: "platform", api: ["/api/catalog", "/api/flabs/test"] },
  "corporate-mapping": { label: "Corporate Mapping", section: "Labs & Catalogue", module: "catalog", scope: "workspace" },
  "test-builder": { label: "Test Builder", section: "Labs & Catalogue", module: "catalog", scope: "platform", api: ["/api/builder", "/api/catalog/tests/bulk"] },
  "orders-bookings": { label: "Orders & Bookings", section: "Orders & Data", module: "orders", scope: "workspace", api: ["/api/flabs/bookings", "/api/flabs/prebookings", "/api/flabs/booking-options", "/api/booking-form"] },
  "booking-tracker": { label: "Booking Tracker", section: "Orders & Data", module: "orders", scope: "workspace" },
  "results-smart-reports": { label: "Results & Smart Reports", section: "Orders & Data", module: "orders", scope: "workspace", api: ["/api/flabs/results", "/api/flabs/parameter-ranges"] },
  "booking-calendar": { label: "Booking Calendar", section: "Orders & Data", module: "orders", scope: "workspace", api: ["/api/calendar", "/api/appointments", "/api/staff"] },
  "transactions-logs": { label: "Transactions & Logs", section: "Orders & Data", module: "logs", scope: "workspace", api: ["/api/logs"] },
  "api-webhooks": { label: "API & Webhooks", section: "Developers", module: "developers", scope: "platform" },
  "partner-access": { label: "Partner Access", section: "Developers", module: "developers", scope: "platform", api: ["/api/partner-access"] },
  "monitoring-sla": { label: "Monitoring & SLA", section: "Developers", module: "developers", scope: "platform", api: ["/api/monitoring"] },
  settings: { label: "Settings", section: "Settings", module: "settings", scope: "platform", api: ["/api/settings"] }
} as const satisfies Record<string, PageDefinition>;

export type PageId = keyof typeof PAGES;
export const ALL_PAGES = Object.keys(PAGES) as PageId[];
export const isPageId = (id: string): id is PageId => Object.hasOwn(PAGES, id);
export const WORKSPACE_PAGES = ALL_PAGES.filter(id => PAGES[id].scope === "workspace");

// Prefer narrower matches such as /api/catalog/tests/bulk over /api/catalog.
export const PAGE_API_PREFIXES = ALL_PAGES
  .flatMap(id => ((PAGES[id] as PageDefinition).api ?? []).map(prefix => ({ id, prefix })))
  .sort((a, b) => b.prefix.length - a.prefix.length);
