import { Building, UserRound } from "lucide-react";

export type WorkspaceTagData = { id: string; tenantId: string; name: string } | null | undefined;
export type CreatorData = { id: string; name: string; email?: string; via?: { id: string; name: string; email?: string } } | null | undefined;

/** Which tenant a row belongs to: tenant ID + workspace name. Nothing when the row has no workspace. */
export function WorkspaceTag({ workspace, compact = false }: { workspace: WorkspaceTagData; compact?: boolean }) {
  if (!workspace) return null;
  return <span className="ws-tag" title={`Workspace ${workspace.name} · ${workspace.tenantId}`}>
    <Building size={11} /> {compact ? workspace.tenantId : <>{workspace.tenantId} · {workspace.name}</>}
  </span>;
}

/** "Created by Name" with the user ID on hover; names the Super Admin too when it was done via "Login as". */
export function CreatedBy({ creator, at, label = "Created by" }: { creator: CreatorData; at?: string; label?: string }) {
  if (!creator) return null;
  const when = at ? ` · ${new Date(at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : "";
  const title = `${creator.name}${creator.email ? ` <${creator.email}>` : ""}\nUser ID: ${creator.id}` +
    (creator.via ? `\nDone by Super Admin ${creator.via.name} (ID ${creator.via.id}) using "Login as"` : "");
  return <span className="created-by" title={title}>
    <UserRound size={11} /> {label} {creator.name}{creator.via && <em> via {creator.via.name}</em>}<code>{creator.id}</code>{when}
  </span>;
}
