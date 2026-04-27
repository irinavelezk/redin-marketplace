import { NextResponse } from "next/server";
import { serverClientBoundToCookies } from "@/lib/supabase-server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/hr/pipeline";

  if (code) {
    const supabase = serverClientBoundToCookies();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }
  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent("invalid_or_expired_link")}`
  );
}
