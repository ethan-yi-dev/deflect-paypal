import { connection } from "next/server";
import { getBillingPlans } from "@/lib/paypal";
import { DataTable, money } from "../data-table";

export default async function SubscriptionsPage() {
  await connection();

  const plans = await getBillingPlans();

  return (
    <DataTable
      title="Subscription billing plans"
      columns={["Name", "Product", "Status", "Price", "Billed every", "Trial", "Setup fee", "Created", "ID"]}
      rows={plans.map((plan) => {
        const regular = plan.billingCycles?.find((c) => c.tenureType === "REGULAR");
        const trial = plan.billingCycles?.find((c) => c.tenureType === "TRIAL");
        return {
          key: plan.id!,
          cells: [
            plan.name,
            plan.productId,
            plan.status,
            money(regular?.pricingScheme?.fixedPrice),
            regular && `${regular.frequency.intervalCount ?? 1} ${regular.frequency.intervalUnit}`,
            trial
              ? `${(trial.totalCycles ?? 1) * (trial.frequency.intervalCount ?? 1)} ${trial.frequency.intervalUnit}`
              : "None",
            money(plan.paymentPreferences?.setupFee),
            plan.createTime?.slice(0, 10),
            plan.id,
          ],
        };
      })}
    />
  );
}
