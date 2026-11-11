
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("BankGuard Supabase credentials are missing.");
}

// Separate sessions for Customer and Admin
export const customerSupabase = createClient(
  supabaseUrl,
  supabaseKey,
  {
    auth: {
      storageKey: "bankguard-customer-auth",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);

export const adminSupabase = createClient(
  supabaseUrl,
  supabaseKey,
  {
    auth: {
      storageKey: "bankguard-admin-auth",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);
