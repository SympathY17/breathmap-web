import type { AnchorHTMLAttributes, ReactNode } from "react";
import type { Navigation } from "@/lib/editable-settings";

export function NavigationAction({ navigation, recordId, datasourceId: _datasourceId, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { navigation: Navigation; recordId?: string; datasourceId?: string; children?: ReactNode }) {
  const raw = navigation?.destination || "/";
  const url = new URL(raw, window.location.origin);
  if (recordId) url.searchParams.set("recordId", recordId);
  const safe = url.protocol === "https:" || url.protocol === "http:" && url.origin === window.location.origin;
  const href = safe ? (url.origin === window.location.origin ? url.pathname + url.search + url.hash : url.href) : "#";
  return <a {...props} href={href} {...(navigation?.openIn === "TAB" ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}</a>;
}
