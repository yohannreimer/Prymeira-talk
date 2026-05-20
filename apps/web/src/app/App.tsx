import { InboxPage } from "../features/inbox/InboxPage";
import { AuthGate } from "./auth";

export function App() {
  return (
    <AuthGate>
      <InboxPage />
    </AuthGate>
  );
}
