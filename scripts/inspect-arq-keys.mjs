import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { data } = await sb.from("arquitectos_mirror").select("data").limit(1);
console.log("keys:", Object.keys(data[0].data).sort());
console.log("\nfull:", JSON.stringify(data[0].data, null, 2));
