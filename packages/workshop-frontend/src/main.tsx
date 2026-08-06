import { StrictMode, useState, useEffect, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { RpcStub } from 'capnweb'
import { PublicApi, ServerConfig } from '@gadgets/workshop-shared/api'
import { RpcContext } from './RpcContext'
import { ServerConfigContext, ServerConfigErrorContext } from './ServerConfigContext'
import { ThemeProvider } from './ThemeContext'
import { createRouter } from './router'
import AnnouncementBanner from './components/AnnouncementBanner'
import { applyAccentColor, applyStoredThemeMode } from './theme'
import './styles.css'
import FrontendErrorBoundary from './FrontendErrorBoundary'
import { installWorkshopErrorReporting, reportIssue } from './errorReporting'
import { applySiteFavicon, cacheBustSiteLogoUrl } from './siteLogoUtils'
import { getConnectionSnapshot, subscribeConnection } from './connection'

// ---------------------------------------------------------------------------
// Dev auto-login: if VITE_DEV_AUTO_LOGIN=true, automatically create/login
// with the dev account before React renders, so you never see the login page.
// ---------------------------------------------------------------------------
async function devAutoLogin(stub: RpcStub<PublicApi>): Promise<void> {
  if (import.meta.env.VITE_DEV_AUTO_LOGIN !== 'true') return
  if (localStorage.getItem('authToken')) return  // already logged in

  const username = import.meta.env.VITE_DEV_USERNAME ?? 'dev'
  const password = import.meta.env.VITE_DEV_PASSWORD ?? 'devpassword'

  // Derive the passwordHash the same way the app does (argon2id via hashPassword),
  // but here we use the same SERVICE_SALT + SHA-256 shortcut that wrangler dev accepts
  // in local mode. We import hashPassword from the existing util.
  const { hashPassword } = await import('./passwordHash')
  const passwordHash = await hashPassword(username, password)

  // Try createAccount first — works on a fresh backend. Returns null if already exists.
  let token = await stub.createAccount(username, username, passwordHash)

  // If null, account already exists — just log in.
  if (!token) {
    token = await stub.login(username, passwordHash)
  }

  if (token) {
    localStorage.setItem('authToken', token)
  }
}

installWorkshopErrorReporting()

const router = createRouter()
applyStoredThemeMode()

function AppWithConnection() {
  const rpcState = useSyncExternalStore(subscribeConnection, getConnectionSnapshot)
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [serverConfigError, setServerConfigError] = useState(false);

  // Fetch deployment config once the (re)connected stub is available. Re-fetch on reconnect so a
  // server restart with changed config is picked up.
  useEffect(() => {
    let cancelled = false;
    setServerConfigError(false);
    rpcState.stub.getServerConfig()
      .then((cfg) => {
        if (!cancelled) {
          setServerConfig(cfg.siteLogo ? {
            ...cfg,
            siteLogo: { url: cacheBustSiteLogoUrl(cfg.siteLogo.url) },
          } : cfg);
        }
      })
      .catch(() => { if (!cancelled) setServerConfigError(true); });
    return () => { cancelled = true; };
  }, [rpcState.stub]);

  // Apply the deployment's admin-chosen accent color (overrides brand CSS vars at runtime).
  useEffect(() => {
    applyAccentColor(serverConfig?.accentColor ?? '');
  }, [serverConfig?.accentColor]);

  useEffect(() => {
    return applySiteFavicon(serverConfig?.siteLogo?.url);
  }, [serverConfig]);

  return (
    <ThemeProvider>
      <RpcContext.Provider value={rpcState}>
        <ServerConfigErrorContext.Provider value={serverConfigError}>
          <ServerConfigContext.Provider value={serverConfig}>
            <AnnouncementBanner />
            <RouterProvider router={router} />
          </ServerConfigContext.Provider>
        </ServerConfigErrorContext.Provider>
      </RpcContext.Provider>
    </ThemeProvider>
  );
}

const root = createRoot(document.getElementById('root')!, {
  onUncaughtError: (error) => reportIssue('workshop.react-root', error, {
    handled: false, severity: 'fatal', captureMechanism: 'react',
  }),
})

// Kick off dev auto-login in the background. If it completes before
// useAuth checks the token, the user skips the login page. If the backend
// is unreachable, the app still renders immediately (showing a connection
// banner or login page) instead of hanging on a blank screen.
devAutoLogin(getConnectionSnapshot().stub).catch(() => {})

root.render(
  <StrictMode>
    <FrontendErrorBoundary>
      <AppWithConnection />
    </FrontendErrorBoundary>
  </StrictMode>
)
