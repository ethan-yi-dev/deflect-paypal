> [!TIP]
> **PayPal AI Hackathon**
> 
> Win part of $69,750 in total prizes
> 
> Build What's Next with PayPal and AI is a global online hackathon inviting developers, designers, founders, students, and builders to create something new using PayPal and AI.
> 
> There are no prescribed problem statements and no set of tracks. Build an agent, an app, an automation, a new payment experience, a business tool, a social product, or something we haven't thought of yet.
> 
> https://paypalaihackathon.devpost.com

# PayPal SDK data pages

A Next.js app that reads sandbox data with the [PayPal TypeScript Server SDK](https://github.com/paypal/PayPal-TypeScript-Server-SDK) (`@paypal/paypal-server-sdk`) and shows it in simple tables.

## Origin and attribution

Deflect is based on the official PayPal starter repository,
[`paypaldev/hackathon-paypal-ag-grid-boilerplate`](https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate),
at commit [`8de661bda9f6dd10c5d930767e8cb185a15f6b83`](https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate/tree/8de661bda9f6dd10c5d930767e8cb185a15f6b83).
The initial Deflect codebase matches that baseline. The following material
was inherited from the starter:

- **PayPal integration:** `lib/paypal.ts`, including the sandbox SDK client and transaction, subscription-plan, and balance queries; `env.example`.
- **Pages and UI:** `app/page.tsx`, the pages under `app/transactions/`, `app/subscriptions/`, and `app/balances/`, plus `app/data-table.tsx`, `app/layout.tsx`, `app/globals.css`, and `app/favicon.ico`.
- **Project scaffolding and assets:** `package.json`, the initial `package-lock.json`, `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs`, `.gitignore`, the assets under `public/`, and `AGENTS.md` / `CLAUDE.md`.
- **Documentation:** the hackathon introduction, local setup instructions, SDK explanations, data-page descriptions, and sandbox response examples in this README.

Subsequent original additions and modifications are contributions to Deflect;
the inherited portions retain the attribution above.

## License

Original contributions to Deflect are licensed under the MIT License; see
[`LICENSE`](LICENSE). The recorded upstream starter has no `LICENSE` file,
so this project's MIT license does **not** cover the inherited material or
grant permission on behalf of its rights holders. Third-party dependencies
and assets remain subject to their respective licenses.

## Run locally

Requires Node.js 20.9 or later and a PayPal sandbox REST app ([developer.paypal.com](https://developer.paypal.com/dashboard/applications/sandbox)). The Transaction Search pages also need the app's **Transaction search** feature enabled.

```bash
npm install
cp env.example .env.local   # then fill in the values
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Next.js only loads the dotted `.env.local`; it is git-ignored, so credentials stay out of the repo.

Other scripts: `npm run build` (production build), `npm run start` (serve the build), `npm run lint`.

## Deflect frontend preview

The home page (`/`) is a single-page dispute workspace with a case summary,
customer complaint, payment and fulfillment facts, suggested actions,
Policy/JEV results, action previews, and an audit trail. It uses hardcoded
fixtures in `app/demo-dispute.ts`; it does not call PayPal or an AI service.
The frontend preview can run without PayPal credentials and uses system fonts.

Select **Missing tracking**, **Delivery confirmed**, or **Injection attempt**
to explore the predefined scenarios. **Run demo analysis** replays a fixed
recommendation. **Preview action → Simulate action** adds an in-memory audit
entry; no message, evidence, or refund is sent. Reloading resets the demo.
The delivery scenario uses explicitly fictional shipment data.

Start with `npm run dev`, then open `http://localhost:3000`.
The original live SDK pages remain available at `/transactions`,
`/subscriptions`, and `/balances` and require configured PayPal credentials.

## How it works

Every SDK call lives in [`lib/paypal.ts`](lib/paypal.ts), which owns the sandbox `Client`. Each original data page is a server component that calls one of those functions and renders the result with [`app/data-table.tsx`](app/data-table.tsx). These data pages call `await connection()` so they render per request with live data instead of being prerendered at build time. The home-page frontend preview is independent of this SDK integration.

## Data pages

| Page | `lib/paypal.ts` function | SDK call | Shows |
|---|---|---|---|
| [`/transactions`](app/transactions/page.tsx) | `getRecentTransactions()` | `TransactionSearchController.searchTransactions` | First 20 transactions from the last 30 days |
| [`/subscriptions`](app/subscriptions/page.tsx) | `getBillingPlans()` | `SubscriptionsController.listBillingPlans` | First 20 subscription billing plans |
| [`/balances`](app/balances/page.tsx) | `getBalances()` | `TransactionSearchController.searchBalances` | Current balance per currency |

The examples below are real sandbox responses as the SDK returns them (camelCase fields, not the REST API's snake_case).

### `/transactions`

`searchTransactions({ startDate, endDate, fields: 'all', pageSize: 20 })` returns `transactionDetails[]`. Transaction Search accepts at most a 31-day range, and new activity can take up to three hours to appear. `fields: 'all'` adds `payerInfo` and the other sections; without it only `transactionInfo` is returned.

One `transactionDetails` item (a payout):

```json
{
  "transactionInfo": {
    "transactionId": "10890159B0554833L",
    "paypalReferenceId": "1FX78001X2681601H",
    "paypalReferenceIdType": "TXN",
    "transactionEventCode": "T0001",
    "transactionInitiationDate": "2026-09-23T12:11:56Z",
    "transactionUpdatedDate": "2026-09-23T12:11:56Z",
    "transactionAmount": { "currencyCode": "USD", "value": "-1.00" },
    "feeAmount": { "currencyCode": "USD", "value": "-0.25" },
    "transactionStatus": "P",
    "transactionSubject": "Probe payout",
    "transactionNote": "probe",
    "endingBalance": { "currencyCode": "USD", "value": "4997.50" },
    "availableBalance": { "currencyCode": "USD", "value": "4997.50" },
    "customField": "probe-1",
    "protectionEligibility": "02",
    "instrumentType": "PayPal",
    "instrumentSubType": "PayPal Wallet"
  },
  "payerInfo": {
    "emailAddress": "probe-receiver@example.com",
    "phoneNumber": { "countryCode": "1", "nationalNumber": "2028188144" },
    "addressStatus": "N",
    "payerName": {}
  },
  "shippingInfo": { "name": "John, Doe" },
  "cartInfo": {},
  "storeInfo": {},
  "auctionInfo": {},
  "incentiveInfo": {}
}
```

`transactionEventCode` is a [PayPal T-code](https://developer.paypal.com/docs/transaction-search/transaction-event-codes/) (`T0001` = payout). `transactionStatus` is `S` success, `P` pending, `D` denied, `V` reversed or `F` partially refunded.

### `/subscriptions`

`listBillingPlans({ pageSize: 20, prefer: 'return=representation' })` returns `plans[]`. The `prefer` header makes the list include `billingCycles` and `paymentPreferences`, which the default list response omits.

One `plans` item (a plan with a 30-day trial):

```json
{
  "id": "P-3RM52651TF551181NNKZ4BHQ",
  "productId": "AGGRID-CLOUD-STORAGE",
  "name": "Cloud Storage Basic (100 GB)",
  "status": "ACTIVE",
  "description": "Cloud Storage: Cloud Storage Basic (100 GB)",
  "billingCycles": [
    {
      "frequency": { "intervalUnit": "DAY", "intervalCount": 30 },
      "tenureType": "TRIAL",
      "sequence": 1,
      "totalCycles": 1
    },
    {
      "pricingScheme": {
        "version": 1,
        "fixedPrice": { "currencyCode": "USD", "value": "2.99" },
        "createTime": "2026-09-23T12:05:50Z",
        "updateTime": "2026-09-23T12:05:50Z"
      },
      "frequency": { "intervalUnit": "MONTH", "intervalCount": 1 },
      "tenureType": "REGULAR",
      "sequence": 2,
      "totalCycles": 0
    }
  ],
  "paymentPreferences": {
    "autoBillOutstanding": true,
    "setupFee": { "currencyCode": "USD", "value": "0.0" },
    "setupFeeFailureAction": "CONTINUE",
    "paymentFailureThreshold": 3
  },
  "quantitySupported": false,
  "createTime": "2026-09-23T12:05:50Z",
  "updateTime": "2026-09-23T12:05:50Z",
  "links": [
    {
      "href": "https://api.sandbox.paypal.com/v1/billing/plans/P-3RM52651TF551181NNKZ4BHQ",
      "rel": "self",
      "method": "GET"
    }
  ]
}
```

`totalCycles: 0` on the `REGULAR` cycle means the plan bills until cancelled.

### `/balances`

`searchBalances({})` returns the current balances. Pass `asOfTime` to get the balance at an earlier point in time.

```json
{
  "balances": [
    {
      "currency": "USD",
      "totalBalance": { "currencyCode": "USD", "value": "3537.71" },
      "availableBalance": { "currencyCode": "USD", "value": "3537.71" },
      "withheldBalance": { "currencyCode": "USD", "value": "0.00" }
    }
  ],
  "accountId": "QXJYHKET9Y4VC",
  "asOfTime": "2026-09-28T10:59:59Z",
  "lastRefreshTime": "2026-09-28T10:59:59Z"
}
```
