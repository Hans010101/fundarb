import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

if (window.location.protocol === "file:") {
  window.location.replace("https://fundarb-web.hans-pan007.workers.dev");
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
