import { Suspense } from "react";
import { OrderView } from "./order-view";

export default function OrderPage() {
  return (
    <Suspense
      fallback={
        <main className="enter">
          <p className="text-ink-3">Loading order</p>
        </main>
      }
    >
      <OrderView />
    </Suspense>
  );
}
