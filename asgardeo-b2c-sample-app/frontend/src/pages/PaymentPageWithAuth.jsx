import { useState } from "react";
import { useAsgardeo } from "@asgardeo/react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { ChevronLeft, CreditCard, Eye, EyeOff, ShieldCheck } from "lucide-react";
import {
  apiQueryKeys,
  useApiAuth,
  useCreateBookingMutation,
  useFlightQuery
} from "../api-queries";
import { getBookedFlights } from "../api";
import { createSignInConfigWithCDSTracker } from "../cds-api";
import { HIGH_VALUE_FARE_LIMIT, STEP_UP_ACR_HIGH_VALUE } from "../config.js";
import { startStepUp, useAuthenticationContext } from "../step-up.js";
import { formatPrice, isActiveBooking, isSameFlight } from "../utils/bookings";
import { buildFlightDetailsPath } from "../utils/routes";

export function PaymentPageWithAuth({ criteria, flightId }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isSignedIn, signIn, user } = useAsgardeo();
  const auth = useApiAuth();
  const flightQuery = useFlightQuery(flightId, { auth });
  const createBookingMutation = useCreateBookingMutation(auth);
  const flight = flightQuery.data;
  const isLoading = flightQuery.isLoading;
  const [paymentState, setPaymentState] = useState("idle");
  const [isCvcVisible, setIsCvcVisible] = useState(false);
  const [actionError, setActionError] = useState("");
  const error = actionError || flightQuery.error?.message || "";
  const username = user?.userName || user?.username || user?.email || user?.sub || "";
  const { acr } = useAuthenticationContext();
  const travelerCount = Number.parseInt(criteria.travelers, 10) || 1;
  // A fare over the limit is paid only after a high-value re-authentication;
  // the login flow decides what that takes (an external policy, then TOTP).
  const needsStepUp = Boolean(flight) && HIGH_VALUE_FARE_LIMIT > 0 && Number(flight.price) > HIGH_VALUE_FARE_LIMIT
    && acr !== STEP_UP_ACR_HIGH_VALUE;

  async function handlePayment() {
    if (!flight) {
      return;
    }

    setPaymentState("paying");
    setActionError("");

    try {
      const booking = await createBookingMutation.mutateAsync({
        type: "flight",
        itemId: flight.id,
        travelers: travelerCount,
        user: {
          id: username,
          username,
          email: user?.email || user?.mail
        }
      });

      window.dispatchEvent(new CustomEvent("wayfinder:deal-alert-consent", {
        detail: {
          bookingId: booking.id,
          username: username || booking.username,
          routeFrom: flight.from,
          routeTo: flight.to,
          currentPrice: flight.price,
          currentStops: flight.stops,
          cabin: flight.cabin
        }
      }));
      navigate(`/bookings/${encodeURIComponent(booking.id)}`);
    } catch (requestError) {
      try {
        if (requestError.message.includes("already exists")) {
          const bookings = await queryClient.fetchQuery({
            queryKey: apiQueryKeys.bookedFlights(auth.userKey),
            queryFn: () => getBookedFlights(auth)
          });
          const existingBooking = bookings.find((booking) => (
            isActiveBooking(booking) && isSameFlight(flight, booking.flight)
          ));

          if (existingBooking) {
            navigate(`/bookings/${encodeURIComponent(existingBooking.id)}`);
            return;
          }
        }
      } catch {
        // Keep the original payment error visible.
      }

      setPaymentState("idle");
      setActionError(requestError.message);
    }
  }

  if (!isSignedIn) {
    return (
      <main className="bookings-page">
        <section className="management-empty">
          <div>
            <p className="eyebrow">Payment</p>
            <h1>Sign in to complete payment.</h1>
            <p>Your flight will be booked only after payment is completed.</p>
          </div>
          <button
            className="dashboard-action dashboard-action--secondary"
            type="button"
            onClick={async () => {
              const signInConfig = await createSignInConfigWithCDSTracker();
              signIn(signInConfig);
            }}
          >
            Sign in
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="bookings-page">
      <section className="management-header">
        <div>
          <Link className="back-link" to={buildFlightDetailsPath(flightId, criteria)}>
            <ChevronLeft size={18} />
            Back to flight
          </Link>
          <p className="eyebrow">Payment</p>
          <h1>Complete payment</h1>
          <p>{flight ? `${flight.from} to ${flight.to} · ${flight.airline}` : "Preparing checkout"}</p>
        </div>
      </section>

      {error && (
        <div className="api-status api-status--error" role="status">
          {error}
        </div>
      )}

      {isLoading && <p className="empty-state management-message">Loading payment details...</p>}

      {!isLoading && flight && (
        <section className="payment-panel" aria-label="Payment details">
          <div className="payment-form-card">
            <div className="booking-detail-topline">
              <span className="booking-status">Secure payment</span>
              <CreditCard size={22} />
            </div>
            <label className="payment-field">
              <span>Card number</span>
              <input readOnly value="4242 4242 4242 4242" aria-label="Card number" />
            </label>
            <div className="payment-field-grid">
              <label className="payment-field">
                <span>Expiry</span>
                <input readOnly value="12 / 30" aria-label="Expiry" />
              </label>
              <label className="payment-field">
                <span>CVC</span>
                <div className="payment-field-with-toggle">
                  <input readOnly type={isCvcVisible ? "text" : "password"} value="123" aria-label="CVC" />
                  <button
                    className="payment-field-toggle"
                    type="button"
                    aria-label={isCvcVisible ? "Hide CVC" : "Show CVC"}
                    aria-pressed={isCvcVisible}
                    onClick={() => setIsCvcVisible((current) => !current)}
                  >
                    {isCvcVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </label>
            </div>
            {needsStepUp && (
              <p className="payment-step-up-note" role="note">
                <ShieldCheck size={16} />
                <span>
                  Fares over {formatPrice(flight.currency, HIGH_VALUE_FARE_LIMIT)} need you to confirm it&apos;s you
                  before payment.
                </span>
              </p>
            )}
            <button
              className="search-button standalone-button"
              type="button"
              disabled={paymentState === "paying"}
              onClick={needsStepUp ? () => startStepUp(signIn, STEP_UP_ACR_HIGH_VALUE) : handlePayment}
            >
              {paymentState === "paying"
                ? "Processing..."
                : needsStepUp ? "Verify it's you and pay" : "Pay and confirm booking"}
            </button>
          </div>

          <aside className="booking-receipt-card" aria-label="Payment summary">
            <span>Total due</span>
            <strong>{formatPrice(flight.currency, flight.price)}</strong>
            <p>{criteria.travelers || "1 Adult, Economy"} · {flight.dates}</p>
          </aside>
        </section>
      )}
    </main>
  );
}
