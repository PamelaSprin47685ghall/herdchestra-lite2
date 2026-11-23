import "@incremark/theme/styles.css";
import { createRoot } from "react-dom/client";
import { AppShell } from "./components/AppShell";

const root = document.getElementById("root");
if (root) createRoot(root).render(<AppShell />);
