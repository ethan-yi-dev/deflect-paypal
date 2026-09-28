import { connection } from "next/server";
import { getBalances } from "@/lib/paypal";
import { DataTable, money } from "../data-table";

export default async function BalancesPage() {
  await connection();

  const result = await getBalances();

  return (
    <DataTable
      title={`Balances (account ${result.accountId}, as of ${result.asOfTime})`}
      columns={["Currency", "Primary", "Total", "Available", "Withheld"]}
      rows={(result.balances ?? []).map((b) => ({
        key: b.currency,
        cells: [
          b.currency,
          b.primary ? "Yes" : "No",
          money(b.totalBalance),
          money(b.availableBalance),
          money(b.withheldBalance),
        ],
      }))}
    />
  );
}
