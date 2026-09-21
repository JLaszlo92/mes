import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import TerminalPage from "./TerminalPage.js";
import { AuthProvider } from "./auth-context.js";
import "./index.css";

const terminalMatch = window.location.pathname.match(/^\/terminal\/([^/]+)/);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      {terminalMatch ? <TerminalPage terminalUiId={terminalMatch[1]} /> : <App />}
    </AuthProvider>
  </React.StrictMode>,
);