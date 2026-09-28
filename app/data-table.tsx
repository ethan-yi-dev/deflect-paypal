import Link from "next/link";
import type { ReactNode } from "react";

type Money = { value: string; currencyCode: string } | undefined;

export const money = (m: Money) => (m ? `${m.value} ${m.currencyCode}` : "");

export function DataTable({
  title,
  columns,
  rows,
}: {
  title: string;
  columns: string[];
  rows: { key: string; cells: ReactNode[] }[];
}) {
  return (
    <main className="mx-auto w-full max-w-6xl p-16 font-sans">
      <Link href="/" className="text-sm text-zinc-500">← Home</Link>
      <h1 className="my-6 text-2xl font-semibold">{title}</h1>
      {rows.length === 0 ? (
        <p className="text-zinc-500">No data found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
              <tr>
                {columns.map((column) => (
                  <th key={column} className="whitespace-nowrap px-3 py-2 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {rows.map((row) => (
                <tr key={row.key}>
                  {row.cells.map((cell, i) => (
                    <td key={columns[i]} className="whitespace-nowrap px-3 py-2">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
