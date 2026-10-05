import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { AuthProvider } from "./app/auth";
import { TalkLandingPage } from "./app/TalkLandingPage";
import { TalkAccessDenied } from "./app/TalkAccessDenied";
import { UpdateBanner } from "./app/update-banner";
import "./styles.css";

const { pathname } = window.location;

// Public preview routes
if (pathname === "/landing") {
  createRoot(document.getElementById("root")!).render(<TalkLandingPage />);
} else if (pathname === "/__preview_denied__") {
  createRoot(document.getElementById("root")!).render(
    <TalkAccessDenied decision={{ allowed: false, reason: "no_entitlement", product_key: "talk", status: "inactive" }} />
  );
} else if (pathname === "/__preview_error__") {
  createRoot(document.getElementById("root")!).render(
    <TalkAccessDenied error={new Error("Não foi possível verificar seu acesso. Tente novamente.")} />
  );
} else {
  createRoot(document.getElementById("root")!).render(
    <>
      {/* Outside the login so even a signed-out or broken screen learns that a new release is out. */}
      <UpdateBanner />
      <AuthProvider>
        <App />
      </AuthProvider>
    </>
  );
}
