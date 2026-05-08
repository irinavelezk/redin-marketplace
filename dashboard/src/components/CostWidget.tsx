// Cost spend widget — appears on every /hr/* page via the HR layout.
// Reads:
//   * daily_llm_cost view for today's UTC cost
//   * cost_kill_switch_overrides for today's UTC override (if any)
//   * env TONO_DAILY_COST_USD_LIMIT (default 10)
// Per onboarding contracts §9.3.

import { serviceClient } from "@/lib/supabase-server";
import { resetCostCap } from "@/lib/cost-cap";

export async function CostWidget(): Promise<JSX.Element> {
  const supa = serviceClient();

  // CRITICAL: UTC. Stream A's view buckets by UTC day; using local would
  // misalign the displayed "today" vs the agent's kill-switch.
  const todayUtc = new Date().toISOString().slice(0, 10);
  const cap = Number(process.env.TONO_DAILY_COST_USD_LIMIT ?? "10");

  const [{ data: spend }, { data: override }] = await Promise.all([
    supa
      .from("daily_llm_cost")
      .select("cost_usd, prompt_tokens, completion_tokens, turn_count")
      .eq("utc_date", todayUtc)
      .maybeSingle(),
    supa
      .from("cost_kill_switch_overrides")
      .select("reset_by, reset_at, reason")
      .eq("override_date", todayUtc)
      .maybeSingle(),
  ]);

  const cost = Number(spend?.cost_usd ?? 0);
  const blocking = cost >= cap && !override;
  const ratio = cap > 0 ? Math.min(cost / cap, 1) : 0;
  const barColor = blocking
    ? "bg-rose-500"
    : ratio > 0.7
      ? "bg-amber-500"
      : "bg-emerald-500";

  return (
    <aside className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-700">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-medium">
          Toño hoy: ${cost.toFixed(2)} / ${cap.toFixed(2)} USD
        </span>
        <div className="flex-1 min-w-[120px] max-w-[300px] h-2 bg-slate-200 rounded-full overflow-hidden">
          <div
            className={`h-full ${barColor}`}
            style={{ width: `${(ratio * 100).toFixed(0)}%` }}
          />
        </div>
        {spend?.turn_count != null && (
          <span className="text-slate-500">
            {spend.turn_count} turnos · {(spend.prompt_tokens ?? 0).toLocaleString()}/
            {(spend.completion_tokens ?? 0).toLocaleString()} tokens
          </span>
        )}
        {override ? (
          <span className="bg-amber-100 text-amber-800 rounded-full px-2 py-0.5">
            override activo (por {override.reset_by})
          </span>
        ) : blocking ? (
          <span className="bg-rose-100 text-rose-800 rounded-full px-2 py-0.5">
            cap alcanzado — Toño bloqueando new convs
          </span>
        ) : null}
        {!override && (
          <form action={resetCostCap}>
            <button
              type="submit"
              className="text-xs bg-slate-700 hover:bg-slate-800 text-white rounded px-3 py-0.5"
            >
              Reset cost cap
            </button>
          </form>
        )}
      </div>
    </aside>
  );
}
