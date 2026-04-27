import { NextResponse } from "next/server";
import { serverClientBoundToCookies } from "@/lib/supabase-server";

// Handles BOTH PKCE code exchange (signInWithOtp from same browser) and
// token_hash verification (admin-generated magic links, cross-browser flows).
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = searchParams.get("next") ?? "/hr/pipeline";

  const supabase = serverClientBoundToCookies();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: type as any,
      token_hash: tokenHash,
    });
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }

  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent("invalid_or_expired_link")}`
  );
}
