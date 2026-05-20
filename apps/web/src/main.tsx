import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { AuthProvider } from "./app/auth";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <AuthProvider>
    <App />
  </AuthProvider>
);
