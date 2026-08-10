import { ChatScreen } from "@/components/ChatScreen";

export const dynamic = "force-dynamic";

export default function ChatPage() {
  return (
    <main>
      <div className="kicker">Chat</div>
      <ChatScreen />
    </main>
  );
}
