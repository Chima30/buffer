import { Suspense } from "react";
import { SiteHeader } from "@/components/site-header";
import { OrderView } from "./order-view";

export default function OrderPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-4xl px-5 py-10">
          <SiteHeader />
          <p className="mt-10 text-ink-3">Loading order…</p>
        </main>
      }
    >
      <OrderView />
    </Suspense>
  );
}
