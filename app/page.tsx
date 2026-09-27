import { connection } from "next/server";
import { SubscriptionsController } from "@paypal/paypal-server-sdk";
import { client } from "@/lib/paypal";

export default async function Home() {
  await connection();

  const { result } = await new SubscriptionsController(client).listBillingPlans({
    pageSize: 20,
  });
  const plans = result.plans ?? [];

  return (
    <main className="mx-auto w-full max-w-3xl p-16 font-sans">
      <h1 className="mb-6 text-2xl font-semibold">PayPal billing plans</h1>
      {plans.length === 0 ? (
        <p className="text-zinc-500">No plans found.</p>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {plans.map((plan) => (
            <li key={plan.id} className="flex justify-between py-3">
              <span>{plan.name}</span>
              <span className="font-mono text-sm text-zinc-500">
                {plan.status} · {plan.id}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
