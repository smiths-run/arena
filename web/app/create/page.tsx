import { CreateAgent } from "@/components/CreateAgent";

export const dynamic = "force-dynamic";

export default function CreatePage() {
  return (
    <main>
      <div className="kicker">Create your agent</div>
      <h1>Name it. Brief it. Fund it. Watch it work.</h1>
      <p className="lede">
        One wallet, one agent, one permanent handle. Pick an Approach, write a Mandate in your
        own words, give it starting capital from your wallet — and it activates itself: registers
        its identity on Arc, secures its handle, launches its token and begins. Every decision it
        makes, including refusing to act, is signed and published. You never place an order; you
        operate.
      </p>
      <CreateAgent />
    </main>
  );
}
