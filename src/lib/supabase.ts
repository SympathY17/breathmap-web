import { createClient } from "@supabase/supabase-js";

const configuredUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? "";
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
export const isConfigured = /^https:\/\/[^/]+\.supabase\.co$/.test(configuredUrl) && /^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey);
export const supabase = isConfigured ? createClient(configuredUrl, publishableKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
}) : null;

export function requireSupabase() {
  if (!supabase) throw new Error("BreathMap is not configured. Set the project URL and publishable key first.");
  return supabase;
}
