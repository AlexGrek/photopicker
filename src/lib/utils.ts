import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Abbreviates `/Users/<name>/…` to `~/…` for compact display of home-relative paths. */
export function shortenPath(p: string): string {
  const prefix = "/Users/";
  if (p.startsWith(prefix)) {
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf("/");
    return slash === -1 ? "~" : "~/" + rest.slice(slash + 1);
  }
  return p;
}
