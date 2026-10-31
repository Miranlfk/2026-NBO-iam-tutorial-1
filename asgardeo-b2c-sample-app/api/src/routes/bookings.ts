import { randomUUID } from "node:crypto";
import { getRequestUserHint, getUserKey, isAuthRequired, resolveUser } from "../auth.js";
import {
  cancelBookedFlight,
  createBookingRecord,
  findDuplicateBooking,
  getBookedFlightById,
  listBookedFlights,
  UnknownBookingItemError,
  updateBookedFlightPrice
} from "../db.js";
import {
  asyncHandler,
  generateBookingReference,
  readJsonBody,
  sendJson
} from "../utils.js";

function getBookingOwner(request, resolvedUser, bodyUser = {}) {
  if (isAuthRequired()) {
    // The verified access token decides whose booking this is; headers and
    // body fields are ignored.
    const username = getUserKey(resolvedUser);

    return {
      id: username,
      username,
      email: resolvedUser.email,
      givenName: resolvedUser.givenName,
      familyName: resolvedUser.familyName
    };
  }

  const requestUser = getRequestUserHint(request) || {};
  const username =
    requestUser.username ||
    bodyUser.username ||
    bodyUser.email ||
    bodyUser.id ||
    resolvedUser.username ||
    resolvedUser.email ||
    resolvedUser.id;

  return {
    id: username,
    username,
    email: requestUser.email || bodyUser.email || resolvedUser.email,
    givenName: resolvedUser.givenName,
    familyName: resolvedUser.familyName
  };
}

async function getBookingUsername(request, body = {}) {
  const resolvedUser = request.authenticatedUser || await resolveUser(request);
  const bodyUser = body.user && typeof body.user === "object" ? body.user : body;

  return getBookingOwner(request, resolvedUser, bodyUser).username;
}

async function handleBooking(request) {
  const body = await readJsonBody(request);
  const resolvedUser = request.authenticatedUser || await resolveUser(request);
  const bodyUser = body.user && typeof body.user === "object" ? body.user : {};
  const user = getBookingOwner(request, resolvedUser, bodyUser);
  const itemType = body.type;
  const itemId = typeof body.itemId === "string" ? body.itemId.trim() : body.itemId;
  const travelers = Number(body.travelers || 1);
  const username = user.username || user.email || user.id;

  if (!["flight", "hotel", "trip"].includes(itemType)) {
    return {
      statusCode: 400,
      body: { error: "type must be one of: flight, hotel, trip" }
    };
  }

  if (typeof itemId !== "string" || !itemId.trim()) {
    return {
      statusCode: 400,
      body: { error: "itemId is required" }
    };
  }

  if (!Number.isInteger(travelers) || travelers < 1 || travelers > 9) {
    return {
      statusCode: 400,
      body: { error: "travelers must be an integer between 1 and 9" }
    };
  }

  const duplicateBooking = findDuplicateBooking({
    username,
    type: itemType,
    itemId
  });

  if (duplicateBooking) {
    return {
      statusCode: 409,
      body: { error: "This booking already exists." }
    };
  }

  let booking;

  try {
    booking = createBookingRecord({
      id: `booking-${randomUUID()}`,
      bookingReference: generateBookingReference(),
      user,
      type: itemType,
      itemId,
      travelers,
      status: "confirmed",
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    if (error instanceof UnknownBookingItemError) {
      return {
        statusCode: 400,
        body: { error: error.message }
      };
    }

    throw error;
  }

  return {
    statusCode: 201,
    body: booking
  };
}

async function handleBookingPriceUpdate(request, bookingId) {
  const body = await readJsonBody(request);
  const price = Number(body.price);
  const username = await getBookingUsername(request, body);

  if (!Number.isFinite(price) || price <= 0) {
    return {
      statusCode: 400,
      body: { error: "price must be a positive number" }
    };
  }

  const booking = updateBookedFlightPrice({
    bookingId,
    username,
    price
  });

  if (!booking) {
    return {
      statusCode: 404,
      body: { error: "Flight booking not found for username" }
    };
  }

  return {
    statusCode: 200,
    body: { data: booking }
  };
}

async function handleBookingCancel(request, bookingId) {
  const body = await readJsonBody(request);
  const username = await getBookingUsername(request, body);
  const booking = cancelBookedFlight({
    bookingId,
    username,
    disableDealAlerts: body.preserveDealAlerts !== true
  });

  if (!booking) {
    return {
      statusCode: 404,
      body: { error: "Flight booking not found for username" }
    };
  }

  return {
    statusCode: 200,
    body: { data: booking }
  };
}

export function registerBookingRoutes(app) {
  app.get("/api/bookings/flights", asyncHandler(async (request: any, response) => {
    const username = await getBookingUsername(request);

    sendJson(response, 200, {
      data: listBookedFlights(username)
    });
  }));

  app.get("/api/bookings/flights/:bookingId", (request: any, response) => {
    const booking = getBookedFlightById(request.params.bookingId);

    // With API_REQUIRE_AUTH=true only the owner may read it; someone else's
    // booking is reported as not found rather than forbidden.
    if (!booking || (isAuthRequired() && booking.username !== getUserKey(request.authenticatedUser))) {
      return sendJson(response, 404, { error: "Flight booking not found" });
    }

    return sendJson(response, 200, { data: booking });
  });

  app.post("/api/bookings", asyncHandler(async (request, response) => {
    const result = await handleBooking(request);

    sendJson(response, result.statusCode, result.body);
  }));

  app.patch("/api/bookings/:bookingId/price", asyncHandler(async (request, response) => {
    const result = await handleBookingPriceUpdate(request, request.params.bookingId);

    sendJson(response, result.statusCode, result.body);
  }));

  app.patch("/api/bookings/:bookingId/cancel", asyncHandler(async (request, response) => {
    const result = await handleBookingCancel(request, request.params.bookingId);

    sendJson(response, result.statusCode, result.body);
  }));
}
