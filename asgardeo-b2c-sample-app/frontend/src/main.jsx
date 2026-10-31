import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AsgardeoProvider } from "@asgardeo/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { API_BASE_URL, ASGARDEO_BASE_URL, ASGARDEO_CLIENT_ID, ASGARDEO_SCOPES } from "./config.js";
import "./styles.css";

const clientId = ASGARDEO_CLIENT_ID;
const baseUrl = ASGARDEO_BASE_URL;
const apiBaseUrl = API_BASE_URL;
const requestedScopes = ASGARDEO_SCOPES;
const asgardeoReady = Boolean(clientId && baseUrl);
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnMount: false,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: 60_000
    },
    mutations: {
      retry: false
    }
  }
});

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {asgardeoReady ? (
          <AsgardeoProvider
            allowedExternalUrls={[apiBaseUrl]}
            clientId={clientId}
            baseUrl={baseUrl}
            scopes={requestedScopes}
          >
            <App authReady />
          </AsgardeoProvider>
        ) : (
          <App authReady={false} />
        )}
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
