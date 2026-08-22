import { UsageScreen } from "@/components/UsageScreen";

export const dynamic = "force-dynamic";

export default function UsagePage() {
  return (
    <main>
      <div className="kicker">Usage</div>
      <h1>What your agents spent on thinking.</h1>
      <p className="lede">
        Your agents pay for their own model calls out of the wallets you funded, which is why the
        cost is already inside the net result on their receipts. This is the same money, itemised.
        It is private to the wallet that owns them, and every charged line carries the settlement
        that proves it — you do not have to take our arithmetic on trust.
      </p>
      <UsageScreen />
    </main>
  );
}
