import { Elysia, t } from "elysia";
import { db } from "@repo/db";
import { hyperliquidInvoices, users } from "@repo/db/schema";
import { eq } from "drizzle-orm";
import * as hl from "@nktkas/hyperliquid";

// Initialize Hyperliquid InfoClient for reading data
const transport = new hl.HttpTransport();
const infoClient = new hl.InfoClient({ transport });

// Define the context type that includes currentUser
interface AuthenticatedContext {
  currentUser: { walletAddress: string };
}

export const hyperliquidRoutes = new Elysia({ prefix: "/hyperliquid" })
  // Create a new invoice
  .post("/invoices", 
    async ({ body, currentUser, set }: any) => {
      try {
        // Get the creator's user record
        const creator = await db.select().from(users).where(eq(users.evm_address, currentUser.walletAddress)).get();
        if (!creator) {
          set.status = 404;
          return { error: "User not found" };
        }

        // Validate token format (should be like "USDC:0x...")
        if (!body.token.includes(":0x")) {
          set.status = 400;
          return { error: "Invalid token format. Expected format: 'TOKEN:0x...'" };
        }

        // Validate amount is a valid number string
        if (isNaN(parseFloat(body.amount)) || parseFloat(body.amount) <= 0) {
          set.status = 400;
          return { error: "Amount must be a valid positive number" };
        }

        // Create the invoice
        const invoice = await db.insert(hyperliquidInvoices).values({
          creatorId: creator.id,
          payerAddress: body.payerAddress.toLowerCase(),
          token: body.token,
          amount: body.amount,
          description: body.description,
        }).returning().get();

        return invoice;
      } catch (error) {
        console.error("Error creating invoice:", error);
        set.status = 500;
        return { error: "Failed to create invoice" };
      }
    },
    {
      body: t.Object({
        payerAddress: t.String({ error: "Payer address is required" }),
        token: t.String({ error: "Token is required" }),
        amount: t.String({ error: "Amount is required" }),
        description: t.Optional(t.String()),
      })
    }
  )

  // Get invoices for the authenticated user
  .get("/invoices", async ({ currentUser, set }: any) => {
    try {
      // Get the user record
      const user = await db.select().from(users).where(eq(users.evm_address, currentUser.walletAddress)).get();
      if (!user) {
        set.status = 404;
        return { error: "User not found" };
      }

      // Get invoices where user is either creator or payer
      const invoicesAsCreator = await db.select().from(hyperliquidInvoices).where(eq(hyperliquidInvoices.creatorId, user.id));
      
      // For received invoices, we need to join with users to get creator's address
      const invoicesAsPayer = await db.select({
        id: hyperliquidInvoices.id,
        creatorId: hyperliquidInvoices.creatorId,
        payerAddress: hyperliquidInvoices.payerAddress,
        token: hyperliquidInvoices.token,
        amount: hyperliquidInvoices.amount,
        description: hyperliquidInvoices.description,
        status: hyperliquidInvoices.status,
        txHash: hyperliquidInvoices.txHash,
        createdAt: hyperliquidInvoices.createdAt,
        paidAt: hyperliquidInvoices.paidAt,
        expiresAt: hyperliquidInvoices.expiresAt,
        creatorAddress: users.evm_address,
      })
      .from(hyperliquidInvoices)
      .innerJoin(users, eq(hyperliquidInvoices.creatorId, users.id))
      .where(eq(hyperliquidInvoices.payerAddress, currentUser.walletAddress.toLowerCase()));

      return {
        created: invoicesAsCreator,
        received: invoicesAsPayer,
      };
    } catch (error) {
      console.error("Error fetching invoices:", error);
      set.status = 500;
      return { error: "Failed to fetch invoices" };
    }
  })

  // Confirm that an invoice has been paid
  .put("/invoices/:id/confirm",
    async ({ params, body, currentUser, set }: any) => {
      try {
        // Get the invoice
        const invoice = await db.select().from(hyperliquidInvoices).where(eq(hyperliquidInvoices.id, params.id)).get();
        if (!invoice) {
          set.status = 404;
          return { error: "Invoice not found" };
        }

        // Check if the current user is the payer
        if (invoice.payerAddress !== currentUser.walletAddress.toLowerCase()) {
          set.status = 403;
          return { error: "Only the payer can confirm payment" };
        }

        // Check if already paid
        if (invoice.status === "paid") {
          set.status = 400;
          return { error: "Invoice is already paid" };
        }

        // Verify the transaction on-chain
        console.log(`Verifying transaction: ${body.txHash}`);
        const txDetails = await infoClient.txDetails({ hash: body.txHash as `0x${string}` });

        if (!txDetails || txDetails.error) {
          set.status = 400;
          return { error: "Transaction not found or invalid" };
        }

        // Verify transaction details
        if (txDetails.user.toLowerCase() !== invoice.payerAddress) {
          set.status = 400;
          return { error: "Transaction sender does not match payer address" };
        }

        if (txDetails.action.type !== "spotSend") {
          set.status = 400;
          return { error: "Transaction is not a spot send" };
        }

        // Get creator's address for verification
        const creator = await db.select().from(users).where(eq(users.id, invoice.creatorId)).get();
        if (!creator || !creator.evm_address) {
          set.status = 500;
          return { error: "Creator not found or missing EVM address" };
        }

        // Type assertion for action properties since they're unknown
        const action = txDetails.action as any;
        
        if (action.destination?.toLowerCase() !== creator.evm_address.toLowerCase()) {
          set.status = 400;
          return { error: "Transaction destination does not match creator address" };
        }

        if (action.token !== invoice.token) {
          set.status = 400;
          return { error: "Transaction token does not match invoice token" };
        }

        // Verify amount - this is a simplified version, real implementation would need to handle decimals properly
        if (parseFloat(action.amount) !== parseFloat(invoice.amount)) {
          set.status = 400;
          return { error: `Transaction amount (${action.amount}) does not match invoice amount (${invoice.amount})` };
        }

        // Update the invoice
        const updatedInvoice = await db.update(hyperliquidInvoices)
          .set({
            status: "paid",
            txHash: body.txHash,
            paidAt: Date.now(),
          })
          .where(eq(hyperliquidInvoices.id, params.id))
          .returning()
          .get();

        return updatedInvoice;
      } catch (error) {
        console.error("Error confirming payment:", error);
        set.status = 500;
        return { error: "Failed to confirm payment" };
      }
    },
    {
      body: t.Object({
        txHash: t.String({ error: "Transaction hash is required" }),
      }),
    }
  )

  // Get user's spot balances
  .get("/spot-balances", async ({ currentUser, set }: any) => {
    try {
      console.log(`Fetching spot balances for ${currentUser.walletAddress}`);
      const spotState = await infoClient.spotClearinghouseState({ user: currentUser.walletAddress });
      
      if (!spotState) {
        return { balances: [] };
      }

      // Transform the balances to a more frontend-friendly format
      const balances = spotState.balances.map((balance) => ({
        coin: balance.coin,
        total: balance.total,
      }));

      return { balances };
    } catch (error) {
      console.error("Error fetching spot balances:", error);
      set.status = 500;
      return { error: "Failed to fetch spot balances" };
    }
  }); 