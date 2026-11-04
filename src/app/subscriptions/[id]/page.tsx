import { Suspense } from "react";
import { SubscriptionView } from "./subscription-view";

export default function SubscriptionPage() {
  return (
    <Suspense
      fallback={
        <main className="enter">
          <p className="text-ink-3">Loading subscription</p>
        </main>
      }
    >
      <SubscriptionView />
    </Suspense>
  );
}
