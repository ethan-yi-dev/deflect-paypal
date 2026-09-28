import Link from "next/link";

const pages = [
  { href: "/transactions", label: "Transaction search" },
  { href: "/subscriptions", label: "Subscriptions" },
  { href: "/balances", label: "Balances" },
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-3xl p-16 font-sans">
      <h1 className="mb-6 text-2xl font-semibold">PayPal APIs</h1>
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {pages.map((page) => (
          <li key={page.href} className="py-3">
            <Link href={page.href} className="hover:underline">
              {page.label} →
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
