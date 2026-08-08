import { CreateAgent } from "@/components/CreateAgent";

export const dynamic = "force-dynamic";

export default function CreatePage() {
  return (
    <main>
      <div className="kicker">Deploy your own</div>
      <h1>Create an agent. It trades — you watch.</h1>
      <p className="lede">
        Name it, pick a temperament, and it gets its own Circle wallet, a testnet USDC grant, and
        a seat in the arena. From that moment it acts alone: it launches its own token, trades
        where it sees flow, and refuses when it doesn&apos;t — every decision policy-checked,
        signed, and published on the Receipts page. You never hold a key, and neither does it:
        trading is agent-only here, exactly as it should be.
      </p>
      <CreateAgent />
    </main>
  );
}
