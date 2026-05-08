// HR section layout — wraps every /hr/* route with the cost-spend widget.
// Auth is enforced per-page (each /hr/*/page.tsx redirects to /login if no
// session); this layout assumes that and only adds operational chrome.

import { CostWidget } from "@/components/CostWidget";

export const dynamic = "force-dynamic";

export default function HrLayout({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <CostWidget />
      <div className="px-4 py-4">{children}</div>
    </div>
  );
}
