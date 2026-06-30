// Skip Senders — module-local AP settings tab.
//
// Round-7 reorg (PR #238): Skip Senders previously lived as a card on the
// global /settings page, but its only purpose is to gate AP email intake.
// It now lives at /accounts-payable/settings/skip-senders as the 4th tab in
// the AP Settings hub, sitting alongside Vendor Rules, Aliases, and Vendor
// Groups. The underlying SkipSendersList component is unchanged — we just
// import it from Settings.tsx (re-exported there) and wrap it with the same
// h1 + intro copy the other AP-settings tabs use.

import { SkipSendersList } from "@/pages/Settings";

export default function SkipSenders() {
  return (
    <div className="px-8 pt-6 pb-12 max-w-[1100px] mx-auto">
      <div className="mb-1">
        <h1 className="text-xl font-semibold tracking-tight">Skip Senders</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Senders on this list have their emails auto-rejected before any AP
        processing. Use for monthly subscriptions, utilities on auto-pay, and
        other senders that don&apos;t need review. You can add a sender
        directly from any invoice via the drawer&apos;s{" "}
        <span className="font-medium">Skip sender…</span> button.
      </p>
      <SkipSendersList />
    </div>
  );
}
