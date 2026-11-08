import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installErrorCapture } from "./diagnostics";
import { AppRecovery } from "./RecoveryPage";
import { TipProvider } from "./Tip";
import { initializeAppearance } from "./appearance";
import "./assets/fonts/fonts.css";
import "./styles.css";
import "./appearance.css";
import "./palettes.css";
import "./conversation-header.css";

initializeAppearance();
installErrorCapture();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppRecovery>
      <TipProvider>
        <App />
      </TipProvider>
    </AppRecovery>
  </React.StrictMode>,
);
