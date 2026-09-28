import { connection } from "next/server";
import { getRecentTransactions } from "@/lib/paypal";
import { DataTable, money } from "../data-table";

export default async function TransactionsPage() {
  await connection();
  const transactions = await getRecentTransactions();

  return (
    <DataTable
      title="Transactions (last 30 days)"
      columns={["Date", "Type", "Status", "Amount", "Fee", "Ending balance", "Counterparty", "Subject", "Instrument", "ID"]}
      rows={transactions.map(({ transactionInfo: t, payerInfo: p }) => ({
        key: t!.transactionId!,
        cells: [
          t?.transactionInitiationDate?.slice(0, 10),
          t?.transactionEventCode,
          t?.transactionStatus,
          money(t?.transactionAmount),
          money(t?.feeAmount),
          money(t?.endingBalance),
          p?.emailAddress,
          t?.transactionSubject,
          t?.instrumentSubType,
          t?.transactionId,
        ],
      }))}
    />
  );
}
