import {
  Client,
  Environment,
  LogLevel,
  SubscriptionsController,
  TransactionSearchController,
} from '@paypal/paypal-server-sdk';

const client = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID!,
    oAuthClientSecret: process.env.PAYPAL_SECRET!,
  },
  timeout: 0,
  environment: Environment.Sandbox,
  logging: {
    logLevel: LogLevel.Info,
    logRequest: {
      logBody: true
    },
    logResponse: {
      logHeaders: true
    }
  },
});

// Transactions from the last 30 days (Transaction Search allows at most 31).
export async function getRecentTransactions() {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  const { result } = await new TransactionSearchController(client).searchTransactions({
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    fields: 'all', // include payer info, not just transaction info
    pageSize: 20,
  });
  return result.transactionDetails ?? [];
}

// return=representation includes billing cycles and payment preferences in the list.
export async function getBillingPlans() {
  const { result } = await new SubscriptionsController(client).listBillingPlans({
    pageSize: 20,
    prefer: 'return=representation',
  });
  return result.plans ?? [];
}

export async function getBalances() {
  const { result } = await new TransactionSearchController(client).searchBalances({});
  return result;
}
