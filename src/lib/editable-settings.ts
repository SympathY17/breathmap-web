export interface Navigation { action?: string; destination?: string; openIn?: string; }

export function useTextSetting({ initialValue }: { name?: string; label?: string; initialValue: string }) { return initialValue; }
export function useNavigationSetting({ initialValue }: { name?: string; label?: string; initialValue: Navigation }) { return initialValue; }
export function useNavigation() {
  return (navigation: Navigation | string) => {
    const raw = typeof navigation === "string" ? navigation : navigation.destination;
    if (!raw) return;
    const url = new URL(raw, window.location.origin);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.origin === window.location.origin)) return;
    if (typeof navigation !== "string" && navigation.openIn === "TAB") window.open(url.href, "_blank", "noopener,noreferrer");
    else window.location.assign(url.href);
  };
}
