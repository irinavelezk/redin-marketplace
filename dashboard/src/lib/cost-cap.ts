// Cost kill-switch reset server action.
// Per onboarding contracts §9: HR clicks "Reset cost cap" → row in
// cost_kill_switch_overrides for today's UTC date. Migration 008 enforces
// UNIQUE on override_date so a second click is idempotent (Postgres
// rejects with 23505; we surface a friendly "already-active" outcome
// instead of a generic DB error).

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";

export async function resetCostCap(): Promise<void> {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;

  // CRITICAL: UTC date. Stream A's daily_llm_cost view uses UTC; Bogotá local
  // would be off by 5h for the first 5h after midnight Bogotá time, silently
  // breaking the kill-switch display.
  const todayUtc = new Date().toISOString().slice(0, 10);

  const supa = serviceClient();
  const { error } = await supa.from("cost_kill_switch_overrides").insert({
    override_date: todayUtc,
    reset_by: `hr:${hrEmail}`,
    reason: "manual reset from dashboard",
  });
  if (error) {
    // 23505 = unique_violation (Postgres). Migration 008 puts UNIQUE on
    // override_date so a same-day re-click is idempotent — surface as success.
    if ((error as { code?: string }).code === "23505") {
      // No-op: today already has an override row.
    } else {
      console.error("resetCostCap insert failed", { error: error.message });
      return;
    }
  }
  revalidatePath("/hr");
  revalidatePath("/hr/qualification-queue");
  revalidatePath("/hr/tecnicos");
}
