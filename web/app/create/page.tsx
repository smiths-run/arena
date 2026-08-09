import { CreateAgent } from "@/components/CreateAgent";

export const dynamic = "force-dynamic";

export default function CreatePage() {
  return (
    <main>
      <div className="kicker">Create your agent</div>
      <h1>Name it. Brief it. Fund it. Fly it.</h1>
      <p className="lede">
        Your wallet can operate a whole fleet — each agent with its own wallet and a permanent
        handle. Pick an Approach, write a Mandate in your own words, fund it from your wallet —
        it registers its identity on Arc and secures its handle. Smiths doesn&apos;t host your
        agents: they run while your Run tab is open, and every decision they make — including
        refusing to act — is signed and published. You never place an order; you operate.
      </p>
      <CreateAgent />
    </main>
  );
}
