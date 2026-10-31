import { useEffect, useRef, useState } from "react";
import { useAsgardeo } from "@asgardeo/react";
import {
  ChevronDown,
  CircleUserRound,
  LogOut,
  ShieldCheck,
  Wallet
} from "lucide-react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { useApiAuth, useLocationQuery } from "./api-queries";
import {
  clearCDSCookies,
  createSignInConfigWithCDSTracker,
  ensureCDSProfile,
  initializeCDSFromCookie
} from "./cds-api";
import { TravelAssistantWidget } from "./components/TravelAssistantWidget";
import { BookingDetailsPageWithAuth } from "./pages/BookingDetailsPageWithAuth";
import { BookingsPageWithAuth } from "./pages/BookingsPageWithAuth";
import { BookingsUnavailable } from "./pages/BookingsUnavailable";
import { FlightDetailsPage } from "./pages/FlightDetailsPage";
import { HomePage, SignedInHomePage } from "./pages/HomePage";
import { PaymentPageWithAuth } from "./pages/PaymentPageWithAuth";
import { ProfilePageWithAuth } from "./pages/ProfilePageWithAuth";
import { ResultsPage, ResultsPageWithAuth } from "./pages/ResultsPage";
import { buildResultsPath, readCriteria } from "./utils/routes";
import { ASGARDEO_SIGN_UP_URL, SIWE_SIGN_IN_CONNECTION, WALLET_SIGN_IN_CONNECTION } from "./config.js";
import { takeReturnPath } from "./step-up.js";
import wayfinderLogo from "./assets/wayfinder-logo.png";

// Self sign-up page: VITE_ASGARDEO_SIGN_UP_URL, or derived from the base URL
// (api.<domain>/t/<org> -> accounts.<domain>/t/<org>/accounts/register).
const SIGN_UP_URL = ASGARDEO_SIGN_UP_URL;

// More ways to sign in, each straight at its connection (fidp): a wallet
// presenting the Wayfinder member credential (OpenID4VP), Sign-In with Ethereum.
const EXTRA_SIGN_IN_OPTIONS = [
  { connection: WALLET_SIGN_IN_CONNECTION, label: "Sign in with wallet" },
  { connection: SIWE_SIGN_IN_CONNECTION, label: "Sign in with Ethereum" }
].filter((option) => option.connection);

function BrandLogo({ className = "" }) {
  return (
    <img
      className={`brand-logo${className ? ` ${className}` : ""}`}
      src={wayfinderLogo}
      alt="Wayfinder Travel logo"
    />
  );
}

function isFlightLandingPath(pathname) {
  return pathname === "/" || pathname === "/flights";
}

function AuthenticatedHeader({ authReady }) {
  if (!authReady) {
    return <SignedOutHeader disabled />;
  }

  return <LiveAuthHeader />;
}

function PrimaryNav({ authReady }) {
  if (!authReady) {
    return <PublicPrimaryNav />;
  }

  return <LivePrimaryNav />;
}

function PublicPrimaryNav() {
  return (
    <nav className="header-nav" aria-label="Primary navigation">
      <a href="/flights#search">Search</a>
      <a href="/flights#deals">Deals</a>
      <a href="/flights#faq">FAQ</a>
    </nav>
  );
}

function LivePrimaryNav() {
  const { isSignedIn } = useAsgardeo();

  if (isSignedIn) {
    return <span aria-hidden="true" />;
  }

  return <PublicPrimaryNav />;
}

function LiveAuthHeader() {
  const { isSignedIn, isLoading, signIn, signOut, user } = useAsgardeo();
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef(null);
  const firstName = user?.name?.givenName || "";
  const lastName = user?.name?.familyName || "";
  const fullName = `${firstName} ${lastName}`.trim();
  const email = user?.email || user?.mail || user?.username || user?.userName || "";
  const displayName = fullName || email || user?.sub || "";
  const isUserResolving = isSignedIn && (!user || !displayName);

  useEffect(() => {
    function handlePointerDown(event) {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target)) {
        setIsAccountMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, []);

  if (isUserResolving) {
    return (
      <div className="auth-cluster">
        <div className="user-chip user-chip--loading" role="status" aria-live="polite">
          <span className="user-chip-spinner" aria-hidden="true" />
          <span className="user-chip-name">Loading account...</span>
        </div>
      </div>
    );
  }

  if (isSignedIn) {
    return (
      <div className="auth-cluster account-menu-wrap" ref={accountMenuRef}>
        <button
          className="user-chip"
          type="button"
          aria-expanded={isAccountMenuOpen}
          aria-haspopup="menu"
          onClick={() => setIsAccountMenuOpen((current) => !current)}
        >
          <CircleUserRound className="user-chip-avatar" size={28} />
          <span className="user-chip-text">
            <span className="user-chip-name">{displayName}</span>
            {fullName && email && <span className="user-chip-email">{email}</span>}
          </span>
          <ChevronDown
            className={`user-chip-chevron ${isAccountMenuOpen ? "user-chip-chevron--open" : ""}`}
            size={18}
          />
        </button>
        {isAccountMenuOpen && (
          <div className="account-menu" role="menu">
            <Link className="account-menu-item" to="/profile" role="menuitem">
              <CircleUserRound size={18} />
              <span>Profile</span>
            </Link>
            <Link className="account-menu-item" to="/bookings" role="menuitem">
              <CircleUserRound size={18} />
              <span>My Bookings</span>
            </Link>
            <button
              className="account-menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                clearCDSCookies();
                signOut();
              }}
            >
              <LogOut size={18} />
              <span>Sign Out</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  async function startSignIn(extraParams = {}) {
    const signInConfig = await createSignInConfigWithCDSTracker();

    signIn({ ...signInConfig, ...extraParams });
  }

  return (
    <div className="auth-cluster account-menu-wrap" ref={accountMenuRef}>
      <button
        className="primary-button"
        type="button"
        disabled={isLoading}
        aria-expanded={EXTRA_SIGN_IN_OPTIONS.length ? isAccountMenuOpen : undefined}
        aria-haspopup={EXTRA_SIGN_IN_OPTIONS.length ? "menu" : undefined}
        onClick={() => {
          if (EXTRA_SIGN_IN_OPTIONS.length) {
            setIsAccountMenuOpen((current) => !current);

            return;
          }

          startSignIn();
        }}
      >
        Sign in
      </button>
      {isAccountMenuOpen && EXTRA_SIGN_IN_OPTIONS.length > 0 && (
        <div className="account-menu" role="menu">
          <button className="account-menu-item" type="button" role="menuitem" onClick={() => startSignIn()}>
            <CircleUserRound size={18} />
            <span>Sign in</span>
          </button>
          {EXTRA_SIGN_IN_OPTIONS.map((option) => (
            <button
              key={option.connection}
              className="account-menu-item"
              type="button"
              role="menuitem"
              onClick={() => startSignIn({ fidp: option.connection })}
            >
              <Wallet size={18} />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      )}
      <button
        className="cta-button"
        type="button"
        onClick={async () => {
          if (SIGN_UP_URL) {
            window.location.href = SIGN_UP_URL;

            return;
          }

          // No sign-up URL could be derived: the sign-in page offers sign-up.
          signIn(await createSignInConfigWithCDSTracker());
        }}
      >
        Sign up
      </button>
    </div>
  );
}

function SignedOutHeader({ disabled }) {
  return (
    <div className="auth-cluster">
      <button className="primary-button" type="button" disabled={disabled}>
        Sign in
      </button>
      <button className="cta-button" type="button" disabled={disabled}>
        Sign up
      </button>
    </div>
  );
}

function FooterLinks({ authReady }) {
  if (!authReady) {
    return <PublicFooterLinks />;
  }

  return <LiveFooterLinks />;
}

function PublicFooterLinks() {
  return (
    <nav className="footer-links" aria-label="Footer navigation">
      <a href="/flights#search">Search</a>
      <a href="/flights#deals">Deals</a>
      <a href="/flights#faq">FAQ</a>
    </nav>
  );
}

function LiveFooterLinks() {
  const { isSignedIn } = useAsgardeo();

  if (isSignedIn) {
    return null;
  }

  return <PublicFooterLinks />;
}

function SiteFooter({ authReady }) {
  return (
    <footer className="site-footer">
      <div>
        <Link className="brand footer-brand" to="/flights" aria-label="Wayfinder Travel home">
          <span className="brand-mark">
            <BrandLogo />
          </span>
          <span>Wayfinder</span>
        </Link>
        <p>Modern travel booking flows, secured with the Identity Platform.</p>
      </div>
      <FooterLinks authReady={authReady} />
    </footer>
  );
}

function FlightDetailsRoute({ auth, criteria }) {
  const { flightId = "" } = useParams();

  return <FlightDetailsPage auth={auth} criteria={criteria} flightId={flightId} />;
}

function LiveFlightDetailsRoute({ criteria }) {
  const auth = useApiAuth();

  return <FlightDetailsRoute auth={auth} criteria={criteria} />;
}

function PaymentRoute({ criteria }) {
  const { flightId = "" } = useParams();

  return <PaymentPageWithAuth criteria={criteria} flightId={flightId} />;
}

function BookingDetailsRoute() {
  const { bookingId = "" } = useParams();

  return <BookingDetailsPageWithAuth bookingId={bookingId} />;
}

function LandingRoute({ authReady, category, cdsProfileId, locations, onProfileRecreated, onSearch }) {
  if (authReady) {
    return (
      <SignedInHomePage
        category={category}
        cdsProfileId={cdsProfileId}
        locations={locations}
        onProfileRecreated={onProfileRecreated}
        onSearch={onSearch}
      />
    );
  }

  return <HomePage category={category} locations={locations} onSearch={onSearch} />;
}

/**
 * After a step-up re-authentication the SDK lands on the site root; go back to
 * the page that asked for it (payment, profile). Checked once per page load,
 * when the session is first ready: the page that starts a step-up has already
 * checked, so it never takes the path back before its redirect.
 */
function StepUpReturn() {
  const { isLoading, isSignedIn } = useAsgardeo();
  const navigate = useNavigate();
  const checkedRef = useRef(false);

  useEffect(() => {
    if (isLoading || !isSignedIn || checkedRef.current) {
      return;
    }

    checkedRef.current = true;

    const path = takeReturnPath();

    if (path) {
      navigate(path, { replace: true });
    }
  }, [isLoading, isSignedIn, navigate]);

  return null;
}

function LiveCDSProfileBootstrap({ cdsProfileId, onProfileCreated }) {
  const { isLoading, isSignedIn } = useAsgardeo();
  const location = useLocation();

  useEffect(() => {
    if (!isFlightLandingPath(location.pathname) || location.hash || cdsProfileId) {
      return;
    }

    if (isLoading || isSignedIn) {
      return;
    }

    let isCurrent = true;

    async function createCDSProfileOnMount() {
      try {
        const profile = await ensureCDSProfile({});
        const createdProfileId = profile?.profile_id || profile?.id;

        if (isCurrent && createdProfileId) {
          onProfileCreated(createdProfileId);
        }
      } catch (error) {
        console.warn("Failed to create CDS profile:", error.message);
      }
    }

    createCDSProfileOnMount();

    return () => {
      isCurrent = false;
    };
  }, [cdsProfileId, isLoading, isSignedIn, location.hash, location.pathname, onProfileCreated]);

  return null;
}

function GuestCDSProfileBootstrap({ cdsProfileId, onProfileCreated }) {
  const location = useLocation();

  useEffect(() => {
    if (!isFlightLandingPath(location.pathname) || location.hash || cdsProfileId) {
      return;
    }

    let isCurrent = true;

    async function createCDSProfileOnMount() {
      try {
        const profile = await ensureCDSProfile({});
        const createdProfileId = profile?.profile_id || profile?.id;

        if (isCurrent && createdProfileId) {
          onProfileCreated(createdProfileId);
        }
      } catch (error) {
        console.warn("Failed to create CDS profile:", error.message);
      }
    }

    createCDSProfileOnMount();

    return () => {
      isCurrent = false;
    };
  }, [cdsProfileId, location.hash, location.pathname, onProfileCreated]);

  return null;
}

function getFallbackLocations() {
  return {
    flights: [
      { name: "Colombo", type: "city" },
      { name: "Singapore", type: "city" },
      { name: "Tokyo", type: "city" },
      { name: "London", type: "city" },
      { name: "Dubai", type: "city" }
    ],
    hotels: [
      { name: "Singapore Marina", type: "area" },
      { name: "Tokyo Shibuya", type: "area" },
      { name: "London Kings Cross", type: "area" }
    ],
    trips: [
      { name: "Singapore", type: "destination" },
      { name: "Tokyo", type: "destination" },
      { name: "Dubai", type: "destination" }
    ]
  };
}

function LocationsLoader({ auth, isReady = true, onLocationsLoaded }) {
  const flightLocationsQuery = useLocationQuery("flights", {
    auth,
    enabled: isReady
  });
  const hotelLocationsQuery = useLocationQuery("hotels", {
    auth,
    enabled: isReady
  });
  const tripLocationsQuery = useLocationQuery("trips", {
    auth,
    enabled: isReady
  });

  useEffect(() => {
    if (!isReady || flightLocationsQuery.isLoading) {
      return;
    }

    const fallbackLocations = getFallbackLocations();
    const nextLocations = {
      flights: flightLocationsQuery.data || fallbackLocations.flights,
      hotels: hotelLocationsQuery.data || fallbackLocations.hotels,
      trips: tripLocationsQuery.data || fallbackLocations.trips
    };

    onLocationsLoaded(nextLocations);
  }, [
    flightLocationsQuery.data,
    flightLocationsQuery.isLoading,
    hotelLocationsQuery.data,
    isReady,
    onLocationsLoaded,
    tripLocationsQuery.data
  ]);

  return null;
}

function LiveLocationsLoader({ onLocationsLoaded }) {
  const auth = useApiAuth();

  return (
    <LocationsLoader
      auth={auth}
      isReady={!auth.isLoading}
      onLocationsLoaded={onLocationsLoaded}
    />
  );
}

function PublicLocationsLoader({ onLocationsLoaded }) {
  return (
    <LocationsLoader
      onLocationsLoaded={onLocationsLoaded}
    />
  );
}

function AppRoutes({ authReady, cdsProfileId, criteria, locations, onProfileRecreated, onSearch }) {
  const flightLandingElement = (
    <LandingRoute
      authReady={authReady}
      category="flights"
      cdsProfileId={cdsProfileId}
      locations={locations}
      onProfileRecreated={onProfileRecreated}
      onSearch={onSearch}
    />
  );

  return (
    <Routes>
      <Route path="/" element={flightLandingElement} />
      <Route path="/flights" element={flightLandingElement} />
      <Route
        path="/hotels"
        element={
          <LandingRoute
            authReady={authReady}
            category="hotels"
            cdsProfileId={cdsProfileId}
            locations={locations}
            onProfileRecreated={onProfileRecreated}
            onSearch={onSearch}
          />
        }
      />
      <Route
        path="/trips"
        element={
          <LandingRoute
            authReady={authReady}
            category="trips"
            cdsProfileId={cdsProfileId}
            locations={locations}
            onProfileRecreated={onProfileRecreated}
            onSearch={onSearch}
          />
        }
      />
      <Route
        path="/results"
        element={
          authReady ? (
            <ResultsPageWithAuth
              cdsProfileId={cdsProfileId}
              criteria={criteria}
              locations={locations}
              onProfileRecreated={onProfileRecreated}
              onSearch={onSearch}
            />
          ) : (
            <ResultsPage
              cdsProfileId={cdsProfileId}
              criteria={criteria}
              locations={locations}
              onProfileRecreated={onProfileRecreated}
              onSearch={onSearch}
            />
          )
        }
      />
      <Route
        path="/flights/:flightId"
        element={
          authReady ? (
            <LiveFlightDetailsRoute criteria={criteria} />
          ) : (
            <FlightDetailsRoute criteria={criteria} />
          )
        }
      />
      <Route
        path="/payment/flight/:flightId"
        element={authReady ? <PaymentRoute criteria={criteria} /> : <BookingsUnavailable />}
      />
      <Route
        path="/bookings/:bookingId"
        element={authReady ? <BookingDetailsRoute /> : <BookingsUnavailable />}
      />
      <Route
        path="/bookings"
        element={authReady ? <BookingsPageWithAuth /> : <BookingsUnavailable />}
      />
      <Route
        path="/profile"
        element={authReady ? <ProfilePageWithAuth /> : <BookingsUnavailable />}
      />
      <Route path="*" element={<Navigate to="/flights" replace />} />
    </Routes>
  );
}

function App({ authReady }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [cdsProfileId, setCdsProfileId] = useState(() => initializeCDSFromCookie() || null);
  const [locations, setLocations] = useState({
    flights: [],
    hotels: [],
    trips: []
  });

  function handleSearch(searchParams) {
    navigate(buildResultsPath(searchParams));
  }

  const criteria = readCriteria(location.search);

  return (
    <div className="app-shell">
      <header className="site-header">
        <Link className="brand" to="/flights" aria-label="Wayfinder Travel home">
          <span className="brand-mark">
            <BrandLogo />
          </span>
          <span>Wayfinder</span>
        </Link>
        <PrimaryNav authReady={authReady} />
        <AuthenticatedHeader authReady={authReady} />
      </header>

      {!authReady && (
        <div className="setup-banner" role="status">
          <ShieldCheck size={18} />
          Add `VITE_ASGARDEO_CLIENT_ID` and `VITE_ASGARDEO_BASE_URL` to enable live
          Identity Platform sign in, sign up, and sign out.
        </div>
      )}

      {authReady ? (
        <>
          <StepUpReturn />
          <LiveLocationsLoader onLocationsLoaded={setLocations} />
          <LiveCDSProfileBootstrap cdsProfileId={cdsProfileId} onProfileCreated={setCdsProfileId} />
        </>
      ) : (
        <>
          <PublicLocationsLoader onLocationsLoaded={setLocations} />
          <GuestCDSProfileBootstrap cdsProfileId={cdsProfileId} onProfileCreated={setCdsProfileId} />
        </>
      )}

      <AppRoutes
        authReady={authReady}
        cdsProfileId={cdsProfileId}
        criteria={criteria}
        locations={locations}
        onProfileRecreated={setCdsProfileId}
        onSearch={handleSearch}
      />
      <TravelAssistantWidget />
      <SiteFooter authReady={authReady} />
    </div>
  );
}

export default App;
